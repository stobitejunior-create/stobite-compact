"""The mixing engine: N channel strips -> FX buses -> stereo master."""
import copy
import threading
import numpy as np

from . import dsp

try:
    import pedalboard as pb
except Exception:  # pragma: no cover - optional
    pb = None

COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"]

FX_TYPES = {
    "reverb": {"room_size": 0.6, "damping": 0.5, "width": 1.0, "predelay_ms": 20},
    "plate": {"room_size": 0.35, "damping": 0.25, "width": 1.0, "predelay_ms": 0},
    "delay": {"time_ms": 375, "feedback": 0.35, "tone": 0.6},
    "chorus": {"rate_hz": 0.8, "depth": 0.25, "centre_delay_ms": 7, "feedback": 0.0},
    "phaser": {"rate_hz": 0.5, "depth": 0.5, "centre_frequency_hz": 1300, "feedback": 0.0},
    "doubler": {"semitones": 0.12, "delay_ms": 18},
}


def default_strip(i):
    return {
        "name": f"Ch {i + 1}", "color": COLORS[(i // 8) % len(COLORS)],
        "trim": 0.0, "phase": False,
        "hpf": {"on": False, "freq": 80, "slope": 24},
        "lpf": {"on": False, "freq": 16000},
        "gate": {"on": False, "thr": -50, "range": 40, "att": 1, "rel": 120},
        "eq": {"on": True, "bands": [
            {"type": "lowshelf", "freq": 100, "gain": 0, "q": 0.7, "on": True},
            {"type": "bell", "freq": 400, "gain": 0, "q": 1.0, "on": True},
            {"type": "bell", "freq": 2500, "gain": 0, "q": 1.0, "on": True},
            {"type": "highshelf", "freq": 8000, "gain": 0, "q": 0.7, "on": True},
        ]},
        "comp": {"on": False, "thr": -18, "ratio": 3, "knee": 6, "att": 10, "rel": 150, "makeup": 0},
        "deess": {"on": False, "freq": 6500, "thr": -28, "range": 8},
        "inserts": [],
        "pan": 0.0, "fader": 0.0, "mute": False, "solo": False,
        "sends": [-90.0, -90.0, -90.0, -90.0],
        "link": False,
    }


def default_state(nch):
    return {
        "channels": [default_strip(i) for i in range(nch)],
        "fx": [
            {"name": "Hall", "type": "reverb", "params": dict(FX_TYPES["reverb"]), "ret": -6.0, "mute": False},
            {"name": "Plate", "type": "plate", "params": dict(FX_TYPES["plate"]), "ret": -6.0, "mute": False},
            {"name": "Delay", "type": "delay", "params": dict(FX_TYPES["delay"]), "ret": -10.0, "mute": False},
            {"name": "Chorus", "type": "chorus", "params": dict(FX_TYPES["chorus"]), "ret": -10.0, "mute": False},
        ],
        "master": {
            "name": "Master", "fader": 0.0, "mute": False,
            "hpf": {"on": False, "freq": 30, "slope": 24}, "lpf": {"on": False, "freq": 18000},
            "eq": {"on": True, "bands": copy.deepcopy(default_strip(0)["eq"]["bands"])},
            "comp": {"on": False, "thr": -12, "ratio": 2, "knee": 6, "att": 30, "rel": 200, "makeup": 0},
            "limiter": {"on": True, "ceiling": -0.5},
            "drive": 0.0, "width": 100.0, "target": -14.0,
            "inserts": [],
        },
    }


def make_fx(kind, params, fs):
    if pb is None:
        return None
    p = params
    if kind in ("reverb", "plate"):
        chain = []
        if p.get("predelay_ms", 0) > 0:
            chain.append(pb.Delay(delay_seconds=p["predelay_ms"] / 1000, feedback=0, mix=1.0))
        chain.append(pb.Reverb(room_size=p["room_size"], damping=p["damping"], width=p["width"],
                               wet_level=1.0, dry_level=0.0))
        return pb.Pedalboard(chain)
    if kind == "delay":
        return pb.Pedalboard([pb.Delay(delay_seconds=p["time_ms"] / 1000, feedback=p["feedback"], mix=1.0),
                              pb.LowpassFilter(cutoff_frequency_hz=2000 + 16000 * p.get("tone", 0.6))])
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


class Mixer:
    def __init__(self, nch, fs, state=None):
        self.nch, self.fs = nch, fs
        self.lock = threading.RLock()
        self.state = state or default_state(nch)
        self._fit_channels()
        for k, v in (("drive", 0.0), ("width", 100.0), ("target", -14.0)):
            self.state["master"].setdefault(k, v)
        self.auto = None          # automation overrides for this block, set by the engine
        self.focus = None         # channel whose spectrum the editor is showing
        self.focus_ring = dsp.Ring(4096)
        self.deess = dsp.DeEsser(nch, fs)
        self.filters = dsp.FilterBank(nch)
        self.dyn = dsp.Dynamics(nch, fs)
        self.mfilters = dsp.FilterBank(2)
        self.mdyn = dsp.Dynamics(2, fs)
        self.limiter = dsp.Limiter(fs)
        self.loud = dsp.Loudness(fs)
        self.fx = [None] * 4
        self.inserts = [[] for _ in range(nch)]
        self.minserts = []
        self.reset_meters()
        self.rebuild_all()

    def _fit_channels(self):
        chs = self.state["channels"]
        while len(chs) < self.nch:
            chs.append(default_strip(len(chs)))
        del chs[self.nch:]
        for c in chs:  # sessions saved by older versions
            c.setdefault("deess", {"on": False, "freq": 6500, "thr": -28, "range": 8})

    # ------------------------------------------------------------- compile
    def rebuild_all(self):
        with self.lock:
            for c in range(self.nch):
                self._rebuild_filter(c)
            self._rebuild_master_filter()
            for i in range(len(self.state["fx"])):
                self._rebuild_fx(i)
            self._compile()

    def _rebuild_filter(self, c):
        sos, act = dsp.strip_sos(self.state["channels"][c], self.fs)
        self.filters.set(c, sos, act)

    def _rebuild_master_filter(self):
        sos, act = dsp.strip_sos(self.state["master"], self.fs)
        self.mfilters.set(0, sos, act)
        self.mfilters.set(1, sos.copy(), act)

    def _rebuild_fx(self, i):
        f = self.state["fx"][i]
        self.fx[i] = make_fx(f["type"], f["params"], self.fs)

    def _gains(self, fader, pan, mute, solo):
        fader_db = fader
        any_solo = bool(solo.any())
        live = np.where(mute | (any_solo & ~solo), 0.0, 1.0)
        fad = np.where(fader_db <= -89.9, 0.0, 10 ** (fader_db / 20)) * live
        pl, pr = dsp.pan_gains(pan)
        mix = np.stack([fad * pl, fad * pr], axis=1).astype(np.float32)
        sends = (self._send_lin * fad[:, None]).astype(np.float32)
        return mix, sends, fad.astype(np.float32)

    def _compile(self):
        chs = self.state["channels"]
        pre = np.array([dsp.db_to_lin(c["trim"]) * (-1 if c["phase"] else 1) for c in chs], dtype=np.float32)
        self._base = dict(fader=np.array([float(c["fader"]) for c in chs]), pan=np.array([float(c["pan"]) for c in chs]),
                          mute=np.array([bool(c["mute"]) for c in chs]), solo=np.array([bool(c["solo"]) for c in chs]))
        self._send_lin = np.array([[dsp.db_to_lin(s) for s in c["sends"][:4]] for c in chs])
        mix, sends, fad = self._gains(**self._base)
        m = self.state["master"]
        self.c = dict(
            pre=pre, mix=mix, sends=sends,
            any_send=bool(self._send_lin.any()),
            fx_ret=[0.0 if f["mute"] else dsp.db_to_lin(f["ret"]) for f in self.state["fx"]],
            master=0.0 if m["mute"] else dsp.db_to_lin(m["fader"]),
            drive=float(m.get("drive", 0)), width=float(m.get("width", 100)),
            post=fad,
        )
        self.dyn.set_params(chs)
        self.deess.set_params(chs)
        self.mdyn.set_params([m, m])
        self.limiter.on = m["limiter"]["on"]
        self.limiter.ceiling = float(m["limiter"]["ceiling"])

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
            if root == "channels":
                c = int(path[1])
                if len(path) > 2 and path[2] in ("hpf", "lpf", "eq"):
                    self._rebuild_filter(c)
                if len(path) > 2 and path[2] == "link":
                    pass
            elif root == "master":
                if len(path) > 1 and path[1] in ("hpf", "lpf", "eq"):
                    self._rebuild_master_filter()
            elif root == "fx":
                i = int(path[1])
                if len(path) > 2 and path[2] in ("type", "params"):
                    if path[2] == "type":
                        self.state["fx"][i]["params"] = dict(FX_TYPES.get(value, {}))
                    self._rebuild_fx(i)
            self._compile()

    def automated(self, auto):
        """Per-block gains with automation overrides.
        auto: {"fader": {ch: dB}, "pan": {ch: v}, "mute": {ch: 0/1}, "master": dB or None}"""
        b = self._base
        fader, pan, mute = b["fader"], b["pan"], b["mute"]
        if auto["fader"]:
            fader = fader.copy(); idx = list(auto["fader"]); fader[idx] = list(auto["fader"].values())
        if auto["pan"]:
            pan = pan.copy(); idx = list(auto["pan"]); pan[idx] = list(auto["pan"].values())
        if auto["mute"]:
            mute = mute.copy(); idx = list(auto["mute"]); mute[idx] = [v >= 0.5 for v in auto["mute"].values()]
        mix, sends, fad = self._gains(fader, pan, mute, b["solo"])
        m = self.state["master"]
        mg = self.c["master"] if auto.get("master") is None or m["mute"] else dsp.db_to_lin(auto["master"])
        return mix, sends, fad, mg

    def replace_state(self, state):
        with self.lock:
            self.state = state
            self._fit_channels()
            for k, v in (("drive", 0.0), ("width", 100.0), ("target", -14.0)):
                self.state["master"].setdefault(k, v)
            self.filters = dsp.FilterBank(self.nch)
            self.dyn = dsp.Dynamics(self.nch, self.fs)
            self.deess = dsp.DeEsser(self.nch, self.fs)
            self.rebuild_all()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    # ------------------------------------------------------------- meters
    def reset_meters(self):
        self.m_in = np.zeros(self.nch, dtype=np.float32)
        self.m_post = np.zeros(self.nch, dtype=np.float32)
        self.m_master = np.zeros(2, dtype=np.float32)
        self.m_fx = np.zeros(4, dtype=np.float32)

    def read_meters(self):
        out = dict(i=self.m_in, p=self.m_post, m=self.m_master, fx=self.m_fx,
                   gr=self.dyn.comp_gr.copy(), gg=self.dyn.gate_gr.copy(), ds=self.deess.gr.copy(),
                   mgr=float(self.mdyn.comp_gr.max()), lim=self.limiter.gr)
        self.reset_meters()
        return out

    # ------------------------------------------------------------- audio
    def process(self, x, direct_out=None):
        """x: (frames, nch) float32, modified in place.
        Returns stereo master (frames, 2). If direct_out is an array (frames, nch)
        it receives the processed, pre-fader channel signals (for USB returns)."""
        c = self.c
        auto = self.auto
        if auto is not None:
            mix, sends_m, post, master_g = self.automated(auto)
        else:
            mix, sends_m, post, master_g = c["mix"], c["sends"], c["post"], c["master"]
        np.maximum(self.m_in, np.abs(x).max(axis=0), out=self.m_in)
        x *= c["pre"]
        self.filters.process(x)
        self.dyn.process(x)
        self.deess.process(x)
        for ch, ins in enumerate(self.inserts):
            if ins:
                col = x[:, ch:ch + 1]
                for p in ins:
                    col = p.process(col, self.fs)
                x[:, ch] = col[:, 0]
        if direct_out is not None:
            direct_out[:] = x
        if self.focus is not None and 0 <= self.focus < self.nch:
            self.focus_ring.write(x[:, self.focus])
        np.maximum(self.m_post, np.abs(x).max(axis=0) * post, out=self.m_post)
        out = x @ mix
        if c["any_send"]:
            sends = x @ sends_m  # (frames, 4)
            for i, fx in enumerate(self.fx):
                if fx is None or c["fx_ret"][i] == 0.0:
                    continue
                s = sends[:, i]
                inp = np.stack([s, s]).astype(np.float32)
                y = fx.process(inp, self.fs, reset=False).T * c["fx_ret"][i]
                self.m_fx[i] = max(self.m_fx[i], float(np.abs(y).max()))
                out += y
        out = out.astype(np.float32)
        self.mfilters.process(out)
        self.mdyn.process(out)
        dsp.saturate(out, c["drive"])
        dsp.stereo_width(out, c["width"])
        for p in self.minserts:
            out = p.process(out, self.fs)
        out *= master_g
        self.limiter.process(out)
        self.loud.process(out)
        np.maximum(self.m_master, np.abs(out).max(axis=0), out=self.m_master)
        return out
