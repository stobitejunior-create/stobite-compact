"""Insert effects for any channel or bus: reverb, delay, chorus, flanger, phaser, tremolo,
auto-filter, distortion, bitcrusher, pitch shift and a gain utility.

Each one is a chain module like the EQ or compressor: add it anywhere in a chain, as often as
you like. Most are built on Spotify's pedalboard (already used for plug-ins), with a wet/dry
"mix" so they can be used subtly. Channels are mono, buses stereo.
"""
import functools
import math

import numpy as np

try:
    import pedalboard as pb
except Exception:  # pragma: no cover - optional
    pb = None

KINDS = ("trigger", "proximity", "denoise", "reverb", "delay", "chorus", "flanger", "phaser", "tremolo", "autofilter", "distortion", "bitcrush", "pitch", "gain")

NOTE_BEATS = {"1/2": 2.0, "1/4": 1.0, "1/4d": 1.5, "1/8": 0.5, "1/8d": 0.75, "1/8t": 1 / 3, "1/16": 0.25}

tempo_fn = lambda: 120.0   # set by the mixer: the session tempo, for synced delays and tremolos


class Denoiser:
    """Removes steady background noise (hiss, hum, air-con, buzz) while leaving speech and music.

    Short overlapping FFT frames; in every frequency band the noise floor is tracked continuously
    (it follows the quietest level and creeps up slowly, so it re-learns if the noise changes).
    Bands near that floor are turned down by up to `reduction` dB; the gain is smoothed in time
    and across neighbouring bands so it doesn't warble. Adds 8 ms of delay."""

    N, HOP = 512, 128

    def __init__(self, fs, nch):
        self.fs, self.nch = fs, nch
        n = self.N
        self.win = np.sqrt(np.hanning(n + 1)[:n]).astype(np.float64)   # sqrt-Hann: analysis x synthesis = Hann
        self.inbuf = np.zeros((nch, n))
        self.outbuf = np.zeros((nch, n))
        self.pending = np.zeros((nch, 0))
        self.ready = np.zeros((nch, 0))
        bins = n // 2 + 1
        self.noise = np.full((nch, bins), 1.0)
        self.gain = np.ones((nch, bins))
        self.frames_seen = 0
        self.reduction, self.sens = 12.0, 1.0
        self.smooth = None
        self.started = False

    def set(self, p):
        self.reduction = float(np.clip(p.get("reduction", 12), 0, 40))
        self.sens = float(np.clip(p.get("sensitivity", 50), 0, 100)) / 50.0   # 1.0 = normal

    def _frame(self, frame):
        X = np.fft.rfft(frame * self.win, axis=1)
        mag = np.abs(X)
        # noise floor per band: smooth the level over ~40 ms, follow its quiet points, and let it
        # creep back up slowly (~1 dB/s) so it re-learns when the noise changes
        self.smooth = mag if self.smooth is None else 0.7 * self.smooth + 0.3 * mag
        up = 10 ** (1.0 / 20 * self.HOP / self.fs)
        self.noise = np.where(self.smooth < self.noise, self.smooth, self.noise * up)
        self.frames_seen += 1
        floor = 10 ** (-self.reduction / 20)
        # the smoothed minimum sits below the average noise: x1.6 brings it back up to the average
        level = np.maximum(self.smooth, 0.5 * mag)              # the smoothed level, but let real onsets through at once
        snr = level / np.maximum(self.noise * 1.6 * (1.0 + 1.5 * self.sens), 1e-12)
        g = np.clip(snr - 1.0, 0.0, 1.0)                      # 0 at the threshold, 1 at twice it
        g = floor + (1 - floor) * g
        g = np.convolve(g.ravel(), np.ones(3) / 3, "same").reshape(g.shape)   # smooth across bands
        att = g > self.gain                                   # open fast, close more gently
        self.gain = np.where(att, 0.4 * self.gain + 0.6 * g, 0.75 * self.gain + 0.25 * g)
        if self.frames_seen < 40:                             # learning the room for the first ~100 ms
            self.gain[:] = 1.0
        return np.fft.irfft(X * self.gain, self.N, axis=1) * self.win

    def process(self, x):
        """x: (frames, ch). Output delayed by N samples."""
        xin = np.concatenate([self.pending, x.T.astype(np.float64)], axis=1)
        out_parts = []
        pos = 0
        while xin.shape[1] - pos >= self.HOP:
            hop = xin[:, pos:pos + self.HOP]
            pos += self.HOP
            self.inbuf = np.concatenate([self.inbuf[:, self.HOP:], hop], axis=1)
            y = self._frame(self.inbuf)
            self.outbuf += y
            out_parts.append(self.outbuf[:, :self.HOP] * (self.HOP * 2 / self.N))   # Hann OLA at 75% overlap
            self.outbuf = np.concatenate([self.outbuf[:, self.HOP:], np.zeros((self.nch, self.HOP))], axis=1)
        self.pending = xin[:, pos:]
        ready = np.concatenate([self.ready] + out_parts, axis=1) if out_parts else self.ready
        frames = x.shape[0]
        if ready.shape[1] < frames:                          # the very start: pad with silence
            ready = np.concatenate([np.zeros((self.nch, frames - ready.shape[1])), ready], axis=1)
        y, self.ready = ready[:, :frames], ready[:, frames:]
        return y.T.astype(np.float32)


