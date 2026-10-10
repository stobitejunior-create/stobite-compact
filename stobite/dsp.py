"""DSP building blocks. Everything is vectorised across channels so 48 inputs
stay well inside the audio callback budget.

Shapes: audio blocks are (frames, channels) float32.
"""
import math
import numpy as np

IDENTITY = np.array([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])

def _load_kernel():
    """SciPy's compiled biquad kernel, loaded on its own. Importing scipy.signal
    would pull in ~65 MB of modules we never use."""
    try:
        import glob
        import importlib.machinery
        import importlib.util
        import os
        import scipy
        hits = glob.glob(os.path.join(os.path.dirname(scipy.__file__), "signal", "_sosfilt*.so")) + \
            glob.glob(os.path.join(os.path.dirname(scipy.__file__), "signal", "_sosfilt*.pyd"))
        if hits:
            loader = importlib.machinery.ExtensionFileLoader("_sosfilt", hits[0])
            spec = importlib.util.spec_from_file_location("_sosfilt", hits[0], loader=loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
            return mod._sosfilt
    except Exception:
        pass
    try:  # fall back to the normal import
        from scipy.signal._sosfilt import _sosfilt
        return _sosfilt
    except Exception:  # pragma: no cover
        return None


_sos_kernel = _load_kernel()


def _scipy_signal():
    from scipy import signal  # only if the fast kernel is unavailable
    return signal


def sosfilt_multi(sos, x, zi):
    """Filter a (frames, n) block, one channel per column. zi: (n, sections, 2), updated in place."""
    if _sos_kernel is not None:
        xt = np.array(x.T, dtype=np.float64, order="C", copy=True)  # the kernel filters in place
        _sos_kernel(np.ascontiguousarray(sos, dtype=np.float64), xt, zi)
        return xt.T
    out = np.empty(x.shape, dtype=np.float64)
    for c in range(x.shape[1]):
        out[:, c], zi[c] = _scipy_signal().sosfilt(sos, x[:, c], zi=zi[c])
    return out


# 4x oversampling filter for true-peak detection, designed once
def _kaiser_lowpass(taps, cutoff, beta):
    n = np.arange(taps) - (taps - 1) / 2
    h = 2 * cutoff * np.sinc(2 * cutoff * n) * np.kaiser(taps, beta)
    return h / h.sum()


_TP_H = _kaiser_lowpass(48, 0.125, 6.0) * 4.0       # 4x interpolation filter
_TP_PHASES = [_TP_H[p::4] for p in range(4)]        # polyphase: one short filter per phase


TP_HIST = len(_TP_PHASES[0])   # samples of history the interpolation filter needs


def true_peak(x, hist=None):
    """Per-sample true-peak envelope (max over the 4 interpolated phases), x: (frames, ch).
    hist: the previous block's last TP_HIST samples (updated in place). Without it each block is
    measured as if silence came before it, which misreads the first few samples (up to ~1 dB high)."""
    frames = x.shape[0]
    xx = x if hist is None else np.concatenate([hist, x])
    off = xx.shape[0] - frames
    env = np.abs(x).max(axis=1)
    for ph in _TP_PHASES:
        for c in range(x.shape[1]):
            y = np.convolve(xx[:, c], ph)[off:off + frames]
            np.maximum(env, np.abs(y), out=env)
    if hist is not None:
        if frames >= len(hist):
            hist[:] = x[-len(hist):]
        else:
            hist[:] = np.concatenate([hist[frames:], x])
    return env


def sosfilt_fast(sos, x, zi):
    """Filter a 1-D float block in place-style; zi is (sections, 2) and is updated. Returns y."""
    if _sos_kernel is not None:
        y = np.ascontiguousarray(x, dtype=np.float64)[None, :].copy()
        z = zi[None, :, :]
        _sos_kernel(np.ascontiguousarray(sos, dtype=np.float64), y, z)
        zi[:] = z[0]
        return y[0]
    y, zi[:] = _scipy_signal().sosfilt(sos, x, zi=zi)
    return y

# ---------------------------------------------------------------- biquads (RBJ cookbook)

def _norm(b0, b1, b2, a0, a1, a2):
    return np.array([b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0])


def biquad(kind, freq, gain_db, q, fs):
    freq = float(min(max(freq, 10.0), fs * 0.49))
    q = float(max(q, 0.05))
    w0 = 2 * math.pi * freq / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    A = 10 ** (gain_db / 40)
    if kind == "bell":
        return _norm(1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A)
    if kind == "lowshelf":
        sa = 2 * math.sqrt(A) * alpha
        return _norm(A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw),
                     A * ((A + 1) - (A - 1) * cw - sa), (A + 1) + (A - 1) * cw + sa,
                     -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa)
    if kind == "highshelf":
        sa = 2 * math.sqrt(A) * alpha
        return _norm(A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw),
                     A * ((A + 1) + (A - 1) * cw - sa), (A + 1) - (A - 1) * cw + sa,
                     2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa)
    if kind == "hp":
        return _norm((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)
    if kind == "lp":
        return _norm((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha)
    if kind == "notch":
        return _norm(1, -2 * cw, 1, 1 + alpha, -2 * cw, 1 - alpha)
    return IDENTITY.copy()


# Butterworth Qs per slope (cascaded biquads)
BW_Q = {12: (0.7071,), 24: (0.5412, 1.3066), 48: (0.5098, 0.6013, 0.9000, 2.5629)}
BW4_Q = BW_Q[24]


def _cut(kind, freq, slope, fs):
    return [biquad(kind, freq, 0, q, fs) for q in BW_Q.get(int(slope), BW_Q[24])]


def strip_sos(strip, fs):
    """Filter cascade for one strip: low cut, high cut, then the EQ bands.
    Band types: bell, lowshelf, highshelf, notch, hp, lp (hp/lp use the band's slope)."""
    secs = []
    hpf = strip.get("hpf", {})
    if hpf.get("on"):
        secs += _cut("hp", hpf["freq"], hpf.get("slope", 24), fs)
    lpf = strip.get("lpf", {})
    if lpf.get("on"):
        secs += _cut("lp", lpf["freq"], lpf.get("slope", 24), fs)
    eq = strip.get("eq", {})
    if eq.get("on", True):
        for b in eq.get("bands", []):
            if not b.get("on", True):
                continue
            t = b.get("type", "bell")
            if t in ("hp", "lp"):
                secs += _cut(t, b["freq"], b.get("slope", 12), fs)
            elif abs(b.get("gain", 0)) > 0.01 or t == "notch":
                secs.append(biquad(t, b["freq"], b.get("gain", 0), b.get("q", 1.0), fs))
    if not secs:
        return None, False
    return np.array(secs), True


class FilterBank:
    """Per-channel IIR cascade (any number of sections) with persistent state."""

    def __init__(self, nch):
        self.nch = nch
        self.zi = [None] * nch
        self.sos = [None] * nch

    def set(self, ch, sos, active):
        if not active:
            self.sos[ch] = None
            return
        if self.zi[ch] is None or self.zi[ch].shape[0] != sos.shape[0]:
            self.zi[ch] = np.zeros((sos.shape[0], 2))
        self.sos[ch] = sos

    def process(self, x, skip=None):
        """skip: optional boolean mask of channels to leave alone (silent ones)."""
        for c, sos in enumerate(self.sos):
            if sos is not None and (skip is None or not skip[c]):
                x[:, c] = sosfilt_fast(sos, x[:, c], self.zi[c])
        return x


# ---------------------------------------------------------------- dynamics

SUB = 32  # samples per gain-computer step (0.67 ms at 48 kHz)


def _db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-9))


