"""Processing chains: an ordered list of modules on every channel, bus and the master.

A module is a dict like {"id": "m3k9x2", "type": "comp", "on": True, ...settings}.
Any type can appear any number of times, in any order (two compressors, EQ
after the compressor, ...). The order in the list is the order the sound
passes through them.

Channels: to stay fast with 48 channels, modules of the same type sitting at
the same position in different channels are processed together in one
vectorised call ("stages"); each module keeps its own state in a slot.
Buses and the master: each module is its own stereo processor (BusChain).
"""
import copy
import math
import random
import string

import numpy as np

from .dsp import (SUB, BW4_Q, DeEsser, Dynamics, FilterBank, _db, _tc, biquad, sosfilt_fast, strip_sos)
from .procs import (DynEQ, LookaheadLimiter, Multiband, Saturator, Transient, _shape, width_balance)
from .autotune import AutoTune

# type -> (label, short label, allowed on channels, allowed on buses/master)
TYPES = {
    "eq": ("EQ & filters", "EQ", True, True),
    "gate": ("Gate / expander", "GATE", True, True),
    "comp": ("Compressor", "COMP", True, True),
    "deess": ("De-esser", "DS", True, True),
    "dyneq": ("Dynamic EQ", "DYN", True, True),
    "trans": ("Transient shaper", "TR", True, True),
    "sat": ("Saturation", "SAT", True, True),
    "tune": ("Auto-tune", "TUNE", True, False),
    "mbc": ("Multiband compressor", "MB", False, True),
    "width": ("Width & balance", "WIDE", False, True),
    "limiter": ("Limiter", "LIM", False, True),
    "plugin": ("Plug-in", "PLUG", True, True),
}


def new_id():
    return "m" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(7))


def _bands_flat():
    return [
        {"type": "lowshelf", "freq": 100, "gain": 0, "q": 0.7, "on": True, "slope": 12},
        {"type": "bell", "freq": 400, "gain": 0, "q": 1.0, "on": True, "slope": 12},
        {"type": "bell", "freq": 2500, "gain": 0, "q": 1.0, "on": True, "slope": 12},
        {"type": "highshelf", "freq": 8000, "gain": 0, "q": 0.7, "on": True, "slope": 12},
    ]


DEFAULTS = {
    "eq": lambda: {"hpf": {"on": False, "freq": 80, "slope": 24}, "lpf": {"on": False, "freq": 16000, "slope": 12},
                   "bands": _bands_flat()},
    "gate": lambda: {"thr": -50, "range": 40, "att": 1, "rel": 120},
    "comp": lambda: {"thr": -18, "ratio": 3, "knee": 6, "att": 10, "rel": 150, "makeup": 0, "mix": 100, "range": 30, "sc": ""},
    "deess": lambda: {"freq": 6500, "thr": -28, "range": 8},
    "dyneq": lambda: {"sc": "", "bands": [
        {"on": True, "type": "bell", "freq": 250, "q": 1.2, "gain": 0, "thr": -24, "range": -3, "att": 10, "rel": 150},
        {"on": False, "type": "bell", "freq": 3500, "q": 2.0, "gain": 0, "thr": -26, "range": -3, "att": 3, "rel": 100}]},
    "trans": lambda: {"attack": 2, "sustain": 0},
    "sat": lambda: {"flavor": "tape", "drive": 3, "mix": 100},
    "tune": lambda: {"amount": 100, "speed": 40, "voice": "any", "scale": "song"},
    "mbc": lambda: {"x1": 180, "x2": 3500, "bands": [
        {"thr": -20, "ratio": 2, "att": 30, "rel": 250, "gain": 0, "range": 3},
        {"thr": -18, "ratio": 1.5, "att": 20, "rel": 200, "gain": 0, "range": 2},
        {"thr": -22, "ratio": 2, "att": 10, "rel": 150, "gain": 0, "range": 3}]},
    "width": lambda: {"width": 100.0, "balance": 0.0},
    "limiter": lambda: {"ceiling": -1.0, "threshold": 0, "gain": 0, "lookahead": 1.5, "release": 150, "truepeak": True},
    "plugin": lambda: {"path": "", "name": "Plug-in", "params": {}},
}


