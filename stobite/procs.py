"""Higher-level processors: saturation, transient shaping, dynamic EQ,
multiband compression, lookahead/true-peak limiting, delay, reverb, and the
stereo BusStrip that chains them for group buses, the broadcast bus and master.

All work on float32 blocks shaped (frames, channels) and keep their own state.
"""
import math

import numpy as np

from .dsp import TP_HIST, SUB, Dynamics, FilterBank, biquad, strip_sos, _db, _tc, BW_Q, sosfilt_multi, true_peak

try:
    import pedalboard as pb
except Exception:  # pragma: no cover
    pb = None


# ---------------------------------------------------------------- saturation

SAT_TYPES = ("tape", "tube", "console", "soft")


def _shape(x, kind, g):
    if kind == "tube":  # asymmetric -> even harmonics, warm
        b = 0.12
        return (np.tanh(g * x + b) - math.tanh(b)) / g
    if kind == "console":  # gentle cubic, mostly 3rd harmonic
        u = np.clip(g * x, -1.5, 1.5)
        return (u - u ** 3 / 6.75) / g
    if kind == "soft":  # soft clipper: clean until near the top
        u = g * x
        return np.where(np.abs(u) < 0.7, u, np.sign(u) * (0.7 + 0.3 * np.tanh((np.abs(u) - 0.7) / 0.3))) / g
    return np.tanh(g * x) / g  # tape


class Saturator:
    """Per-channel harmonic saturation; quiet signals pass at unity gain."""

    def __init__(self, nch):
        self.nch = nch
        self.groups = []

    def set_params(self, strips):
        groups = {}
        for c, s in enumerate(strips):
            d = s.get("sat") or {}
            if d.get("on") and d.get("drive", 0) > 0.05:
                groups.setdefault(d.get("type", "tape"), []).append((c, 10 ** (d["drive"] / 20), d.get("mix", 100) / 100))
        self.groups = [(k, np.array([c for c, _, _ in v]), np.array([g for _, g, _ in v], np.float32),
                        np.array([m for _, _, m in v], np.float32)) for k, v in groups.items()]

    def process(self, x):
        for kind, idx, g, mix in self.groups:
            dry = x[:, idx]
            wet = _shape(dry, kind, g).astype(np.float32)
            x[:, idx] = dry * (1 - mix) + wet * mix
        return x


# ---------------------------------------------------------------- transient shaper

