"""The mixing engine.

Signal flow (all routing is data in `state`):

  inputs (WING USB / virtual cables)
    -> channel strip: trim, phase, filters, EQ, gate, compressor, de-esser,
       dynamic EQ, transient shaper, saturation, inserts
    -> fader / pan -> destination bus           (sends -> FX returns)
  group buses (Lead Vocal, BGV, Drums, Bass, Guitars, Keys, Other)
    -> Music / Preaching / FX buses -> Broadcast bus -> Master -> stream out
  every bus: EQ, compressor (sidechain-able, parallel mix), saturation,
  dynamic EQ, multiband, width/balance, limiter, ducking, inserts, sends.
"""
import copy
import threading

import numpy as np

from . import dsp
from . import chain
from . import effects
from .inputs import parse_dev
from .procs import Ducker, ReverbFX, StereoDelay

try:
    import pedalboard as pb
except Exception:  # pragma: no cover - optional
    pb = None

QUIET = 1e-5     # -100 dBFS: a bus / FX / master block this quiet counts as silence
CH_QUIET = 1e-4  # -80 dBFS: channels this quiet skip their filters (their audio still passes)

COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"]
N_CABLES = 4

FX_TYPES = {
    "plate": {"predelay_ms": 25, "decay": 0.45, "size": 0.35, "damping": 0.35, "width": 100, "early": 0.3, "lowcut": 300, "highcut": 9000},
    "hall": {"predelay_ms": 40, "decay": 0.82, "size": 0.8, "damping": 0.5, "width": 100, "early": 0.25, "lowcut": 250, "highcut": 7000},
    "room": {"predelay_ms": 10, "decay": 0.6, "size": 0.55, "damping": 0.55, "width": 100, "early": 0.4, "lowcut": 200, "highcut": 8000},
    "delay": {"sync": True, "note": "1/8d", "time_ms": 375, "feedback": 0.3, "lowcut": 300, "highcut": 5000,
              "width": 100, "pingpong": True, "predelay_ms": 0},
    "chorus": {"rate_hz": 0.8, "depth": 0.25, "centre_delay_ms": 7, "feedback": 0.0},
    "phaser": {"rate_hz": 0.5, "depth": 0.5, "centre_frequency_hz": 1300, "feedback": 0.0},
    "doubler": {"semitones": 0.12, "delay_ms": 18},
}
FX_ALIASES = {"reverb": "hall"}

# id, name, kind, default destination, colour
DEFAULT_BUSES = [
    ("lead", "Lead Vocal", "vocal", "broadcast", "#e5484d"),
    ("bgv", "Backing Vocals", "vocal", "broadcast", "#f76b15"),
    ("drums", "Drums", "group", "music", "#46a758"),
    ("bass", "Bass", "group", "music", "#12a594"),
    ("gtr", "Guitars", "group", "music", "#0090ff"),
    ("keys", "Keys", "group", "music", "#6e56cf"),
    ("other", "Other Instruments", "group", "music", "#d6409f"),
    ("music", "Music", "music", "broadcast", "#2f9e8f"),
    ("speech", "Preaching", "speech", "broadcast", "#ffc53d"),
    ("fx", "FX Returns", "fx", "broadcast", "#5b8def"),
    ("broadcast", "Broadcast", "broadcast", "master", "#f76b15"),
]

OFF = {"on": False}


def _duck_default(src=""):
    return {"on": False, "src": src, "amount": 2.0, "thr": -30, "att": 15, "rel": 400, "ratio": 4}


LEGACY_KEYS = ("hpf", "lpf", "eq", "gate", "comp", "deess", "dyneq", "trans", "sat", "tune", "mbc", "limiter", "inserts",
               "drive")