def module(kind, on=True, **settings):
    m = {"id": new_id(), "type": kind, "on": on}
    m.update(DEFAULTS[kind]())
    m.update(copy.deepcopy(settings))
    return m


def fresh_ids(chain):
    """Copy of a chain with new module ids (used when pasting / applying presets)."""
    out = copy.deepcopy(chain or [])
    for m in out:
        m["id"] = new_id()
    return out


# ---------------------------------------------------------------- legacy settings -> chain

LEGACY_CH_ORDER = ["eq", "tune", "gate", "comp", "deess", "dyneq", "trans", "sat"]
LEGACY_BUS_ORDER = ["eq", "comp", "sat", "dyneq", "mbc", "width", "limiter"]


def legacy_to_chain(s, bus=False, always=("eq",), order=None):
    """Build a chain from the older fixed-slot layout (or a preset written that way).
    Only processors that were switched on are kept, plus EQ."""
    chain = []
    seq = order or (LEGACY_BUS_ORDER if bus else LEGACY_CH_ORDER)
    for kind in seq:
        if kind == "eq":
            eq = s.get("eq") or {}
            hpf, lpf = s.get("hpf") or {}, s.get("lpf") or {}
            if not (eq or hpf or lpf) and "eq" not in always:
                continue
            m = module("eq", on=eq.get("on", True))
            if hpf:
                m["hpf"].update(hpf)
            if lpf:
                m["lpf"].update(lpf)
            if eq.get("bands"):
                m["bands"] = copy.deepcopy(eq["bands"])
                for b in m["bands"]:
                    b.setdefault("slope", 12)
                    b.setdefault("on", True)
            chain.append(m)
        elif kind == "width":
            w, bal = float(s.get("width", 100)), float(s.get("balance", 0))
            if "width" in always or abs(w - 100) > 0.5 or abs(bal) > 0.005:
                chain.append(module("width", width=w, balance=bal))
        else:
            d = s.get(kind)
            if isinstance(d, dict) and (d.get("on") or kind in always):
                settings = {k: v for k, v in d.items() if k not in ("on", "type")}
                if kind == "sat":
                    settings["flavor"] = d.get("type", "tape")
                chain.append(module(kind, on=bool(d.get("on")), **settings))
    for spec in s.get("inserts") or []:
        if spec.get("path"):
            chain.append(module("plugin", on=not spec.get("bypass"), path=spec["path"], name=spec.get("name", "Plug-in"),
                                params=dict(spec.get("params", {}))))
    return chain


def eq_strip(m):
    """An EQ module in the shape strip_sos() expects."""
    return {"hpf": m.get("hpf") or {}, "lpf": m.get("lpf") or {}, "eq": {"on": True, "bands": m.get("bands") or []}}


# ---------------------------------------------------------------- channel banks (vectorised per stage)

class _Bank:
    """Per-module state stored in slots, kept across recompiles by module id."""
    STATE = ()

    def __init__(self, fs):
        self.fs = fs
        self.ids = []
        self.slot = {}

    def assign(self, mods):
        old_slot = self.slot
        old = {k: getattr(self, k, np.zeros(0)) for k in self.STATE}
        n = len(mods)
        self.ids = [m["id"] for m in mods]
        self.slot = {mid: i for i, mid in enumerate(self.ids)}
        for k in self.STATE:
            arr = self.state_init(k, n)
            for mid, i in self.slot.items():
                j = old_slot.get(mid)
                if j is not None and j < len(old[k]):
                    arr[i] = old[k][j]
            setattr(self, k, arr)
        self.configure(mods)

    def state_init(self, k, n):
        return np.zeros(n)