# ---------------------------------------------------------------- drum samples (made here: nothing to license)

def _env(n, fs, decay_ms):
    return np.exp(-np.arange(n) / (fs * decay_ms / 1000.0))


def _sweep(fs, f0, f1, ms, decay_ms):
    n = int(fs * ms / 1000)
    t = np.arange(n) / fs
    f = f1 + (f0 - f1) * np.exp(-t * 40)                  # pitch drops quickly, like a struck drum head
    return np.sin(2 * np.pi * np.cumsum(f) / fs) * _env(n, fs, decay_ms)


def _noise(fs, ms, decay_ms, lo, hi, seed):
    n = int(fs * ms / 1000)
    rng = np.random.default_rng(seed)
    X = np.fft.rfft(rng.standard_normal(n))
    fr = np.fft.rfftfreq(n, 1 / fs)
    X[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(X, n) / 3 * _env(n, fs, decay_ms)


def _metal(fs, ms, decay_ms, lo, hi, seed, base=1.0):
    """Cymbal-like: six inharmonic square waves (the classic metallic cluster) plus noise, band-limited."""
    n = int(fs * ms / 1000)
    t = np.arange(n) / fs
    y = sum(np.sign(np.sin(2 * np.pi * f * base * t + k)) for k, f in enumerate((205.3, 304.4, 369.6, 522.7, 540.0, 800.0)))
    y = y / 6 + np.random.default_rng(seed).standard_normal(n) * 0.6
    X = np.fft.rfft(y)
    fr = np.fft.rfftfreq(n, 1 / fs)
    X[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(X, n) * _env(n, fs, decay_ms)


@functools.lru_cache(maxsize=4)
def builtin_samples(fs):
    """name -> (label, mono float32 sample)."""
    def fit(*parts):
        n = max(len(p) for p in parts)
        y = np.zeros(n)
        for p in parts:
            y[: len(p)] += p
        return (y / (np.abs(y).max() + 1e-9) * 0.9).astype(np.float32)
    click = _noise(fs, 6, 1.5, 2000, 12000, 1)
    return {
        "kick-punchy": ("Kick: punchy", fit(_sweep(fs, 160, 52, 450, 220), click * 0.6)),
        "kick-deep": ("Kick: deep & long", fit(_sweep(fs, 110, 44, 800, 420), click * 0.3)),
        "kick-tight": ("Kick: tight", fit(_sweep(fs, 190, 60, 260, 110), click * 0.9)),
        "snare-tight": ("Snare: tight", fit(_sweep(fs, 260, 190, 200, 70) * 0.8, _noise(fs, 260, 110, 1800, 9000, 2))),
        "snare-fat": ("Snare: fat", fit(_sweep(fs, 220, 165, 320, 120), _noise(fs, 420, 190, 1200, 8000, 3) * 1.2)),
        "snare-rim": ("Rimshot", fit(_sweep(fs, 520, 480, 120, 30), _noise(fs, 200, 60, 2500, 11000, 4) * 0.8)),
        "tom-high": ("Tom: high", fit(_sweep(fs, 230, 185, 500, 220), click * 0.2)),
        "tom-mid": ("Tom: mid", fit(_sweep(fs, 170, 135, 600, 260), click * 0.2)),
        "tom-floor": ("Tom: floor", fit(_sweep(fs, 120, 88, 800, 330), click * 0.2)),
        "hat-closed": ("Hi-hat: closed", fit(_metal(fs, 120, 30, 6000, 16000, 5, 1.6))),
        "hat-open": ("Hi-hat: open", fit(_metal(fs, 700, 260, 5000, 16000, 6, 1.6))),
        "crash": ("Crash", fit(_metal(fs, 2600, 900, 3000, 16000, 7, 1.1), _noise(fs, 2600, 700, 4000, 14000, 8) * 0.8)),
        "ride": ("Ride", fit(_metal(fs, 1800, 700, 2500, 12000, 9, 1.3) * 0.6, _sweep(fs, 3200, 3150, 900, 400) * 0.35)),
        "splash": ("Splash", fit(_metal(fs, 900, 300, 4500, 16000, 10, 1.5), _noise(fs, 900, 250, 5000, 15000, 11) * 0.6)),
        "china": ("China", fit(np.tanh(3 * _metal(fs, 1800, 600, 2000, 13000, 12, 0.9)))),
    }


_SAMPLE_CACHE = {}


def load_sample(spec, fs):
    """'builtin:kick-punchy' or 'user:My Kick.wav' -> float32 mono at fs (cached)."""
    key = (spec, fs)
    if key in _SAMPLE_CACHE:
        return _SAMPLE_CACHE[key]
    y = None
    if spec.startswith("builtin:"):
        b = builtin_samples(fs).get(spec[8:])
        y = b[1] if b else None
    elif spec.startswith("user:"):
        import os
        import soundfile as sf
        from .session import home_dir
        p = os.path.join(home_dir(), "Samples", os.path.basename(spec[5:]))
        if os.path.exists(p):
            d, sr = sf.read(p, dtype="float32", always_2d=True)
            d = d.mean(axis=1)
            if sr != fs:     # simple resample: good enough for one-shot drum samples
                d = np.interp(np.arange(0, len(d), sr / fs), np.arange(len(d)), d).astype(np.float32)
            y = d / (np.abs(d).max() + 1e-9) * 0.9
    if y is not None:
        _SAMPLE_CACHE[key] = y
    return y


def trigger_latency(p, fs):
    """The trigger's confirm wait in samples (a whole number of 16-sample steps)."""
    ms = float(np.clip(p.get("confirm", 0) or 0, 0, 80))
    return int(fs * ms / 1000) // 16 * 16


class Trigger:
    """Drum trigger: finds each hit on a drum mic and plays a sample with it.

    Detection runs on a band-limited copy (so kick spill doesn't fire the snare), with a threshold
    set by Sensitivity and a retrigger time that stops one hit firing twice. Velocity follows how
    hard the drum was hit (Dynamics), and Mix blends the sample with the real drum."""

    def __init__(self, fs):
        self.fs = fs
        self.voices = []           # [sample, position, gain]
        self.since = 10 ** 9       # samples since the last hit
        self.env = 0.0
        self.armed = True
        self.hits = 0
        self.det = None
        self.det_key = None
        self.flash = 0.0

    def _detector(self, lo, hi):
        if pb is None:
            return None
        if self.det_key != (lo, hi):
            # steep (each filter twice): kick spill in a snare mic stays well under the threshold
            self.det = pb.Pedalboard([pb.HighpassFilter(float(lo)), pb.HighpassFilter(float(lo)),
                                      pb.LowpassFilter(float(hi)), pb.LowpassFilter(float(hi))])
            self.det_key = (lo, hi)
        return self.det

    def process(self, x, p):
        n = len(x)
        fs = self.fs
        mono = x[:, 0].astype(np.float32)
        det = self._detector(p.get("det_lo", 30), p.get("det_hi", 8000))
        d = det(mono[None, :], fs, reset=False)[0] if det is not None else mono
        thr = 10 ** ((-55.0 + (100.0 - float(p.get("sensitivity", 50))) * 0.45) / 20)   # 50 -> about -32 dBFS
        retrig = int(fs * float(p.get("retrigger", 60)) / 1000)
        a = np.abs(d)
        sub = 16
        m = len(a) // sub
        env = a[: m * sub].reshape(m, sub).max(axis=1) if m else np.zeros(0)
        samples = [s for s in (p.get("sample"), p.get("sample2")) if s]
        hits = []
        rel = math.exp(-sub / (fs * 0.04))                  # the drum's recent level falls away over ~40 ms
        lag = max(1, int(fs * 0.008 / sub))
        if len(getattr(self, "hist", ())) != lag:
            self.hist, self.hi = [0.0] * lag, 0
        # Confirm ring (cymbals): only a hit still ringing a moment later counts. A cymbal rings for
        # seconds, snare / kick spill in an overhead dies in tens of ms. The sound is delayed by the
        # same time (and the mixer compensates), so the sample still lands on the hit.
        wait = trigger_latency(p, fs) // sub
        if not hasattr(self, "cands"):
            self.cands, self.kabs = [], 0
        for k, v in enumerate(env):
            self.since += sub
            self.kabs += 1
            self.ring = (getattr(self, "ring", [])[-5:]) + [v]      # the last ~1.5 ms
            if self.cands and self.cands[0][0] <= self.kabs:
                due, pk0 = self.cands.pop(0)
                if max(self.ring) >= 0.45 * pk0 and self.since >= retrig:
                    hits.append((k * sub, pk0))
                    self.since = 0          # only a confirmed hit holds off the next one
            # a hit = over the threshold AND a sudden jump above the drum's recent level (a ringing
            # tail never jumps, so it can't fire again), and not too soon after the last one
            # compared with the level ~8 ms ago: a low kick takes a few ms to rise through the detector
            past = self.hist[self.hi % lag]
            # (with Confirm ring the ring check weeds out spill, so a smaller jump is enough)
            if v > thr and v > past * (1.6 if wait else 2.5) and self.since >= retrig:
                pk = float(a[k * sub: k * sub + 96].max()) if k * sub < len(a) else v   # hit strength just after the onset
                # and within ~20 dB of this drum's own recent hard hits: spill from other drums is quieter
                # than that, a ghost note (about 12 dB down) still counts
                floor = getattr(self, "loudest", 0.0) * float(10 ** (-float(p.get("reject", 16)) / 20))
                if pk >= floor:
                    if wait:
                        if not self.cands or self.kabs - (self.cands[-1][0] - wait) >= lag:
                            self.cands.append([self.kabs + wait, pk])
                    else:
                        hits.append((k * sub, pk))
                        self.since = 0
            self.env = max(v, self.env * rel)
            self.hist[self.hi % lag] = self.env
            self.hi += 1
        dyn = float(np.clip(p.get("dynamics", 70), 0, 100)) / 100
        vol = 10 ** (float(p.get("volume", 0)) / 20)
        semis = float(p.get("tune", 0))
        for at, pk in hits:
            self.hits += 1
            self.flash = 1.0
            self.loudest = max(getattr(self, "loudest", 0.0) * 0.999, pk)
            vel = min(1.0, pk / max(self.loudest, thr * 4))      # relative to the hardest recent hits
            g = vol * ((1 - dyn) + dyn * vel)
            for j, spec in enumerate(samples):
                smp = load_sample(spec, fs)
                if smp is None:
                    continue
                if abs(semis) > 0.01:
                    r = 2 ** (semis / 12)
                    smp = np.interp(np.arange(0, len(smp), r), np.arange(len(smp)), smp).astype(np.float32)
                lvl = 1.0 if j == 0 else 10 ** (float(p.get("volume2", -6)) / 20)
                self.voices.append([smp, -at, g * lvl])
        out = np.zeros(n, np.float32)
        keep = []
        for vv in self.voices:
            smp, pos, g = vv
            start = max(0, -pos)                  # where in this block the sample begins
            src = max(0, pos)
            k = min(n - start, len(smp) - src)
            if k > 0:
                out[start:start + k] += smp[src:src + k] * g
            vv[1] = src + k if pos >= 0 else k
            if vv[1] < len(smp):
                keep.append(vv)
        self.voices = keep[-8:]                   # a few overlapping hits at most
        mix = float(np.clip(p.get("mix", 100), 0, 100)) / 100
        y = x.copy()
        dry = x[:, 0]
        D = trigger_latency(p, fs)
        if D:                                      # the real drum, delayed to match the confirm wait
            buf = getattr(self, "dbuf", None)
            if buf is None or len(buf) != D:
                buf = np.zeros(D, np.float32)
            cat = np.concatenate([buf, dry.astype(np.float32)])
            dry, self.dbuf = cat[:n], cat[n:]
        y[:, 0] = dry * (1 - mix) + out * mix
        if y.shape[1] > 1:
            y[:, 1:] = y[:, :1]
        return y

    def reading(self):
        v, self.flash = self.flash, 0.0          # held until the meters read it, so no hit is missed
        return 10.0 if v else 0.0


class Rider:
    """Vocal rider: moves the level up and down like an engineer riding the fader, so every word
    sits at the target level before any compressor. Quiet gaps (below the floor) are left alone,
    so breaths and room noise aren't pulled up."""

    def __init__(self, fs):
        self.fs = fs
        self.ms = 0.0          # running mean-square (~60 ms)
        self.gain = 0.0        # current ride in dB

    def process(self, x, p):
        n = len(x)
        mono = x.mean(axis=1).astype(np.float64)
        a = math.exp(-n / (self.fs * 0.06))
        self.ms = a * self.ms + (1 - a) * float(np.mean(mono ** 2))
        lvl = 10 * math.log10(self.ms + 1e-12) + 3.0
        rng = abs(float(p.get("range", 6)))
        g0 = self.gain
        if lvl > float(p.get("floor", -50)):
            want = float(np.clip(float(p.get("target", -20)) - lvl, -rng, rng))   # measured before the ride
            c = math.exp(-n / (self.fs * max(float(p.get("speed", 300)), 10) / 1000))
            self.gain = want + c * (self.gain - want)
        else:                  # a gap: drift back to 0 dB so room noise isn't pulled up for long
            self.gain *= math.exp(-n / (self.fs * 1.5))
        ramp = np.linspace(10 ** (g0 / 20), 10 ** (self.gain / 20), n, dtype=np.float32)
        return x * ramp[:, None]

    def reading(self):
        return round(self.gain, 1)


class BassEnhancer:
    """Psychoacoustic bass (like MaxxBass): adds harmonics of the lowest notes, so the ear hears
    the bass on phones, laptops and small speakers that can't play it. "Original" turns the real
    sub-bass down (for small speakers, or to clear headroom)."""

    def __init__(self, fs, nch):
        self.fs, self.nch = fs, nch
        self.key = None
        self.env = np.zeros(nch)

    def _build(self, f):
        f = float(np.clip(f, 40, 250))
        self.lp = pb.Pedalboard([pb.LowpassFilter(f), pb.LowpassFilter(f)])
        self.hp_orig = pb.Pedalboard([pb.HighpassFilter(f), pb.HighpassFilter(f)])
        # the new harmonics: from the cutoff up two octaves or so
        self.band = pb.Pedalboard([pb.HighpassFilter(f * 0.9), pb.HighpassFilter(f * 0.9), pb.LowpassFilter(f * 5)])
        self.key = f

    def process(self, x, p):
        if pb is None:
            return x
        f = float(p.get("freq", 90))
        if self.key != f:
            self._build(f)
        xt = x.T.astype(np.float32)
        low = self.lp(xt, self.fs, reset=False)
        # level-independent harmonic generator: normalise by the low end's envelope, shape, scale back
        n = xt.shape[1]
        a = math.exp(-n / (self.fs * 0.03))
        peak = np.abs(low).max(axis=1)
        self.env = np.maximum(peak, a * self.env + (1 - a) * peak)
        e = (self.env + 1e-4)[:, None].astype(np.float32)
        u = np.clip(low / e, -1, 1)
        # Chebyshev shaping: a note's 2nd and 3rd harmonics, with none of the note itself
        gen = (0.7 * (2 * u * u - 1) + 0.4 * (4 * u ** 3 - 3 * u)) * e
        h = self.band(gen.astype(np.float32), self.fs, reset=False)
        amt = float(np.clip(p.get("amount", 50), 0, 100)) / 100 * 1.4
        orig = 10 ** (float(np.clip(p.get("original", 0), -24, 0)) / 20)
        y = xt + h * amt
        if orig < 0.999:
            y = y - low * (1 - orig)
        return y.T

    def reading(self):
        return 0.0


class Proximity:
    """The bass boost a directional mic gives when the source is very close.
    "add": warmth as if the singer were right on the mic (a low shelf).
    "tame": watches the low end against the middle of the voice; when the singer leans in and it
    builds up (boom), the lows are turned down by as much as it rose, up to `amount` dB."""

    def __init__(self, fs, nch):
        self.fs, self.nch = fs, nch
        self.cut = 0.0
        self.base = None       # the usual low-to-mid balance of this voice (learned as it plays)
        self.shelf_g = None
        self._mk(0.0)
        # steep detectors (each filter twice) so the low band really is just the low band
        f_lo = pb.Pedalboard([pb.LowpassFilter(250.0), pb.LowpassFilter(250.0), pb.LowpassFilter(250.0)]) if pb else None
        f_mid = pb.Pedalboard([pb.HighpassFilter(800.0), pb.HighpassFilter(800.0), pb.LowpassFilter(3000.0), pb.LowpassFilter(3000.0)]) if pb else None
        self.det = (f_lo, f_mid)

    def _mk(self, gain):
        if pb is None:
            self.shelf = None
            return
        if self.shelf_g is None or abs(gain - self.shelf_g) > 0.05:
            if getattr(self, "shelf", None) is None:
                self.shelf = pb.LowShelfFilter(cutoff_frequency_hz=self.freq if hasattr(self, "freq") else 200.0, gain_db=gain, q=0.7)
            else:
                self.shelf.gain_db = gain
            self.shelf_g = gain

    def process(self, x, p):
        if pb is None:
            return x
        self.freq = float(p.get("freq", 200))
        self.shelf.cutoff_frequency_hz = self.freq
        amount = float(np.clip(p.get("amount", 6), 0, 18))
        if p.get("mode", "tame") == "add":
            self._mk(amount)
        else:
            m = x.mean(axis=1, keepdims=True).T.astype(np.float32)
            lo = self.det[0](m, self.fs, reset=False); mid = self.det[1](m, self.fs, reset=False)
            elo, emid = float(np.mean(lo ** 2)), float(np.mean(mid ** 2))
            if emid > 1e-7:                       # only while the voice is there
                k = len(x) / self.fs
                raw = 10 * np.log10((elo + 1e-12) / emid)
                self.r_s = raw if getattr(self, "r_s", None) is None else self.r_s + (raw - self.r_s) * min(1.0, k / 0.3)
                ratio = self.r_s                     # smoothed over ~0.3 s: single blocks jump around
                # the voice's normal balance: learned quickly when it gets less boomy, but only very
                # slowly (about a minute) when it gets more, so a singer leaning in counts as boom
                tc = 2.0 if self.base is None or ratio < self.base else 60.0
                self.base = ratio if self.base is None else self.base + (ratio - self.base) * min(1.0, k / tc)
                over = max(0.0, ratio - self.base - 1.0) * 1.5      # boom beyond normal (x1.5: a shelf only partly reaches the lowest notes)
                target = min(over, amount)
                rate = 0.35 if target > self.cut else 0.08
                self.cut += (target - self.cut) * min(1.0, rate * k * 20)
            self._mk(-self.cut)
        return self.shelf(x.T.astype(np.float32), self.fs, reset=False).T

    def reading(self):
        return round(self.cut, 1)


LATENCY = {"denoise": Denoiser.N - Denoiser.HOP}   # samples each effect delays the sound by


def latency(m, fs):
    """Samples a module delays the sound by (for delay compensation)."""
    t = m.get("type")
    return trigger_latency(m, fs) if t == "trigger" else LATENCY.get(t, 0)


class Effect:
    def __init__(self, kind, fs, nch):
        self.kind, self.fs, self.nch = kind, fs, nch
        self.p = {}
        self.dev = None        # the pedalboard processor, when there is one
        self.phase = 0.0       # LFO phase (tremolo, auto-filter)
        self.hold = None       # bitcrusher sample-and-hold state

    # ---- settings
    def set(self, m):
        self.p = dict(m)
        k, p = self.kind, self.p
        if k == "trigger":
            if not isinstance(self.dev, Trigger):
                self.dev = Trigger(self.fs)
            return
        if k == "rider":
            if not isinstance(self.dev, Rider):
                self.dev = Rider(self.fs)
            return
        if k == "bass":
            if not isinstance(self.dev, BassEnhancer):
                self.dev = BassEnhancer(self.fs, self.nch)
            return
        if k == "proximity":
            if not isinstance(self.dev, Proximity):
                self.dev = Proximity(self.fs, self.nch)
            return
        if k == "denoise":
            if not isinstance(self.dev, Denoiser):
                self.dev = Denoiser(self.fs, self.nch)
            self.dev.set(p)
            return
        if pb is None:
            return
        try:
            if k == "reverb":
                d = self.dev if isinstance(self.dev, pb.Reverb) else pb.Reverb()
                d.room_size = float(np.clip(p.get("size", 60) / 100, 0, 1))
                d.damping = float(np.clip(p.get("damping", 50) / 100, 0, 1))
                d.width = float(np.clip(p.get("width", 100) / 100, 0, 1))
                d.wet_level, d.dry_level = 1.0, 0.0
                self.dev = d
            elif k == "delay":
                d = self.dev if isinstance(self.dev, pb.Delay) else pb.Delay()
                d.delay_seconds = self._delay_s()
                d.feedback = float(np.clip(p.get("feedback", 30) / 100, 0, 0.95))
                d.mix = 1.0
                self.dev = d
                self._tone = self._filters(p.get("lowcut", 200), p.get("highcut", 6000))
            elif k in ("chorus", "flanger"):
                d = self.dev if isinstance(self.dev, pb.Chorus) else pb.Chorus()
                d.rate_hz = float(p.get("rate", 0.8 if k == "chorus" else 0.25))
                d.depth = float(np.clip(p.get("depth", 30 if k == "chorus" else 60) / 100, 0, 1))
                d.centre_delay_ms = float(p.get("delay", 7.0 if k == "chorus" else 1.5))
                d.feedback = float(np.clip(p.get("feedback", 0 if k == "chorus" else 50) / 100, -0.95, 0.95))
                d.mix = 1.0
                self.dev = d
            elif k == "phaser":
                d = self.dev if isinstance(self.dev, pb.Phaser) else pb.Phaser()
                d.rate_hz = float(p.get("rate", 0.5))
                d.depth = float(np.clip(p.get("depth", 50) / 100, 0, 1))
                d.centre_frequency_hz = float(p.get("centre", 1300))
                d.feedback = float(np.clip(p.get("feedback", 30) / 100, -0.95, 0.95))
                d.mix = 1.0
                self.dev = d
            elif k == "autofilter":
                mode = {"lowpass": pb.LadderFilter.Mode.LPF24, "highpass": pb.LadderFilter.Mode.HPF24,
                        "bandpass": pb.LadderFilter.Mode.BPF24}.get(p.get("mode", "lowpass"), pb.LadderFilter.Mode.LPF24)
                d = self.dev if isinstance(self.dev, pb.LadderFilter) else pb.LadderFilter()
                d.mode = mode
                d.resonance = float(np.clip(p.get("resonance", 30) / 100, 0, 0.95))
                d.drive = 1.0
                self.dev = d
            elif k == "distortion":
                self._tone = self._filters(20, p.get("tone", 6000))
            elif k == "pitch":
                d = self.dev if isinstance(self.dev, pb.PitchShift) else pb.PitchShift()
                d.semitones = float(np.clip(p.get("semitones", 12), -24, 24))
                self.dev = d
        except Exception:
            self.dev = None

    def _filters(self, lo, hi):
        if pb is None:
            return None
        return pb.Pedalboard([pb.HighpassFilter(float(max(lo, 10))), pb.LowpassFilter(float(min(hi, self.fs * 0.45)))])

    def _delay_s(self):
        p = self.p
        if p.get("sync", True):
            return float(np.clip(60.0 / max(float(tempo_fn() or 120), 20) * NOTE_BEATS.get(p.get("note", "1/4"), 1.0), 0.01, 4.0))
        return float(np.clip(p.get("time", 375) / 1000, 0.01, 4.0))

    # ---- audio
    def process(self, x, fs=None):
        """x: (frames, channels) float32. Returns the processed block (same shape)."""
        k, p = self.kind, self.p
        frames = x.shape[0]
        if frames == 0:
            return x
        mix = float(np.clip(p.get("mix", 100) / 100, 0, 1))
        if k == "trigger":
            return self.dev.process(x, p).astype(np.float32)
        if k == "rider":
            return self.dev.process(x, p).astype(np.float32)
        if k == "bass":
            y = self.dev.process(x, p)
            return (x * (1 - mix) + y * mix).astype(np.float32) if mix < 0.999 else y.astype(np.float32)
        if k == "proximity":
            return self.dev.process(x, p).astype(np.float32)
        if k == "denoise":
            y = self.dev.process(x)
            return (x * (1 - mix) + y * mix).astype(np.float32) if mix < 0.999 else y
        if k == "gain":
            g = 10 ** (float(p.get("gain", 0)) / 20) * (-1 if p.get("invert") else 1)
            y = x * g
            if p.get("mono") and y.shape[1] == 2:
                y[:] = y.mean(axis=1, keepdims=True)
            return y.astype(np.float32)
        if k == "tremolo":
            rate = float(p.get("rate", 4.0)) if not p.get("sync") else tempo_fn() / 60.0 / NOTE_BEATS.get(p.get("note", "1/8"), 0.5)
            depth = float(np.clip(p.get("depth", 50) / 100, 0, 1))
            ph = self.phase + 2 * math.pi * rate * np.arange(frames) / self.fs
            self.phase = float((ph[-1] + 2 * math.pi * rate / self.fs) % (2 * math.pi))
            lfo = np.sin(ph) if p.get("shape", "sine") == "sine" else np.sign(np.sin(ph))
            gl = 1 - depth * (0.5 + 0.5 * lfo)
            y = x.copy()
            if y.shape[1] == 2 and p.get("pan"):     # auto-pan: the two sides move opposite ways
                gr = 1 - depth * (0.5 - 0.5 * lfo)
                y[:, 0] *= gl; y[:, 1] *= gr
            else:
                y *= gl[:, None]
            return y.astype(np.float32)
        if k == "bitcrush":
            bits = float(np.clip(p.get("bits", 8), 2, 16))
            step = 2.0 ** (1 - bits)
            y = np.round(x / step) * step
            n = int(max(1, p.get("downsample", 1)))
            if n > 1:
                idx = (np.arange(frames) // n) * n
                y = y[np.minimum(idx, frames - 1)]
            return (x * (1 - mix) + y * mix).astype(np.float32)
        if k == "distortion":
            drive = 10 ** (float(p.get("drive", 12)) / 20)
            if p.get("flavor", "overdrive") == "fuzz":
                y = np.clip(x * drive, -1, 1)
            else:
                y = np.tanh(x * drive) / math.tanh(drive)
            if self._tone is not None:
                y = self._tone(y.T.astype(np.float32), self.fs, reset=False).T
            y *= 10 ** (float(p.get("output", 0)) / 20)
            return (x * (1 - mix) + y * mix).astype(np.float32)
        if self.dev is None:
            return x
        if k == "delay":
            want = self._delay_s()
            if abs(self.dev.delay_seconds - want) > 1e-4:     # follows tempo changes
                self.dev.delay_seconds = want
        if k == "autofilter":
            depth = float(p.get("depth", 2.0))      # octaves the cutoff sweeps
            rate = float(p.get("rate", 0.5))
            self.phase = (self.phase + 2 * math.pi * rate * frames / self.fs) % (2 * math.pi)
            self.dev.cutoff_hz = float(np.clip(float(p.get("cutoff", 1000)) * 2 ** (depth * math.sin(self.phase)), 30, self.fs * 0.45))
        y = self.dev(x.T.astype(np.float32), self.fs, reset=False).T
        if k == "delay" and self._tone is not None:
            y = self._tone(y.T.astype(np.float32), self.fs, reset=False).T
        if y.shape != x.shape:     # pitch shifting can return a different block size: keep the stream steady
            out = np.zeros_like(x)
            n = min(len(y), frames)
            out[frames - n:] = y[:n]
            y = out
        return (x * (1 - mix) + y * mix).astype(np.float32)