def default_strip(i):
    return {
        "name": f"Ch {i + 1}", "color": COLORS[(i // 8) % len(COLORS)], "icon": "", "type": "",
        "input": f"in:{i}", "out": "music",
        "trim": 0.0, "phase": False,
        # processing, in order: add, remove, duplicate and reorder freely
        "chain": [chain.module("eq"), chain.module("comp", on=False)],
        "pan": 0.0, "fader": 0.0, "mute": False, "solo": False,
        "sends": [-90.0, -90.0, -90.0, -90.0],
    }


def default_bus(bid, name, kind, out, color):
    mods = [chain.module("eq"), chain.module("comp", on=False, thr=-14, ratio=2, att=30, rel=200)]
    if bid == "broadcast":
        mods.append(chain.module("limiter", ceiling=-1.0))
    return {
        "id": bid, "name": name, "kind": kind, "out": out, "color": color,
        "fader": 0.0, "mute": False,
        "chain": mods,
        "duck": _duck_default("bus:lead" if bid == "music" else ""),
        "sends": [-90.0, -90.0, -90.0, -90.0],
    }


def default_master():
    return {
        "id": "master", "name": "Master", "kind": "master", "out": "out", "color": "#e8e9eb",
        "fader": 0.0, "mute": False, "target": -14.0, "tp_max": -1.0,
        "chain": [chain.module("eq"), chain.module("comp", on=False, thr=-12, ratio=2, att=30, rel=200),
                  chain.module("sat", on=False, drive=1.5, mix=50), chain.module("mbc", on=False),
                  chain.module("width"), chain.module("limiter", ceiling=-1.0)],
        "duck": dict(OFF), "sends": [-90.0] * 4,
    }


def default_fx():
    return [
        {"name": "Vocal Plate", "type": "plate", "params": dict(FX_TYPES["plate"]), "ret": -6.0, "mute": False, "out": "fx", "duck": _duck_default()},
        {"name": "Vocal Hall", "type": "hall", "params": dict(FX_TYPES["hall"]), "ret": -6.0, "mute": False, "out": "fx", "duck": _duck_default()},
        {"name": "Instrument Verb", "type": "room", "params": dict(FX_TYPES["room"]), "ret": -8.0, "mute": False, "out": "fx", "duck": _duck_default()},
        {"name": "Delay", "type": "delay", "params": dict(FX_TYPES["delay"]), "ret": -10.0, "mute": False, "out": "fx",
         "duck": dict(_duck_default("bus:lead"), on=True, amount=6, thr=-35, att=10, rel=450)},
    ]


def default_state(nch):
    return {
        "channels": [default_strip(i) for i in range(nch)],
        "buses": [default_bus(*b) for b in DEFAULT_BUSES],
        "fx": default_fx(),
        "master": default_master(),
        "tempo": 72.0,
        "song": {"key": "C", "scale": "major"},
        "order": list(range(nch)),
        "cables": [{"name": f"Cable {k + 1}", "src": "master" if k == 0 else "none", "gain": 0.0} for k in range(N_CABLES)],
        "monitor": "stereo",
        "dcas": [],
        "version": 3,
    }


def _to_chain(obj, bus):
    """Older sessions kept one fixed slot per processor; turn those into a chain."""
    ch = obj.get("chain")
    if isinstance(ch, list) and all(isinstance(m, dict) for m in ch) and ch:
        return ch
    order = [m for m in ch if isinstance(m, str)] if isinstance(ch, list) and ch else None
    if bus and isinstance(obj.get("drive"), (int, float)) and "sat" not in obj:  # version 1 master
        obj["sat"] = {"on": obj["drive"] > 0.05, "drive": max(obj["drive"], 1.0), "type": "tape", "mix": 100}
    always = ("eq", "width") if obj.get("id") == "master" else ("eq",)
    return chain.legacy_to_chain(obj, bus=bus, always=always, order=order)


def migrate(state, nch):
    """Bring a mixer saved by an older version up to date without losing its settings."""
    st = state
    fresh = default_state(nch)
    for i, c in enumerate(st.get("channels", [])):
        c.setdefault("input", f"in:{i}")
        c["chain"] = _to_chain(c, bus=False)
        for k in LEGACY_KEYS:
            c.pop(k, None)
        for k, v in default_strip(i).items():
            if k not in ("name", "color", "input", "chain"):
                c.setdefault(k, copy.deepcopy(v))
    if "buses" not in st:
        st["buses"] = fresh["buses"]
    known = {b["id"] for b in st["buses"]}
    for b in fresh["buses"]:
        if b["id"] not in known:
            st["buses"].append(b)
    for b in st["buses"]:
        b["chain"] = _to_chain(b, bus=True)
        for k in LEGACY_KEYS + ("width", "balance", "inserts"):
            b.pop(k, None)
        base = default_bus(b["id"], b.get("name", b["id"]), b.get("kind", "group"), b.get("out", "master"), b.get("color", "#888"))
        for k, v in base.items():
            b.setdefault(k, copy.deepcopy(v))
    m = st.get("master") or fresh["master"]
    m.setdefault("id", "master")
    m["chain"] = _to_chain(m, bus=True)
    for k in LEGACY_KEYS + ("width", "balance", "inserts"):
        m.pop(k, None)
    for k, v in default_master().items():
        m.setdefault(k, copy.deepcopy(v))
    st["master"] = m
    fx = st.get("fx") or fresh["fx"]
    for f in fx:
        f["type"] = FX_ALIASES.get(f["type"], f["type"])
        if f["type"] in ("plate", "hall", "room", "delay"):
            base = dict(FX_TYPES[f["type"]])
            base.update({k: v for k, v in f.get("params", {}).items() if k in base})
            f["params"] = base
        f.setdefault("out", "fx")
        f.setdefault("duck", _duck_default())
    st["fx"] = fx
    for k in ("tempo", "cables", "monitor", "song", "dcas"):
        st.setdefault(k, fresh[k])
    order = [i for i in st.get("order", []) if isinstance(i, int) and 0 <= i < nch]
    order += [i for i in range(nch) if i not in order]
    st["order"] = order
    st["version"] = 3
    return st


def make_fx(kind, params, fs, tempo):
    if kind in ("plate", "hall", "room"):
        r = ReverbFX(fs)
        r.set_params(params)
        return r
    if kind == "delay":
        d = StereoDelay(fs)
        d.set_params(params, tempo)
        return d
    if pb is None:
        return None
    p = params
    if kind == "chorus":
        return pb.Pedalboard([pb.Chorus(rate_hz=p["rate_hz"], depth=p["depth"],
                                        centre_delay_ms=p["centre_delay_ms"], feedback=p["feedback"], mix=1.0)])
    if kind == "phaser":
        return pb.Pedalboard([pb.Phaser(rate_hz=p["rate_hz"], depth=p["depth"],
                                        centre_frequency_hz=p["centre_frequency_hz"], feedback=p["feedback"], mix=1.0)])
    if kind == "doubler":
        return pb.Pedalboard([pb.Delay(delay_seconds=p["delay_ms"] / 1000, feedback=0, mix=1.0),
                              pb.PitchShift(semitones=p["semitones"])])
    return None


def run_fx(fx, mono, fs):
    if isinstance(fx, (ReverbFX, StereoDelay)):
        return fx.process(mono.astype(np.float32))
    return fx.process(np.stack([mono, mono]).astype(np.float32), fs, reset=False).T


class Insert:
    """A third-party VST3/AU plugin hosted via pedalboard."""

    def __init__(self, path, name=None):
        self.path = path
        self.plugin = pb.load_plugin(path) if pb else None
        self.name = name or (self.plugin.name if self.plugin is not None else path)
        self.bypass = False
        self.failed = False

    def params(self):
        out = []
        if self.plugin is None:
            return out
        for key, prm in self.plugin.parameters.items():
            try:
                rng = prm.range
                out.append({"key": key, "name": prm.name, "value": float(prm.raw_value),
                            "text": str(prm.string_value), "min": 0.0, "max": 1.0,
                            "label": getattr(prm, "label", "") or ""})
            except Exception:
                pass
        return out

    def set_raw(self, key, raw):
        prm = self.plugin.parameters.get(key)
        if prm is not None:
            prm.raw_value = float(raw)

    def process(self, x, fs):
        if self.bypass or self.failed or self.plugin is None:
            return x
        try:
            y = self.plugin.process(x.T, fs, reset=False).T
            if y.shape == x.shape:
                return y.astype(np.float32)
            return y[:, : x.shape[1]].astype(np.float32) if y.shape[1] >= x.shape[1] else x
        except Exception:
            self.failed = True
            return x


class MissingPlugin:
    """Stands in for a plug-in that can't be loaded on this computer (it is skipped)."""
    failed = True
    bypass = True

    def __init__(self, path, name):
        self.path, self.name = path, name

    def params(self):
        return []

    def set_raw(self, key, raw):
        pass

    def process(self, x, fs):
        return x


class BusUnit:
    """A bus (or the master): its processing chain plus ducking."""

    def __init__(self, fs, loader):
        self.chain = chain.BusChain(fs, loader)
        self.duck = Ducker(fs)

    def set_params(self, b, bypass_limiters=False):
        self.chain.set_params(b.get("chain"), bypass_limiters)

    def process(self, x, sc_fn=None):
        return self.chain.process(x, sc_fn)

    def meters(self):
        gr, lim, mbc, mods = self.chain.meters()
        return {"gr": round(gr, 1), "lim": round(lim, 1), "mbc": mbc, "duck": round(self.duck.gr, 1), "mods": mods}


class Mixer:
    def __init__(self, nch, fs, state=None):
        self.nch, self.fs = nch, fs
        self.lock = threading.RLock()
        self.state = migrate(state or default_state(nch), nch)
        self._fit_channels()
        self.auto = None          # automation overrides for this block, set by the engine
        self.focus = None         # channel whose spectrum the editor is showing
        self.focus_ring = dsp.Ring(4096)
        self.focus_target = None  # 'ch:3' / 'bus:drums' / 'master': whose module meters to report
        self.plugins = {}         # module id -> loaded plug-in instance
        self.loud = dsp.Loudness(fs)
        self.cable_out = None
        self._init_procs()
        self.reset_meters()
        self.rebuild_all()

    def _init_procs(self):
        n, fs = self.nch, self.fs
        self.chains = chain.ChannelChains(n, fs, self._plugin)
        self.strips = {}
        self.master_strip = BusUnit(fs, self._plugin)
        self.fx = [None] * len(self.state["fx"])
        self.fx_duck = [Ducker(fs) for _ in self.state["fx"]]
        self.bus_last = {}
        self.bus_cur = {}
        # silence tracking (samples of continuous silence) so idle parts of the mix cost nothing
        self.ch_quiet = np.zeros(self.nch)
        self.bus_quiet = {}
        self.fx_quiet = [0] * len(self.state["fx"])
        self.master_quiet = 0
        self.last_out_peak = 0.0

    def _fit_channels(self):
        chs = self.state["channels"]
        while len(chs) < self.nch:
            chs.append(default_strip(len(chs)))
        del chs[self.nch:]

    def _plugin(self, m):
        """Load (once) the plug-in a chain module points at; settings come from the module."""
        mid, path = m.get("id"), m.get("path", "")
        cur = self.plugins.get(mid)
        if cur is not None and getattr(cur, "path", None) == path:
            return cur
        try:
            inst = Insert(path, m.get("name"))
            for k, v in (m.get("params") or {}).items():
                try:
                    inst.set_raw(k, v)
                except Exception:
                    pass
        except Exception:
            inst = MissingPlugin(path, m.get("name", "Plug-in"))
        self.plugins[mid] = inst
        return inst

    def set_master_limiters(self, on):
        """Export measures the mix with the master limiter out of the way, then renders with it."""
        self.master_strip.set_params(self.state["master"], bypass_limiters=not on)

    def module_by_id(self, mid):
        for owner in [*self.state["channels"], *self.state["buses"], self.state["master"]]:
            for m in owner.get("chain") or []:
                if m.get("id") == mid:
                    return m
        return None

    # ------------------------------------------------------------- compile
    def rebuild_all(self):
        with self.lock:
            self._rebuild_channels()
            for b in self.state["buses"]:
                self._rebuild_bus(b)
            self.master_strip.set_params(self.state["master"])
            for i in range(len(self.state["fx"])):
                self._rebuild_fx(i, fresh=True)
            self._compile()

    def _rebuild_channels(self):
        self.chains.compile(self.state["channels"], self.state.get("song", {}))
        live = {m["id"] for o in [*self.state["channels"], *self.state["buses"], self.state["master"]]
                for m in o.get("chain") or [] if m.get("type") == "plugin"}
        for mid in [k for k in self.plugins if k not in live]:
            self.plugins.pop(mid, None)

    def _rebuild_bus(self, b):
        st = self.strips.get(b["id"]) or BusUnit(self.fs, self._plugin)
        st.set_params(b)
        self.strips[b["id"]] = st

    def _rebuild_fx(self, i, fresh=False):
        f = self.state["fx"][i]
        cur = self.fx[i] if i < len(self.fx) else None
        tempo = float(self.state.get("tempo", 72))
        if not fresh and isinstance(cur, StereoDelay) and f["type"] == "delay":
            cur.set_params(f["params"], tempo)
            return
        if not fresh and isinstance(cur, ReverbFX) and f["type"] in ("plate", "hall", "room"):
            cur.set_params(f["params"])
            return
        while len(self.fx) <= i:
            self.fx.append(None)
            self.fx_duck.append(Ducker(self.fs))
        self.fx[i] = make_fx(f["type"], f["params"], self.fs, tempo)

    def _topo(self):
        buses = self.state["buses"]
        parent = {b["id"]: b.get("out", "master") for b in buses}

        def depth(bid):
            seen, d = set(), 0
            while bid in parent and bid not in seen:
                seen.add(bid)
                bid = parent[bid]
                d += 1
            return d if bid not in seen else 1  # a loop: treat as routed to master
        return sorted(parent, key=lambda b: -depth(b))

    def _compile(self):
        st = self.state
        effects.tempo_fn = lambda: float(self.state.get("tempo") or 120)   # synced delays / tremolos
        chs, buses = st["channels"], st["buses"]
        dests = ["master"] + [b["id"] for b in buses]
        di = {d: i for i, d in enumerate(dests)}
        # a bus may not feed itself or anything upstream of it
        order = self._topo()
        pre = np.array([dsp.db_to_lin(c["trim"]) * (-1 if c["phase"] else 1) for c in chs], dtype=np.float32)
        self._base = dict(fader=np.array([float(c["fader"]) for c in chs]), pan=np.array([float(c["pan"]) for c in chs]),
                          mute=np.array([bool(c["mute"]) for c in chs]), solo=np.array([bool(c["solo"]) for c in chs]))
        dca_off, dca_mute = np.zeros(len(chs)), np.zeros(len(chs), bool)
        for g in st.get("dcas") or []:
            for c in g.get("members") or []:
                if 0 <= int(c) < len(chs):
                    dca_off[int(c)] += float(g.get("fader", 0.0))
                    dca_mute[int(c)] |= bool(g.get("mute"))
        self._dca = (dca_off, dca_mute) if (dca_off.any() or dca_mute.any()) else None
        # delay per channel: automatic compensation (every channel waits for the slowest chain, so
        # e.g. a denoiser on one mic doesn't smear it against the others) + any alignment delay set by hand
        lat = np.array([0 if ch.get("bypass") else sum(effects.LATENCY.get(m.get("type"), 0) for m in ch.get("chain") or [] if m.get("on", True))
                        for ch in chs])
        user = np.array([int(round(max(0.0, float(ch.get("delay", 0) or 0)) * self.fs / 1000)) for ch in chs])
        d = (lat.max() - lat) * (lat.max() > 0) + user
        self._chdelay = d.astype(np.int64) if d.any() else None
        self.pdc = int(lat.max())
        dest = np.array([di.get(c.get("out", "master"), -1) for c in chs])
        send_lin = np.array([[dsp.db_to_lin(s) for s in c["sends"][:4]] for c in chs])
        bus_send = {b["id"]: np.array([dsp.db_to_lin(s) for s in b.get("sends", [])[:4]]) for b in buses}
        self.c = dict(
            pre=pre, dest=dest, ndest=len(dests), di=di, order=order, send_lin=send_lin,
            any_send=bool(send_lin.any()) or any(v.any() for v in bus_send.values()),
            bus_send={k: v for k, v in bus_send.items() if v.any()},
            buses={b["id"]: b for b in buses},
            bus_gain={b["id"]: 0.0 if b["mute"] else dsp.db_to_lin(b["fader"]) for b in buses},
            fx=[dict(ret=0.0 if f["mute"] else dsp.db_to_lin(f["ret"]), dest=di.get(f.get("out", "fx"), 0),
                     duck=f.get("duck") if (f.get("duck") or {}).get("on") else None) for f in st["fx"]],
            master=0.0 if st["master"]["mute"] else dsp.db_to_lin(st["master"]["fader"]),
            inputs=[c.get("input", f"in:{i}") for i, c in enumerate(chs)],
            cables=[(cb.get("src", "none"), dsp.db_to_lin(cb.get("gain", 0))) for cb in st.get("cables", [])],
            bypass=np.array([i for i, ch in enumerate(chs) if ch.get("bypass")], dtype=np.int64),
        )
        self._src_cache = {}
        self.master_limited = any(m.get("type") == "limiter" and m.get("on", True) for m in st["master"].get("chain") or [])

    # ------------------------------------------------------------- input routing
    def src_index(self, n_in, n_cable=N_CABLES * 2, extra=None):
        """Column of the combined array (main inputs + cable returns + other devices) for each channel; -1 = silent.
        extra: {device key: (offset, channels)} for the other input devices currently open."""
        extra = extra or {}
        key = (n_in, n_cable, tuple(sorted((k, v) for k, v in extra.items())))
        idx = self._src_cache.get(key)
        if idx is None:
            out = []
            for spec in self.c["inputs"]:
                dev = parse_dev(spec)
                if dev is not None:
                    k, ch = dev
                    o = extra.get(k)
                    out.append(n_in + n_cable + o[0] + ch if o is not None and 0 <= ch < o[1] else -1)
                    continue
                try:
                    kind, num = spec.split(":")
                    num = int(num)
                except Exception:
                    out.append(-1)
                    continue
                if kind == "in" and 0 <= num < n_in:
                    out.append(num)
                elif kind == "cable" and 0 <= num < n_cable:
                    out.append(n_in + num)
                else:
                    out.append(-1)
            idx = np.array(out)
            self._src_cache[key] = idx
        return idx

    def devices_in_use(self):
        """Other input devices some channel is set to (so their streams get opened)."""
        return {d[0] for d in (parse_dev(c.get("input")) for c in self.state["channels"]) if d}

    def route_inputs(self, live, cables, extra=None, extra_map=None):
        """Raw, untouched input for every channel (what gets recorded)."""
        frames = live.shape[0]
        n_in = live.shape[1]
        if cables is None:
            cables = np.zeros((frames, N_CABLES * 2), np.float32)
        idx = self.src_index(n_in, cables.shape[1], extra_map if extra is not None else None)
        parts = [live, cables] + ([extra] if extra is not None else [])
        allsrc = np.concatenate(parts, axis=1)
        safe = np.clip(idx, 0, allsrc.shape[1] - 1)
        x = allsrc[:, safe].astype(np.float32)
        silent = (idx < 0) | (idx >= allsrc.shape[1])
        if silent.any():
            x[:, silent] = 0.0
        return x

    # ------------------------------------------------------------- updates
    def set(self, path, value):
        """path like ['channels', 3, 'eq', 'bands', 1, 'gain']"""
        with self.lock:
            node = self.state
            for k in path[:-1]:
                node = node[int(k) if isinstance(node, list) else k]
            last = path[-1]
            if isinstance(node, list):
                node[int(last)] = value
            else:
                node[last] = value
            root = path[0]
            sec = path[2] if len(path) > 2 else None
            # a plug-in setting: send it straight to the loaded plug-in, nothing to rebuild
            if "chain" in path and "params" in path:
                ci = path.index("chain")
                owner = self.state
                for k in path[:ci + 2]:
                    owner = owner[int(k) if isinstance(owner, list) else k]
                if owner.get("type") == "plugin" and path[-2] == "params":
                    inst = self.plugins.get(owner.get("id"))
                    if inst is not None:
                        inst.set_raw(str(path[-1]), value)
                    return
            if root == "channels":
                if sec == "chain":
                    self._rebuild_channels()
            elif root == "buses":
                if sec == "chain":
                    self._rebuild_bus(self.state["buses"][int(path[1])])
            elif root == "master":
                if len(path) > 1 and path[1] == "chain":
                    self.master_strip.set_params(self.state["master"])
            elif root == "fx":
                i = int(path[1])
                if sec == "type":
                    t = FX_ALIASES.get(value, value)
                    self.state["fx"][i]["type"] = t
                    self.state["fx"][i]["params"] = dict(FX_TYPES.get(t, {}))
                    self._rebuild_fx(i, fresh=True)
                elif sec == "params":
                    self._rebuild_fx(i)
            elif root == "song":
                self._rebuild_channels()
            elif root == "tempo":
                for i, f in enumerate(self.state["fx"]):
                    if f["type"] == "delay":
                        self._rebuild_fx(i)
            self._compile()

    def add_bus(self, name, out="broadcast"):
        with self.lock:
            ids = {b["id"] for b in self.state["buses"]}
            k = 1
            while f"bus{k}" in ids:
                k += 1
            b = default_bus(f"bus{k}", name or f"Bus {k}", "group", out, COLORS[k % len(COLORS)])
            self.state["buses"].insert(max(len(self.state["buses"]) - 4, 0), b)
            self._rebuild_bus(b)
            self._compile()
            return b["id"]

    def remove_bus(self, bid):
        with self.lock:
            buses = self.state["buses"]
            gone = next((b for b in buses if b["id"] == bid), None)
            if gone is None or bid in ("broadcast",):
                return
            dest = gone.get("out", "master")
            for c in self.state["channels"]:
                if c.get("out") == bid:
                    c["out"] = dest
            for b in buses:
                if b.get("out") == bid:
                    b["out"] = dest
            for f in self.state["fx"]:
                if f.get("out") == bid:
                    f["out"] = dest
            self.state["buses"] = [b for b in buses if b["id"] != bid]
            self.strips.pop(bid, None)
            self._compile()

    def apply_state(self, state):
        """Swap in new settings but keep running processors (no reverb/delay cut-off)."""
        with self.lock:
            self.state = migrate(state, self.nch)
            self._fit_channels()
            self._rebuild_channels()
            for b in self.state["buses"]:
                self._rebuild_bus(b)
            self.master_strip.set_params(self.state["master"])
            for i in range(len(self.state["fx"])):
                self._rebuild_fx(i)
            self._compile()

    def replace_state(self, state):
        with self.lock:
            self.state = migrate(state, self.nch)
            self._fit_channels()
            self._init_procs()
            self.rebuild_all()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    # ------------------------------------------------------------- meters
    def reset_meters(self):
        n = self.nch
        self.m_in = np.zeros(n, dtype=np.float32)
        self.m_post = np.zeros(n, dtype=np.float32)
        self.m_rms = np.zeros(n, dtype=np.float32)
        self.m_master = np.zeros(2, dtype=np.float32)
        self.m_mrms = 0.0
        self.m_fx = np.zeros(len(self.state["fx"]), dtype=np.float32)
        self.m_bus = {}
        self.m_tp = 0.0

    def read_meters(self):
        mm = self.master_strip.meters()
        ch = self.chains
        out = dict(i=self.m_in, p=self.m_post, r=self.m_rms, m=self.m_master, mr=self.m_mrms, fx=self.m_fx,
                   gr=ch.channel_gr("comp"), gg=ch.channel_gr("gate"), ds=ch.channel_gr("deess"),
                   mgr=mm["gr"], lim=mm["lim"], tp=self.m_tp,
                   b={k: v for k, v in self.m_bus.items()},
                   bm={bid: st.meters() for bid, st in self.strips.items()}, mm=mm,
                   fxd=[round(d.gr, 1) for d in self.fx_duck],
                   at=ch.tune_readouts(), mods=self._focus_mods())
        self.reset_meters()
        return out

    def _focus_mods(self):
        """Live readings for each module of the strip open in the editor."""
        t = self.focus_target
        if not t:
            return None
        try:
            if t.startswith("ch:"):
                return self.chains.module_meters(self.state["channels"][int(t[3:])].get("chain"))
            if t == "master":
                return self.master_strip.meters()["mods"]
            if t.startswith("bus:") and t[4:] in self.strips:
                return self.strips[t[4:]].meters()["mods"]
        except Exception:
            return None
        return None

    # ------------------------------------------------------------- audio helpers
    def _sc_signal(self, spec, x, fad):
        if not spec:
            return None
        if spec.startswith("ch:"):
            n = int(spec[3:])
            if 0 <= n < self.nch:
                v = x[:, n] * fad[n]
                return np.stack([v, v], axis=1)
            return None
        if spec.startswith("bus:"):
            bid = spec[4:]
            if bid in self.bus_cur:
                sig = self.bus_cur[bid]
            else:
                sig = self.bus_last.get(bid)
            if sig is not None and sig.shape[0] == x.shape[0]:
                return sig
        return None

    @staticmethod
    def _peak_db(sig):
        if sig is None or not sig.size:
            return -120.0
        return 20 * np.log10(max(float(np.abs(sig).max()), 1e-9))

    # ------------------------------------------------------------- before / after
    compare = False         # True: self.before_out holds the unprocessed mix (for headphones / speakers)
    before_out = None
    _e_after = 0.0
    _e_before = 0.0

    _dl = None

    def _delay(self, x, d):
        """Delay each channel (column) of x by d[c] samples, keeping history between blocks."""
        frames, n = x.shape
        D = int(d.max())
        if self._dl is None or self._dl.shape != (D, n):
            self._dl = np.zeros((D, n), np.float32)
        buf = np.concatenate([self._dl, x])
        idx = np.arange(frames)[:, None] + (D - d)[None, :]
        x[:] = np.take_along_axis(buf, idx, axis=0)
        self._dl = buf[-D:].copy() if D else self._dl

    def _before(self, Yr, c, master_g, frames):
        """The mix with no processing: channels summed through the same faders, pans and buses
        (bus faders only), no EQ / dynamics / FX / master chain. Level-matched to the processed
        mix, so the louder one doesn't just sound "better"."""
        di = c["di"]
        for bid in c["order"]:
            k = di[bid]
            sig = Yr[:, 2 * k:2 * k + 2] * c["bus_gain"][bid]
            out = c["buses"][bid].get("out", "master")
            if out in di and out != bid:
                j = di[out]
                Yr[:, 2 * j:2 * j + 2] += sig
        out = Yr[:, 0:2] * master_g
        e = float((out.astype(np.float64) ** 2).mean()) if frames else 0.0
        if e > 1e-8:
            self._e_before += (e - self._e_before) * min(1.0, frames / (self.fs * 3.0))
        if not self.compare:
            self.before_out = None
            return
        match = (self._e_after / self._e_before) ** 0.5 if self._e_before > 1e-12 and self._e_after > 1e-12 else 1.0
        self.match_db = 20 * np.log10(min(max(match, 10 ** (-24 / 20)), 10 ** (24 / 20)))
        out = out * (10 ** (self.match_db / 20))
        self.before_out = np.clip(out, -1.0, 1.0).astype(np.float32)

    # ------------------------------------------------------------- audio
    def process(self, x, direct_out=None):
        """x: (frames, nch) float32 channel inputs (already routed), modified in place.
        Returns the stereo master. Also sets self.cable_out (frames, 8) for the virtual cables,
        and fills direct_out with processed pre-fader channels (USB returns) if given."""
        c = self.c
        frames = x.shape[0]
        b = self._base
        fader, pan, mute = b["fader"], b["pan"], b["mute"]
        master_g = c["master"]
        auto = self.auto
        if auto is not None:
            if auto["fader"]:
                fader = fader.copy(); fader[list(auto["fader"])] = list(auto["fader"].values())
            if auto["pan"]:
                pan = pan.copy(); pan[list(auto["pan"])] = list(auto["pan"].values())
            if auto["mute"]:
                mute = mute.copy(); mute[list(auto["mute"])] = [v >= 0.5 for v in auto["mute"].values()]
            if auto.get("master") is not None and not self.state["master"]["mute"]:
                master_g = dsp.db_to_lin(auto["master"])

        if self._dca is not None:      # DCA groups move / mute their members on top of their own faders
            fader = fader + self._dca[0]
            mute = mute | self._dca[1]
        pk_in = np.abs(x).max(axis=0)
        np.maximum(self.m_in, pk_in, out=self.m_in)
        # channels silent for half a second skip their per-channel filters (their audio is already ~zero)
        self.ch_quiet = np.where(pk_in < CH_QUIET, self.ch_quiet + frames, 0)
        dormant = self.ch_quiet > self.fs * 0.5
        # ---- channel strips
        x *= c["pre"]
        # before / after: the same channels, faders and routing with no processing at all
        raw = x.copy()
        byp = c["bypass"]
        keep = x[:, byp].copy() if byp.size else None
        self.chains.process(x, dormant)   # each channel's own chain, in its own order
        if keep is not None:
            x[:, byp] = keep              # bypassed channels pass through untouched
        if self._chdelay is not None:
            self._delay(x, self._chdelay)
        if direct_out is not None:
            direct_out[:] = x
        if self.focus is not None and 0 <= self.focus < self.nch:
            self.focus_ring.write(x[:, self.focus])

        # ---- fader, pan, routing matrix
        solo = b["solo"]
        live = ~(mute | (solo.any() & ~solo))
        fad = np.where(fader <= -89.9, 0.0, 10 ** (fader / 20)) * live
        pl, pr = dsp.pan_gains(pan)
        D = c["ndest"]
        M = np.zeros((self.nch, 2 * D), np.float32)
        rows = np.nonzero(c["dest"] >= 0)[0]
        M[rows, 2 * c["dest"][rows]] = (fad * pl)[rows]
        M[rows, 2 * c["dest"][rows] + 1] = (fad * pr)[rows]
        peak = np.abs(x).max(axis=0)
        np.maximum(self.m_post, peak * fad, out=self.m_post)
        np.maximum(self.m_rms, np.sqrt((x * x).mean(axis=0)) * fad, out=self.m_rms)
        Y = x @ M
        self._before(raw @ M, c, master_g, frames)

        # ---- FX returns (channel sends now, bus sends from the previous block)
        if c["any_send"]:
            sends = x @ (c["send_lin"] * fad[:, None]).astype(np.float32)
            for bid, g in c["bus_send"].items():
                last = self.bus_last.get(bid)
                if last is not None and last.shape[0] == frames:
                    sends += np.outer(last.mean(axis=1), g).astype(np.float32)
            for i, fx in enumerate(self.fx):
                f = c["fx"][i] if i < len(c["fx"]) else None
                if fx is None or f is None or f["ret"] == 0.0:
                    continue
                while len(self.fx_quiet) <= i:
                    self.fx_quiet.append(0)
                if float(np.abs(sends[:, i]).max()) < QUIET:
                    self.fx_quiet[i] += frames
                    if self.fx_quiet[i] > self.fs * 8:  # nothing sent for 8 s: the tail has died away
                        continue
                else:
                    self.fx_quiet[i] = 0
                y = run_fx(fx, sends[:, i], self.fs) * f["ret"]
                if f["duck"]:
                    y = y * self.fx_duck[i].gain(self._peak_db(self._sc_signal(f["duck"].get("src", ""), x, fad)), f["duck"], frames)
                self.m_fx[i] = max(self.m_fx[i], float(np.abs(y).max()))
                d = f["dest"]
                Y[:, 2 * d:2 * d + 2] += y

        # ---- buses, children first
        self.bus_cur = {}
        di = c["di"]
        for bid in c["order"]:
            bs = c["buses"][bid]
            k = di[bid]
            sig = Y[:, 2 * k:2 * k + 2].copy()
            strip = self.strips.get(bid)
            q = self.bus_quiet.get(bid, 0)
            q = q + frames if float(np.abs(sig).max()) < QUIET else 0
            self.bus_quiet[bid] = q
            if q > self.fs * 1.5:  # silent bus: skip its processing entirely
                self.bus_cur[bid] = None
                if strip is not None:
                    strip.duck.gr = 0.0
                continue
            if strip is not None and not bs.get("bypass"):
                strip.process(sig, lambda spec: self._sc_signal(spec, x, fad))
                duck = bs.get("duck") or {}
                if duck.get("on") and duck.get("src"):
                    sig *= strip.duck.gain(self._peak_db(self._sc_signal(duck["src"], x, fad)), duck, frames)
                else:
                    strip.duck.gr = 0.0
            sig = (sig * c["bus_gain"][bid]).astype(np.float32)
            self.bus_cur[bid] = sig
            mb = self.m_bus.get(bid)
            pk = np.abs(sig).max(axis=0) if frames else np.zeros(2)
            rms = float(np.sqrt((sig * sig).mean())) if frames else 0.0
            self.m_bus[bid] = [max(float(pk[0]), mb[0] if mb else 0), max(float(pk[1]), mb[1] if mb else 0), max(rms, mb[2] if mb else 0)]
            out = bs.get("out", "master")
            if out in di and out != bid:
                j = di[out]
                Y[:, 2 * j:2 * j + 2] += sig
        self.bus_last = self.bus_cur

        # ---- master
        out = Y[:, 0:2].astype(np.float32)
        self.master_quiet = self.master_quiet + frames if float(np.abs(out).max()) < QUIET else 0
        if self.master_quiet > self.fs * 1.5:
            out[:] = 0.0
            self.loud.silence(frames)
        else:
            if not self.state["master"].get("bypass"):
                self.master_strip.process(out, lambda spec: self._sc_signal(spec, x, fad))
            out *= master_g
            if self.master_limited:
                np.clip(out, -1.0, 1.0, out=out)
            self.loud.process(out)
        self.last_out_peak = float(np.abs(out).max()) if frames else 0.0
        e = float((out.astype(np.float64) ** 2).mean()) if frames else 0.0
        if e > 1e-8:   # only while there is sound (about -80 dBFS and up)
            self._e_after += (e - self._e_after) * min(1.0, frames / (self.fs * 3.0))
        np.maximum(self.m_master, np.abs(out).max(axis=0), out=self.m_master)
        self.m_mrms = max(self.m_mrms, float(np.sqrt((out * out).mean())))
        self.m_tp = max(self.m_tp, self.loud.last_tp)

        # ---- virtual cables
        cab = np.zeros((frames, N_CABLES * 2), np.float32)
        for k, (spec, g) in enumerate(c["cables"][:N_CABLES]):
            if spec == "none" or g == 0:
                continue
            if spec == "master":
                sig = out
            elif spec.startswith("bus:"):
                sig = self.bus_cur.get(spec[4:])  # None when that bus is silent
            else:
                sig = self._sc_signal(spec, x, fad)
            if sig is not None:
                cab[:, 2 * k:2 * k + 2] = sig * g
        self.cable_out = cab
        return out