def _tc(ms, fs):
    return np.exp(-SUB / (fs * np.maximum(ms, 0.05) / 1000.0))


class Dynamics:
    """Compressor + gate + limiter for N channels, sharing one vectorised
    envelope engine. Parameters are arrays of length N; disabled units use
    neutral values so no branching per channel is needed."""

    def __init__(self, nch, fs):
        self.nch, self.fs = nch, fs
        self.comp_gr = np.zeros(nch)      # current gain reduction in dB (>=0)
        self.gate_gr = np.zeros(nch)
        self.comp_prev = np.ones(nch)     # last linear gain (for interpolation)
        self.gate_prev = np.ones(nch)
        self.p = None
        self.set_params([{} for _ in range(nch)])

    def set_params(self, strips):
        n = self.nch
        g = lambda k, sub, d: np.array([float(s.get(k, {}).get(sub, d)) for s in strips])
        on = lambda k: np.array([bool(s.get(k, {}).get("on")) for s in strips])
        fs = self.fs
        self.p = dict(
            c_on=on("comp"), c_thr=g("comp", "thr", -18), c_ratio=np.maximum(g("comp", "ratio", 3), 1.0),
            c_knee=np.maximum(g("comp", "knee", 6), 0.01), c_att=_tc(g("comp", "att", 10), fs),
            c_rel=_tc(g("comp", "rel", 150), fs), c_make=10 ** (g("comp", "makeup", 0) / 20),
            c_mix=np.clip(g("comp", "mix", 100) / 100, 0, 1), c_range=np.abs(g("comp", "range", 60)),
            g_on=on("gate"), g_thr=g("gate", "thr", -50), g_range=np.abs(g("gate", "range", 40)),
            g_att=_tc(g("gate", "att", 1), fs), g_rel=_tc(g("gate", "rel", 120), fs),
        )
        self.any_comp = bool(self.p["c_on"].any())
        self.any_gate = bool(self.p["g_on"].any())
        self.any_mix = bool((self.p["c_on"] & (self.p["c_mix"] < 0.999)).any())

    @staticmethod
    def _smooth(target, state, att, rel):
        # target, out: (nsub, N); attack when reduction increases
        out = np.empty_like(target)
        for k in range(target.shape[0]):
            t = target[k]
            coef = np.where(t > state, att, rel)
            state = t + coef * (state - t)
            out[k] = state
        return out, state

    @staticmethod
    def _apply(x, lin, prev):
        nsub = lin.shape[0]
        start = np.vstack([prev[None, :], lin[:-1]])
        ramp = (np.arange(1, SUB + 1) / SUB)[None, :, None]
        gains = start[:, None, :] + (lin - start)[:, None, :] * ramp
        x[: nsub * SUB] *= gains.reshape(nsub * SUB, -1).astype(np.float32)
        if x.shape[0] > nsub * SUB:
            x[nsub * SUB:] *= lin[-1].astype(np.float32)
        return lin[-1]

    def process(self, x, detect=None):
        """detect: optional sidechain signal (same shape) that drives the compressor."""
        if not (self.any_comp or self.any_gate):
            return x
        frames = x.shape[0]
        nsub = max(frames // SUB, 1)
        seg = np.abs(x[: nsub * SUB]).reshape(nsub, -1, x.shape[1]).max(axis=1)
        lvl = _db(seg)
        sc = None
        if detect is not None:
            sc = _db(np.abs(detect[: nsub * SUB]).reshape(nsub, -1, detect.shape[1]).max(axis=1))
        p = self.p
        if self.any_gate:
            tgt = np.where(lvl < p["g_thr"], p["g_range"], 0.0) * p["g_on"]
            # gate "attack" is opening (reduction falling) -> swap coefs
            red, self.gate_gr = self._smooth(tgt, self.gate_gr, p["g_rel"], p["g_att"])
            lin = 10 ** (-red / 20)
            self.gate_prev = self._apply(x, lin, self.gate_prev)
            lvl = lvl - red
        if self.any_comp:
            over = (sc if sc is not None else lvl) - p["c_thr"]
            k = p["c_knee"]
            slope = 1 - 1 / p["c_ratio"]
            tgt = np.where(over <= -k / 2, 0.0,
                           np.where(over >= k / 2, over * slope, slope * (over + k / 2) ** 2 / (2 * k)))
            tgt = np.minimum(tgt, p["c_range"]) * p["c_on"]
            red, self.comp_gr = self._smooth(tgt, self.comp_gr, p["c_att"], p["c_rel"])
            lin = 10 ** (-red / 20) * np.where(p["c_on"], p["c_make"], 1.0)
            if self.any_mix:  # parallel ("New York") compression: blend dry back in
                dry = x.copy()
                self.comp_prev = self._apply(x, lin, self.comp_prev)
                m = np.where(p["c_on"], p["c_mix"], 1.0).astype(np.float32)
                x *= m
                x += dry * (1 - m)
            else:
                self.comp_prev = self._apply(x, lin, self.comp_prev)
        return x


class Limiter:
    """Fast peak limiter for a stereo bus followed by a safety clip."""

    def __init__(self, fs):
        self.fs = fs
        self.state = np.zeros(2)
        self.prev = np.ones(2)
        self.on, self.ceiling = True, -0.3
        self.rel = _tc(80, fs)
        self.gr = 0.0

    def process(self, x):
        if not self.on:
            return x
        c = 10 ** (self.ceiling / 20)
        frames = x.shape[0]
        nsub = max(frames // SUB, 1)
        lvl = _db(np.abs(x[: nsub * SUB]).reshape(nsub, -1, 2).max(axis=1))
        tgt = np.maximum(lvl - self.ceiling, 0.0)
        tgt = np.repeat(tgt.max(axis=1, keepdims=True), 2, axis=1)  # linked
        red, self.state = Dynamics._smooth(tgt, self.state, 0.0, self.rel)
        self.prev = Dynamics._apply(x, 10 ** (-red / 20), self.prev)
        self.gr = float(red.max()) if red.size else 0.0
        np.clip(x, -c, c, out=x)
        return x


def pan_gains(pan):
    """Constant-power pan, pan in [-1, 1] -> (L, R)."""
    a = (np.clip(pan, -1, 1) + 1) * math.pi / 4
    return np.cos(a), np.sin(a)


def db_to_lin(db):
    return 0.0 if db <= -89.9 else 10 ** (db / 20)


# ---------------------------------------------------------------- mastering

def saturate(x, drive_db):
    """Smooth tape-style saturation; level-compensated so it adds colour, not volume."""
    if drive_db <= 0.05:
        return x
    g = 10 ** (drive_db / 20)
    np.tanh(x * g, out=x)
    x *= 1.0 / g  # unity gain for quiet material; peaks get rounded off
    return x


def stereo_width(x, width_pct):
    if abs(width_pct - 100) < 0.5:
        return x
    w = width_pct / 100.0
    m = (x[:, 0] + x[:, 1]) * 0.5
    s = (x[:, 0] - x[:, 1]) * 0.5 * w
    x[:, 0] = m + s
    x[:, 1] = m - s
    return x


class Loudness:
    """EBU R128 / ITU BS.1770 loudness: momentary (400 ms), short-term (3 s),
    integrated (gated) plus phase correlation and a spectrum ring buffer."""

    def __init__(self, fs):
        self.fs = fs
        self.sos = self.k_weighting(fs)
        self.zi = np.zeros((2, 2, 2))
        self.bin_len = fs // 10
        self.reset()
        self.ring = np.zeros(8192, np.float32)
        self.ring_pos = 0

    @staticmethod
    def k_weighting(fs):
        # exact BS.1770 pre-filter + RLB high-pass at any sample rate (libebur128 design)
        f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
        K = math.tan(math.pi * f0 / fs)
        Vh = 10 ** (G / 20)
        Vb = Vh ** 0.4996667741545416
        a0 = 1 + K / Q + K * K
        shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
                 1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
        f0, Q = 38.13547087602444, 0.5003270373238773
        K = math.tan(math.pi * f0 / fs)
        d = 1 + K / Q + K * K
        hp = [1.0, -2.0, 1.0, 1.0, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]
        return np.array([shelf, hp])

    def reset(self):
        self.acc = 0.0
        self.acc_n = 0
        self.bins = []          # 100 ms mean-square powers
        self.blocks = []        # 400 ms block powers for integration
        self.short_hist = []    # 3 s short-term powers every 100 ms (loudness range)
        self.tp_max = 0.0       # highest true peak since reset (linear)
        self.last_tp = 0.0
        self.corr = [0.0, 0.0, 0.0]

    def process(self, x):
        if len(x):
            h = getattr(self, "_tp_hist", None)
            if h is None or h.shape[1] != x.shape[1]:
                h = self._tp_hist = np.zeros((TP_HIST, x.shape[1]), np.float32)
            self.last_tp = float(true_peak(x, h).max())
            self.tp_max = max(self.tp_max, self.last_tp)
        k = sosfilt_multi(self.sos, x, self.zi)
        p = (k ** 2).sum(axis=1)
        self.corr[0] += float((x[:, 0] * x[:, 1]).sum())
        self.corr[1] += float((x[:, 0] ** 2).sum())
        self.corr[2] += float((x[:, 1] ** 2).sum())
        i = 0
        n = len(p)
        while i < n:
            take = min(self.bin_len - self.acc_n, n - i)
            self.acc += float(p[i:i + take].sum())
            self.acc_n += take
            i += take
            if self.acc_n >= self.bin_len:
                self.bins.append(self.acc / self.bin_len)
                self.acc, self.acc_n = 0.0, 0
                if len(self.bins) >= 4:
                    self.blocks.append(sum(self.bins[-4:]) / 4)
                if len(self.bins) >= 30:
                    self.short_hist.append(sum(self.bins[-30:]) / 30)
                del self.bins[:-30]
        mono = (x[:, 0] + x[:, 1]) * 0.5
        m = len(mono)
        if m >= len(self.ring):
            self.ring[:] = mono[-len(self.ring):]
            self.ring_pos = 0
        else:
            end = self.ring_pos + m
            if end <= len(self.ring):
                self.ring[self.ring_pos:end] = mono
            else:
                cut = len(self.ring) - self.ring_pos
                self.ring[self.ring_pos:] = mono[:cut]
                self.ring[:m - cut] = mono[cut:]
            self.ring_pos = end % len(self.ring)

    @staticmethod
    def lufs(power):
        return -0.691 + 10 * math.log10(power) if power > 1e-12 else -99.0

    def integrated(self):
        b = np.asarray(self.blocks)
        if not len(b):
            return -99.0
        b = b[b > 10 ** ((-70 + 0.691) / 10)]
        if not len(b):
            return -99.0
        rel = self.lufs(float(b.mean())) - 10
        b = b[b > 10 ** ((rel + 0.691) / 10)]
        return self.lufs(float(b.mean())) if len(b) else -99.0

    def silence(self, n):
        """Account for n silent samples without running any filters (used while idle)."""
        self.last_tp = 0.0
        i = 0
        while i < n:
            take = min(self.bin_len - self.acc_n, n - i)
            self.acc_n += take
            i += take
            if self.acc_n >= self.bin_len:
                self.bins.append(self.acc / self.bin_len)
                self.acc, self.acc_n = 0.0, 0
                if len(self.bins) >= 4:
                    self.blocks.append(sum(self.bins[-4:]) / 4)
                if len(self.bins) >= 30:
                    self.short_hist.append(sum(self.bins[-30:]) / 30)
                del self.bins[:-30]

    def lra(self):
        """EBU Tech 3342 loudness range: spread of gated short-term loudness (10th-95th percentile)."""
        st = np.asarray(self.short_hist)
        if len(st) < 20:
            return 0.0
        st = st[st > 10 ** ((-70 + 0.691) / 10)]
        if not len(st):
            return 0.0
        rel = self.lufs(float(st.mean())) - 20
        st = st[st > 10 ** ((rel + 0.691) / 10)]
        if len(st) < 2:
            return 0.0
        lu = -0.691 + 10 * np.log10(st)
        return float(np.percentile(lu, 95) - np.percentile(lu, 10))

    def read(self):
        m = self.lufs(sum(self.bins[-4:]) / 4) if len(self.bins) >= 4 else -99.0
        s = self.lufs(sum(self.bins) / len(self.bins)) if len(self.bins) >= 10 else -99.0
        c0, c1, c2 = self.corr
        corr = c0 / math.sqrt(c1 * c2) if c1 > 1e-9 and c2 > 1e-9 else 0.0
        self.corr = [0.0, 0.0, 0.0]
        return m, s, corr

    def spectrum(self, bands=64):
        buf = np.roll(self.ring, -self.ring_pos)[-4096:]
        spec = np.abs(np.fft.rfft(buf * np.hanning(len(buf)))) / (len(buf) / 4)
        freqs = np.fft.rfftfreq(len(buf), 1 / self.fs)
        edges = np.geomspace(20, 20000, bands + 1)
        idx = np.searchsorted(freqs, edges)
        out = []
        for a, b in zip(idx[:-1], idx[1:]):
            v = spec[a:max(b, a + 1)].max() if a < len(spec) else 0
            out.append(round(20 * math.log10(v + 1e-9), 1))
        return out


class Ring:
    """Mono ring buffer feeding an analyser (written from the audio thread)."""

    def __init__(self, n):
        self.buf = np.zeros(n, np.float32)
        self.pos = 0

    def write(self, mono):
        n, size = len(mono), len(self.buf)
        if n >= size:
            self.buf[:] = mono[-size:]
            self.pos = 0
            return
        end = self.pos + n
        if end <= size:
            self.buf[self.pos:end] = mono
        else:
            cut = size - self.pos
            self.buf[self.pos:] = mono[:cut]
            self.buf[:n - cut] = mono[cut:]
        self.pos = end % size

    def spectrum(self, fs, bands=96):
        buf = np.roll(self.buf, -self.pos)
        spec = np.abs(np.fft.rfft(buf * np.hanning(len(buf)))) / (len(buf) / 4)
        freqs = np.fft.rfftfreq(len(buf), 1 / fs)
        idx = np.searchsorted(freqs, np.geomspace(20, 20000, bands + 1))
        return [round(20 * math.log10((spec[a:max(b, a + 1)].max() if a < len(spec) else 0) + 1e-9), 1)
                for a, b in zip(idx[:-1], idx[1:])]


class DeEsser:
    """Broadband de-esser: a high-passed sidechain drives fast gain reduction,
    capped at `range` dB. Only channels with it switched on cost anything."""

    def __init__(self, nch, fs):
        self.nch, self.fs = nch, fs
        self.gr = np.zeros(nch)
        self.prev = np.ones(nch)
        self.side = {}  # ch -> (sos, zi)
        self.att, self.rel = _tc(0.5, fs), _tc(60, fs)
        self.on = np.zeros(nch, bool)
        self.thr = np.full(nch, -28.0)
        self.rng = np.full(nch, 8.0)

    def set_params(self, strips):
        side = {}
        for c, s in enumerate(strips):
            d = s.get("deess") or {}
            self.on[c] = bool(d.get("on"))
            self.thr[c] = float(d.get("thr", -28))
            self.rng[c] = float(d.get("range", 8))
            if self.on[c]:
                sos = np.vstack([biquad("hp", d.get("freq", 6500), 0, BW4_Q[0], self.fs),
                                 biquad("hp", d.get("freq", 6500), 0, BW4_Q[1], self.fs)])
                old = self.side.get(c)
                side[c] = (sos, old[1] if old is not None else np.zeros((2, 2)))
        self.side = side

    def process(self, x):
        if not self.side:
            if self.gr.any():
                self.gr[:] = 0
            return x
        frames = x.shape[0]
        nsub = max(frames // SUB, 1)
        lvl = np.full((nsub, self.nch), -120.0)
        for c, (sos, zi) in self.side.items():
            y = sosfilt_fast(sos, x[:, c], zi)
            lvl[:, c] = _db(np.abs(y[: nsub * SUB]).reshape(nsub, SUB).max(axis=1))
        tgt = np.minimum(np.maximum(lvl - self.thr, 0.0) * 0.75, self.rng) * self.on
        red, self.gr = Dynamics._smooth(tgt, self.gr, self.att, self.rel)
        self.prev = Dynamics._apply(x, 10 ** (-red / 20), self.prev)
        return x