class CompBank(_Bank):
    STATE = ("gr", "prev")

    def state_init(self, k, n):
        return np.ones(n) if k == "prev" else np.zeros(n)

    def configure(self, mods):
        f = lambda k, d: np.array([float(m.get(k, d)) for m in mods])
        self.thr, self.ratio = f("thr", -18), np.maximum(f("ratio", 3), 1.0)
        self.knee, self.make = np.maximum(f("knee", 6), 0.01), 10 ** (f("makeup", 0) / 20)
        self.att, self.rel = _tc(f("att", 10), self.fs), _tc(f("rel", 150), self.fs)
        self.mix, self.rng = np.clip(f("mix", 100) / 100, 0, 1), np.abs(f("range", 30))

    def process(self, x, s):
        nsub = max(x.shape[0] // SUB, 1)
        lvl = _db(np.abs(x[: nsub * SUB]).reshape(nsub, SUB, -1).max(axis=1))
        over, k, slope = lvl - self.thr[s], self.knee[s], 1 - 1 / self.ratio[s]
        tgt = np.where(over <= -k / 2, 0.0, np.where(over >= k / 2, over * slope, slope * (over + k / 2) ** 2 / (2 * k)))
        tgt = np.minimum(tgt, self.rng[s])
        red, self.gr[s] = Dynamics._smooth(tgt, self.gr[s], self.att[s], self.rel[s])
        lin = 10 ** (-red / 20) * self.make[s]
        mix = self.mix[s].astype(np.float32)
        if (mix < 0.999).any():
            dry = x.copy()
            self.prev[s] = Dynamics._apply(x, lin, self.prev[s])
            x *= mix
            x += dry * (1 - mix)
        else:
            self.prev[s] = Dynamics._apply(x, lin, self.prev[s])
        return x


class GateBank(_Bank):
    STATE = ("gr", "prev")

    def state_init(self, k, n):
        return np.ones(n) if k == "prev" else np.zeros(n)

    def configure(self, mods):
        f = lambda k, d: np.array([float(m.get(k, d)) for m in mods])
        self.thr, self.rng = f("thr", -50), np.abs(f("range", 40))
        self.att, self.rel = _tc(f("att", 1), self.fs), _tc(f("rel", 120), self.fs)

    def process(self, x, s):
        nsub = max(x.shape[0] // SUB, 1)
        lvl = _db(np.abs(x[: nsub * SUB]).reshape(nsub, SUB, -1).max(axis=1))
        tgt = np.where(lvl < self.thr[s], self.rng[s], 0.0)
        red, self.gr[s] = Dynamics._smooth(tgt, self.gr[s], self.rel[s], self.att[s])  # opening uses attack
        self.prev[s] = Dynamics._apply(x, 10 ** (-red / 20), self.prev[s])
        return x


class DeEssBank(_Bank):
    STATE = ("gr", "prev")

    def state_init(self, k, n):
        return np.ones(n) if k == "prev" else np.zeros(n)

    def configure(self, mods):
        old = getattr(self, "side", {})
        self.thr = np.array([float(m.get("thr", -28)) for m in mods])
        self.rng = np.array([float(m.get("range", 8)) for m in mods])
        self.side = {}
        for m in mods:
            f = float(m.get("freq", 6500))
            sos = np.vstack([biquad("hp", f, 0, BW4_Q[0], self.fs), biquad("hp", f, 0, BW4_Q[1], self.fs)])
            prev = old.get(m["id"])
            self.side[m["id"]] = (sos, prev[1] if prev is not None else np.zeros((2, 2)))
        self.att, self.rel = _tc(0.5, self.fs), _tc(60, self.fs)

    def process(self, x, s):
        nsub = max(x.shape[0] // SUB, 1)
        lvl = np.empty((nsub, x.shape[1]))
        for j, slot in enumerate(s):
            sos, zi = self.side[self.ids[slot]]
            y = sosfilt_fast(sos, x[:, j], zi)
            lvl[:, j] = _db(np.abs(y[: nsub * SUB]).reshape(nsub, SUB).max(axis=1))
        tgt = np.minimum(np.maximum(lvl - self.thr[s], 0.0) * 0.75, self.rng[s])
        red, self.gr[s] = Dynamics._smooth(tgt, self.gr[s], self.att, self.rel)
        self.prev[s] = Dynamics._apply(x, 10 ** (-red / 20), self.prev[s])
        return x


class TransBank(_Bank):
    STATE = ("fast", "slow", "prev")

    def state_init(self, k, n):
        return np.ones(n) if k == "prev" else np.full(n, -120.0)

    def configure(self, mods):
        self.att = np.array([float(m.get("attack", 0)) for m in mods])
        self.sus = np.array([float(m.get("sustain", 0)) for m in mods])
        fs = self.fs
        self.c = (_tc(0.5, fs), _tc(30, fs), _tc(25, fs), _tc(250, fs))

    def process(self, x, s):
        nsub = max(x.shape[0] // SUB, 1)
        lvl = _db(np.abs(x[: nsub * SUB]).reshape(nsub, SUB, -1).max(axis=1))
        fa, fr, sa, sr = self.c
        f, self.fast[s] = Dynamics._smooth(lvl, self.fast[s], fr, fa)
        sl, self.slow[s] = Dynamics._smooth(lvl, self.slow[s], sr, sa)
        diff = f - sl
        gain_db = self.att[s] * np.clip(diff / 9.0, 0, 1) + self.sus[s] * np.clip(-diff / 9.0, 0, 1)
        self.prev[s] = Dynamics._apply(x, 10 ** (gain_db / 20), self.prev[s])
        return x


class SatBank(_Bank):
    def configure(self, mods):
        self.kind = [m.get("flavor", "tape") for m in mods]
        self.g = np.array([10 ** (max(float(m.get("drive", 3)), 0.0) / 20) for m in mods], np.float32)
        self.mix = np.array([float(m.get("mix", 100)) / 100 for m in mods], np.float32)

    def process(self, x, s):
        for kind in set(self.kind[i] for i in s):
            cols = [j for j, i in enumerate(s) if self.kind[i] == kind]
            idx = s[cols]
            dry = x[:, cols]
            wet = _shape(dry, kind, self.g[idx]).astype(np.float32)
            x[:, cols] = dry * (1 - self.mix[idx]) + wet * self.mix[idx]
        return x


class EqBank(_Bank):
    def configure(self, mods):
        old = getattr(self, "flt", {})
        self.flt = {}
        for m in mods:
            sos, act = strip_sos(eq_strip(m), self.fs)
            prev = old.get(m["id"])
            zi = prev[1] if prev is not None and act and prev[1] is not None and prev[1].shape[0] == sos.shape[0] else (
                np.zeros((sos.shape[0], 2)) if act else None)
            self.flt[m["id"]] = (sos if act else None, zi)

    def process(self, x, s):
        for j, slot in enumerate(s):
            sos, zi = self.flt[self.ids[slot]]
            if sos is not None:
                x[:, j] = sosfilt_fast(sos, x[:, j], zi)
        return x


BANKS = {"comp": CompBank, "gate": GateBank, "deess": DeEssBank, "trans": TransBank, "sat": SatBank, "eq": EqBank}
OBJECTS = ("dyneq", "tune", "plugin")


class ChannelChains:
    """Runs every channel's chain, grouped into vectorised stages."""

    def __init__(self, nch, fs, plugin_loader):
        self.nch, self.fs = nch, fs
        self.banks = {k: cls(fs) for k, cls in BANKS.items()}
        self.objs = {}             # module id -> DynEQ / AutoTune / Insert
        self.load_plugin = plugin_loader
        self.stages = []
        self.where = {}            # module id -> (type, channel)
        self.song = {}

    def compile(self, channels, song):
        self.song = song or {}
        per_type = {k: [] for k in BANKS}
        stages = []
        where = {}
        objs = {}
        for c, ch in enumerate(channels):
            for k, m in enumerate(ch.get("chain") or []):
                t = m.get("type")
                if t not in TYPES or not TYPES[t][2]:
                    continue
                where[m["id"]] = (t, c)
                if t in BANKS:
                    per_type[t].append(m)
                else:
                    objs[m["id"]] = self._object(m)
        for t, mods in per_type.items():
            self.banks[t].assign(mods)
        self.objs = objs
        self.where = where
        # stage k: modules sitting k-th in their channel, grouped by type
        maxlen = max((len(ch.get("chain") or []) for ch in channels), default=0)
        for k in range(maxlen):
            groups = {}
            for c, ch in enumerate(channels):
                chain = ch.get("chain") or []
                if k < len(chain):
                    m = chain[k]
                    t = m.get("type")
                    if not m.get("on", True) or t not in TYPES or not TYPES[t][2]:
                        continue
                    if t == "plugin" and (self.objs.get(m["id"]) is None or self.objs[m["id"]].failed):
                        continue
                    g = groups.setdefault(t, ([], []))
                    g[0].append(c)
                    g[1].append(self.banks[t].slot[m["id"]] if t in BANKS else m["id"])
            stages.append([(t, np.array(cols), (np.array(sl) if t in BANKS else sl)) for t, (cols, sl) in groups.items()])
        self.stages = stages

    def _object(self, m):
        t, mid = m["type"], m["id"]
        cur = self.objs.get(mid)
        if t == "dyneq":
            o = cur if isinstance(cur, DynEQ) else DynEQ(1, self.fs)
            o.set_params({**m, "on": True})
            return o
        if t == "tune":
            o = cur if isinstance(cur, AutoTune) else AutoTune(self.fs)
            o.set_params(m, self.song)
            return o
        if t == "plugin":
            return self.load_plugin(m)
        return None

    def process(self, x, dormant):
        for groups in self.stages:
            for t, cols, slots in groups:
                keep = ~dormant[cols]
                if not keep.any():
                    continue
                if not keep.all():
                    cols = cols[keep]
                    slots = slots[keep] if t in BANKS else [s for s, k in zip(slots, keep) if k]
                if t in BANKS:
                    sub = x[:, cols]
                    x[:, cols] = self.banks[t].process(sub, slots)
                else:
                    for c, mid in zip(cols, slots):
                        o = self.objs.get(mid)
                        if o is None:
                            continue
                        if t == "tune":
                            x[:, c] = o.process(x[:, c])
                        elif t == "dyneq":
                            x[:, c:c + 1] = o.process(x[:, c:c + 1].copy())
                        else:
                            x[:, c:c + 1] = o.process(x[:, c:c + 1], self.fs)
        return x

    # ---- meters
    def channel_gr(self, kind):
        """Max gain reduction per channel for one module type (comp / gate / deess)."""
        out = np.zeros(self.nch)
        bank = self.banks[kind]
        for mid, slot in bank.slot.items():
            c = self.where.get(mid, (None, None))[1]
            if c is not None:
                out[c] = max(out[c], float(bank.gr[slot]))
        return out

    def module_meters(self, chain):
        out = {}
        for m in chain or []:
            mid, t = m.get("id"), m.get("type")
            if t in ("comp", "gate", "deess") and mid in self.banks[t].slot:
                out[mid] = round(float(self.banks[t].gr[self.banks[t].slot[mid]]), 1)
            elif t == "dyneq" and mid in self.objs:
                out[mid] = [b.get("_live", 0) for b in self.objs[mid].bands]
            elif t == "tune" and mid in self.objs:
                out[mid] = self.objs[mid].readout()
        return out

    def tune_readouts(self):
        res = {}
        for mid, o in self.objs.items():
            if isinstance(o, AutoTune):
                r = o.readout()
                if r:
                    res[self.where[mid][1]] = r
        return res


# ---------------------------------------------------------------- bus / master chains (stereo, per module)

class _Width:
    def __init__(self):
        self.w, self.b = 100.0, 0.0

    def set(self, m):
        self.w, self.b = float(m.get("width", 100)), float(m.get("balance", 0))

    def process(self, x):
        return width_balance(x, self.w, self.b)


class BusChain:
    def __init__(self, fs, plugin_loader):
        self.fs = fs
        self.load_plugin = plugin_loader
        self.procs = {}   # module id -> processor
        self.order = []   # [(module, processor)]

    def set_params(self, chain, bypass_limiters=False):
        procs = {}
        order = []
        for m in chain or []:
            t = m.get("type")
            if t not in TYPES or not TYPES[t][3]:
                continue
            p = self._make(m, self.procs.get(m["id"]))
            procs[m["id"]] = p
            if m.get("on", True) and p is not None and not (bypass_limiters and t == "limiter"):
                order.append((m, p))
        self.procs, self.order = procs, order

    def _make(self, m, cur):
        t, fs = m["type"], self.fs
        on = {**m, "on": True}
        if t == "eq":
            p = cur if isinstance(cur, FilterBank) else FilterBank(2)
            sos, act = strip_sos(eq_strip(m), fs)
            p.set(0, sos, act)
            p.set(1, sos.copy() if act else None, act)
            return p
        if t in ("gate", "comp"):
            p = cur if isinstance(cur, Dynamics) else Dynamics(2, fs)
            p.set_params([{t: on}, {t: on}])
            return p
        if t == "deess":
            p = cur if isinstance(cur, DeEsser) else DeEsser(2, fs)
            p.set_params([{"deess": on}, {"deess": on}])
            return p
        if t == "trans":
            p = cur if isinstance(cur, Transient) else Transient(2, fs)
            p.set_params([{"trans": on}, {"trans": on}])
            return p
        if t == "sat":
            p = cur if isinstance(cur, Saturator) else Saturator(2)
            spec = {**on, "type": m.get("flavor", "tape")}
            p.set_params([{"sat": spec}, {"sat": spec}])
            return p
        if t == "dyneq":
            p = cur if isinstance(cur, DynEQ) else DynEQ(2, fs)
            p.set_params(on)
            return p
        if t == "mbc":
            p = cur if isinstance(cur, Multiband) else Multiband(fs)
            p.set_params(on)
            return p
        if t == "width":
            p = cur if isinstance(cur, _Width) else _Width()
            p.set(m)
            return p
        if t == "limiter":
            p = cur if isinstance(cur, LookaheadLimiter) else LookaheadLimiter(fs)
            p.set_params(on)
            return p
        if t == "plugin":
            return self.load_plugin(m)
        return None

    def process(self, x, sc_fn=None):
        """sc_fn(spec) returns the sidechain signal for a module's "sc" source (or None)."""
        for m, p in self.order:
            t = m["type"]
            if t == "eq" or t == "sat" or t == "trans" or t == "deess" or t == "gate" or t == "mbc":
                p.process(x)
            elif t == "comp" or t == "dyneq":
                det = sc_fn(m["sc"]) if (sc_fn and m.get("sc")) else None
                p.process(x, det)
            elif t == "width" or t == "limiter":
                p.process(x)
            elif t == "plugin":
                if not p.failed:
                    x[:] = p.process(x, self.fs)
        return x

    def meters(self):
        gr = lim = 0.0
        mbc, mods = None, {}
        for m, p in self.order:
            t = m["type"]
            if t == "comp":
                v = float(p.comp_gr.max())
                gr = max(gr, v)
                mods[m["id"]] = round(v, 1)
            elif t == "gate":
                mods[m["id"]] = round(float(p.gate_gr.max()), 1)
            elif t == "deess":
                mods[m["id"]] = round(float(p.gr.max()), 1)
            elif t == "limiter":
                lim = max(lim, p.gr)
                mods[m["id"]] = round(p.gr, 1)
            elif t == "mbc":
                mbc = p.gr
                mods[m["id"]] = p.gr
            elif t == "dyneq":
                mods[m["id"]] = [b.get("_live", 0) for b in p.bands]
        return gr, lim, mbc, mods

    def first(self, kind):
        for m, p in self.order:
            if m["type"] == kind:
                return p
        return None