class Transient:
    """Attack/sustain shaper from the difference between a fast and a slow envelope."""

    def __init__(self, nch, fs):
        self.nch, self.fs = nch, fs
        self.fast = np.full(nch, -120.0)
        self.slow = np.full(nch, -120.0)
        self.prev = np.ones(nch)
        self.on = np.zeros(nch, bool)
        self.att = np.zeros(nch)
        self.sus = np.zeros(nch)
        self.c = (_tc(0.5, fs), _tc(30, fs), _tc(25, fs), _tc(250, fs))

    def set_params(self, strips):
        for c, s in enumerate(strips):
            d = s.get("trans") or {}
            self.on[c] = bool(d.get("on"))
            self.att[c] = float(d.get("attack", 0))
            self.sus[c] = float(d.get("sustain", 0))
        self.active = bool(self.on.any())

    def process(self, x):
        if not self.active:
            return x
        frames = x.shape[0]
        nsub = max(frames // SUB, 1)
        lvl = _db(np.abs(x[: nsub * SUB]).reshape(nsub, -1, self.nch).max(axis=1))
        fa, fr, sa, sr = self.c
        f, self.fast = Dynamics._smooth(lvl, self.fast, fr, fa)  # rises fast, falls medium
        sl, self.slow = Dynamics._smooth(lvl, self.slow, sr, sa)
        diff = f - sl
        trans = np.clip(diff / 9.0, 0, 1)          # 1 during an attack
        tail = np.clip(-diff / 9.0, 0, 1)          # 1 while ringing out
        gain_db = (self.att * trans + self.sus * tail) * self.on
        lin = 10 ** (gain_db / 20)
        self.prev = Dynamics._apply(x, lin, self.prev)
        return x


# ---------------------------------------------------------------- dynamic EQ

class DynEQ:
    """Dynamic EQ for `nch` linked channels. Each band: a static gain plus up to
    `range` dB more (negative = cut, positive = boost) as its band level passes
    the threshold. Detection can come from a sidechain."""

    def __init__(self, nch, fs):
        self.nch, self.fs = nch, fs
        self.bands = []
        self.state = []

    def set_params(self, d):
        bands = [b for b in (d or {}).get("bands", []) if b.get("on", True)] if (d or {}).get("on") else []
        if len(bands) != len(self.state):
            self.state = [dict(env=-120.0, zi=np.zeros((self.nch, 1, 2)), dz=np.zeros((self.nch, 1, 2)), dyn=0.0)
                          for _ in bands]
        self.bands = bands

    def process(self, x, detect=None):
        if not self.bands:
            return x
        fs = self.fs
        det_src = x if detect is None else detect
        nsub = max(x.shape[0] // SUB, 1)
        for b, st in zip(self.bands, self.state):
            bp = biquad("bell", b["freq"], 0, b.get("q", 1.5), fs)
            # band-pass detector (constant skirt) at the band frequency
            w0 = 2 * math.pi * min(b["freq"], fs * 0.45) / fs
            al = math.sin(w0) / (2 * max(b.get("q", 1.5), 0.1))
            det = np.array([[al, 0, -al, 1 + al, -2 * math.cos(w0), 1 - al]])
            det[0] /= det[0, 3]
            if st["dz"].shape[0] != det_src.shape[1]:
                st["dz"] = np.zeros((det_src.shape[1], 1, 2))
            y = sosfilt_multi(det, det_src, st["dz"])
            lvl = _db(np.abs(y[: nsub * SUB]).reshape(nsub, -1, y.shape[1]).max(axis=(1, 2)))
            att, rel = _tc(b.get("att", 5), fs), _tc(b.get("rel", 120), fs)
            env = st["env"]
            for v in lvl:
                env = v + (att if v > env else rel) * (env - v)
            st["env"] = env
            amt = np.clip((env - b.get("thr", -24)) / 6.0, 0, 1)
            target = b.get("range", -6) * amt
            st["dyn"] += (target - st["dyn"]) * 0.5
            gain = b.get("gain", 0) + st["dyn"]
            b["_live"] = round(st["dyn"], 1)
            sos = biquad(b.get("type", "bell"), b["freq"], gain, b.get("q", 1.5), fs)[None, :]
            x[:] = sosfilt_multi(sos, x, st["zi"])
        return x


# ---------------------------------------------------------------- multiband compressor

def _lr4(kind, f, fs):
    return np.array([biquad(kind, f, 0, 0.7071, fs), biquad(kind, f, 0, 0.7071, fs)])


class Multiband:
    """3-band stereo compressor with Linkwitz-Riley (LR4) crossovers that sum flat."""

    def __init__(self, fs):
        self.fs = fs
        self.dyn = Dynamics(6, fs)
        self.zi = {}
        self.on = False
        self.gains = np.ones(6, np.float32)
        self.f = (0, 0)

    def set_params(self, d):
        d = d or {}
        self.on = bool(d.get("on"))
        f1, f2 = float(d.get("x1", 200)), float(d.get("x2", 3000))
        if (f1, f2) != self.f:
            fs = self.fs
            self.sos = {"lp1": _lr4("lp", f1, fs), "hp1": _lr4("hp", f1, fs), "lp2": _lr4("lp", f2, fs),
                        "hp2": _lr4("hp", f2, fs), "ap_lp": _lr4("lp", f2, fs), "ap_hp": _lr4("hp", f2, fs)}
            self.zi = {k: np.zeros((2, 2, 2)) for k in self.sos}  # (channels, sections, 2)
            self.f = (f1, f2)
        bands = (d.get("bands") or [{}, {}, {}])[:3]
        strips = []
        gains = []
        for b in bands:
            comp = {"on": True, "thr": b.get("thr", -20), "ratio": b.get("ratio", 2), "att": b.get("att", 20),
                    "rel": b.get("rel", 200), "knee": 6, "makeup": 0, "range": b.get("range", 6)}
            strips += [{"comp": comp}, {"comp": comp}]
            gains += [10 ** (b.get("gain", 0) / 20)] * 2
        self.dyn.set_params(strips)
        self.gains = np.array(gains, np.float32)

    def _f(self, k, x):
        return sosfilt_multi(self.sos[k], x, self.zi[k])

    def process(self, x):
        if not self.on:
            return x
        low = self._f("lp1", x)
        rest = self._f("hp1", x)
        mid = self._f("lp2", rest)
        high = self._f("hp2", rest)
        low = self._f("ap_lp", low) + self._f("ap_hp", low)  # phase-align low band with the f2 split
        bands = np.concatenate([low, mid, high], axis=1).astype(np.float32)  # (frames, 6)
        self.dyn.process(bands)
        bands *= self.gains
        x[:] = bands[:, 0:2] + bands[:, 2:4] + bands[:, 4:6]
        return x

    @property
    def gr(self):
        g = self.dyn.comp_gr
        return [round(float(max(g[0], g[1])), 1), round(float(max(g[2], g[3])), 1), round(float(max(g[4], g[5])), 1)]


# ---------------------------------------------------------------- limiter

class LookaheadLimiter:
    """Stereo-linked brickwall limiter with lookahead and optional true-peak
    (4x oversampled) detection. Adds `lookahead` ms of latency."""

    def __init__(self, fs):
        self.fs = fs
        self.on, self.ceiling, self.threshold, self.gain = True, -1.0, 0.0, 0.0
        self.true_peak = True
        self.rel_ms = 120
        self.set_lookahead(1.5)
        self.state = np.zeros(1)
        self.prev = np.ones(1)
        self.gr = 0.0

    def set_lookahead(self, ms):
        self.la = max(int(self.fs * ms / 1000), SUB)
        self.buf = np.zeros((self.la, 2), np.float32)
        self.dbuf = np.zeros(self.la, np.float32)

    def set_params(self, d):
        d = d or {}
        self.on = bool(d.get("on", True))
        self.ceiling = float(d.get("ceiling", -1.0))
        self.threshold = float(d.get("threshold", 0.0))
        self.gain = float(d.get("gain", 0.0))
        self.true_peak = bool(d.get("truepeak", True))
        self.rel = _tc(float(d.get("release", 120)), self.fs)
        la = float(d.get("lookahead", 1.5))
        if max(int(self.fs * la / 1000), SUB) != self.la:
            self.set_lookahead(la)

    def _detect(self, x):
        if self.true_peak:
            h = getattr(self, "_tp_hist", None)
            if h is None or h.shape[1] != x.shape[1]:
                h = self._tp_hist = np.zeros((TP_HIST, x.shape[1]), np.float32)
            return true_peak(x, h)
        return np.abs(x).max(axis=1)

    def process(self, x):
        if not self.on:
            self.gr = 0.0
            return x
        frames = x.shape[0]
        x *= 10 ** ((self.gain - self.threshold) / 20)
        det = self._detect(x)
        sig = np.concatenate([self.buf, x])          # delayed signal source
        dall = np.concatenate([self.dbuf, det])
        self.buf, self.dbuf = sig[-self.la:].copy(), dall[-self.la:].copy()
        # max over each output sample's lookahead window
        n = self.la + 1  # window [i, i + lookahead] for each output sample
        win = np.lib.stride_tricks.sliding_window_view(dall, n)[:frames].max(axis=1)
        c = 10 ** (self.ceiling / 20)
        need = _db(np.maximum(win, 1e-9)) - self.ceiling
        nsub = max(frames // SUB, 1)
        tgt = np.maximum(need[: nsub * SUB].reshape(nsub, SUB).max(axis=1), 0.0)[:, None]
        red, self.state = Dynamics._smooth(tgt, self.state, 0.0, self.rel)
        y = sig[:frames].copy()
        self.prev = Dynamics._apply(y, 10 ** (-red / 20), self.prev)
        self.gr = float(red.max()) if red.size else 0.0
        np.clip(y, -c, c, out=y)
        x[:] = y
        return x


# ---------------------------------------------------------------- stereo helpers

def width_balance(x, width_pct, balance):
    if abs(width_pct - 100) > 0.5:
        w = width_pct / 100.0
        m = (x[:, 0] + x[:, 1]) * 0.5
        sd = (x[:, 0] - x[:, 1]) * 0.5 * w
        x[:, 0], x[:, 1] = m + sd, m - sd
    if abs(balance) > 0.005:
        x[:, 0] *= min(1.0, 1 - balance)
        x[:, 1] *= min(1.0, 1 + balance)
    return x


# ---------------------------------------------------------------- delay

NOTE_BEATS = {"1/2": 2.0, "1/4": 1.0, "1/4d": 1.5, "1/8": 0.5, "1/8d": 0.75, "1/8t": 1 / 3, "1/16": 0.25}


class StereoDelay:
    """Tempo-synced stereo / ping-pong delay with filtered feedback."""
    MAX = 4.0

    def __init__(self, fs):
        self.fs = fs
        n = int(fs * self.MAX)
        self.ring = np.zeros((n, 2), np.float32)
        self.w = 0
        self.zi = np.zeros((2, 2, 2))
        self.p = {}

    def set_params(self, p, tempo):
        self.p = p
        beats = NOTE_BEATS.get(p.get("note", "1/8d"))
        ms = (60000.0 / max(tempo, 20) * beats) if beats and p.get("sync", True) else float(p.get("time_ms", 375))
        ms += float(p.get("predelay_ms", 0))
        self.d = int(min(max(ms, 1), self.MAX * 1000 - 50) * self.fs / 1000)
        self.fb = float(np.clip(p.get("feedback", 0.35), 0, 0.95))
        self.sos = np.array([biquad("hp", p.get("lowcut", 250), 0, 0.7071, self.fs),
                             biquad("lp", p.get("highcut", 6000), 0, 0.7071, self.fs)])
        self.width = float(p.get("width", 100)) / 100
        self.ping = bool(p.get("pingpong", True))
        self.ms = ms

    def process(self, mono):
        frames = len(mono)
        n = len(self.ring)
        d = max(self.d, frames)  # feedback is computed a block at a time
        r = (self.w - d + np.arange(frames)) % n
        out = self.ring[r].copy()
        out = sosfilt_multi(self.sos, out, self.zi).astype(np.float32)
        wi = (self.w + np.arange(frames)) % n
        if self.ping:
            self.ring[wi, 0] = mono + self.fb * out[:, 1]
            self.ring[wi, 1] = self.fb * out[:, 0]
        else:
            self.ring[wi, 0] = mono + self.fb * out[:, 0]
            self.ring[wi, 1] = mono + self.fb * out[:, 1]
        self.w = (self.w + frames) % n
        return width_balance(out, self.width * 100, 0.0)


# ---------------------------------------------------------------- reverb

class ReverbFX:
    """Pre-delay -> early reflections + diffuse tail -> return EQ."""

    def __init__(self, fs):
        self.fs = fs
        self.ring = np.zeros((int(fs * 0.5), ), np.float32)
        self.w = 0
        self.zi = np.zeros((2, 2, 2))
        self.verb = None

    def set_params(self, p):
        fs = self.fs
        self.pre = int(fs * float(p.get("predelay_ms", 20)) / 1000)
        size = float(p.get("size", 0.6))
        decay = float(p.get("decay", p.get("room_size", 0.6)))
        if pb is not None:
            self.verb = pb.Reverb(room_size=min(decay, 0.98), damping=p.get("damping", 0.5),
                                  width=min(p.get("width", 100) / 100, 1.0), wet_level=1.0, dry_level=0.0)
        base = [7, 11, 17, 23, 31, 41, 53]
        self.taps = [(int(fs * t * (0.4 + size) / 1000), (0.8 - i * 0.09), i % 2) for i, t in enumerate(base)]
        self.er = float(p.get("early", 0.35))
        self.sos = np.array([biquad("hp", p.get("lowcut", 200), 0, 0.7071, fs),
                             biquad("lp", p.get("highcut", 9000), 0, 0.7071, fs)])
        self.width = float(p.get("width", 100))

    def process(self, mono):
        frames = len(mono)
        n = len(self.ring)
        wi = (self.w + np.arange(frames)) % n
        self.ring[wi] = mono
        pre = self.ring[(self.w - self.pre + np.arange(frames)) % n]
        out = np.zeros((frames, 2), np.float32)
        if self.er > 0:
            for d, g, side in self.taps:
                out[:, side] += self.ring[(self.w - self.pre - d + np.arange(frames)) % n] * g * self.er * 0.5
        self.w = (self.w + frames) % n
        if self.verb is not None:
            out += self.verb.process(np.stack([pre, pre]).astype(np.float32), self.fs, reset=False).T
        out = sosfilt_multi(self.sos, out, self.zi)
        return width_balance(out.astype(np.float32), min(self.width, 100), 0.0) if self.width < 100 else out.astype(np.float32)


# ---------------------------------------------------------------- ducking

class Ducker:
    """Turns a sidechain level into gain reduction on a target (bus or FX return)."""

    def __init__(self, fs):
        self.fs = fs
        self.gr = 0.0

    def gain(self, src_db, d, frames):
        """src_db: sidechain peak level (dB) for this block."""
        thr, amount = float(d.get("thr", -30)), abs(float(d.get("amount", 2)))
        ratio = max(float(d.get("ratio", 4)), 1.0)
        over = max(src_db - thr, 0.0)
        target = min(over * (1 - 1 / ratio), amount) if over > 0 else 0.0
        if over > 0 and d.get("mode", "duck") == "gate":
            target = amount
        t = frames / self.fs * 1000
        att = math.exp(-t / max(float(d.get("att", 15)), 0.1))
        rel = math.exp(-t / max(float(d.get("rel", 400)), 1))
        coef = att if target > self.gr else rel
        self.gr = target + coef * (self.gr - target)
        return 10 ** (-self.gr / 20)


# ---------------------------------------------------------------- bus strip

CHAIN_DEFAULT = ["eq", "comp", "sat", "dyneq", "mbc", "width", "limiter"]


class BusStrip:
    """Stereo processing for a group bus, the broadcast bus or the master.
    `chain` sets the order; each module has its own on/bypass switch."""

    def __init__(self, fs):
        self.fs = fs
        self.filters = FilterBank(2)
        self.comp = Dynamics(2, fs)
        self.sat = Saturator(2)
        self.dyneq = DynEQ(2, fs)
        self.mbc = Multiband(fs)
        self.limiter = LookaheadLimiter(fs)
        self.duck = Ducker(fs)
        self.chain = list(CHAIN_DEFAULT)
        self.s = {}

    def set_params(self, s):
        self.s = s
        sos, act = strip_sos(s, self.fs)
        self.filters.set(0, sos, act)
        self.filters.set(1, sos.copy() if act else None, act)
        self.comp.set_params([s, s])
        self.sat.set_params([s, s])
        self.dyneq.set_params(s.get("dyneq"))
        self.mbc.set_params(s.get("mbc"))
        lim = s.get("limiter") or {"on": False}
        self.limiter.set_params(lim)
        self.chain = [m for m in s.get("chain", CHAIN_DEFAULT) if m in CHAIN_DEFAULT]
        for m in CHAIN_DEFAULT:
            if m not in self.chain:
                self.chain.append(m)
        self.width = float(s.get("width", 100))
        self.balance = float(s.get("balance", 0))

    def process(self, x, detect=None):
        """detect: optional stereo sidechain for the compressor / dynamic EQ."""
        s = self.s
        for m in self.chain:
            if m == "eq":
                self.filters.process(x)
            elif m == "comp":
                self.comp.process(x, detect if (s.get("comp") or {}).get("sc") else None)
            elif m == "sat":
                self.sat.process(x)
            elif m == "dyneq":
                self.dyneq.process(x, detect if (s.get("dyneq") or {}).get("sc") else None)
            elif m == "mbc":
                self.mbc.process(x)
            elif m == "width":
                width_balance(x, self.width, self.balance)
            elif m == "limiter":
                self.limiter.process(x)
        return x

    def meters(self):
        return {"gr": round(float(self.comp.comp_gr.max()), 1), "lim": round(self.limiter.gr, 1),
                "mbc": self.mbc.gr if self.mbc.on else None,
                "deq": [b.get("_live", 0) for b in self.dyneq.bands], "duck": round(self.duck.gr, 1)}
