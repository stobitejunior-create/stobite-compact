"""Real-time pitch correction ("auto-tune") for vocal channels.

Detection: YIN on the last ~40 ms of audio (FFT autocorrelation).
Correction: snap to the nearest note of the song's key/scale, glide there at
the retune speed, then shift with a two-tap crossfading delay line (low
latency, clean for the small corrections tuning needs).
Latency is about 15 ms on corrected channels only.
"""
import math

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    "pentatonic": [0, 2, 4, 7, 9],
    "chromatic": list(range(12)),
}
VOICES = {"soprano": (180, 1100), "alto": (130, 800), "tenor": (95, 600), "baritone": (75, 450), "any": (70, 1100)}


def allowed_classes(key, scale):
    root = NOTE_NAMES.index(key) if key in NOTE_NAMES else 0
    return sorted({(root + s) % 12 for s in SCALES.get(scale, SCALES["chromatic"])})


def yin(frame, fs, fmin, fmax, threshold=0.15):
    """Returns (frequency Hz, confidence 0..1) or (0, 0) if unvoiced."""
    n = len(frame)
    tmax = min(int(fs / fmin), n // 2)
    tmin = max(int(fs / fmax), 2)
    if tmax <= tmin + 2:
        return 0.0, 0.0
    x = frame - frame.mean()
    energy = float((x * x).sum())
    if energy < 1e-6 * n:  # silence
        return 0.0, 0.0
    w = n - tmax
    size = 1 << int(math.ceil(math.log2(n + tmax)))
    X = np.fft.rfft(x, size)
    acf = np.fft.irfft(X * np.conj(np.fft.rfft(x[:w], size)), size)[: tmax + 1]
    cs = np.concatenate([[0.0], np.cumsum(x * x)])
    e0 = cs[w]
    et = cs[np.arange(tmax + 1) + w] - cs[np.arange(tmax + 1)]
    d = e0 + et - 2 * acf
    d[0] = 0
    cmnd = np.ones(tmax + 1)
    run = np.cumsum(d[1:])
    cmnd[1:] = d[1:] * np.arange(1, tmax + 1) / np.maximum(run, 1e-12)
    cand = np.nonzero(cmnd[tmin:tmax] < threshold)[0]
    if not len(cand):
        return 0.0, 0.0
    t = tmin + cand[0]
    while t + 1 < tmax and cmnd[t + 1] < cmnd[t]:  # walk to the local minimum
        t += 1
    if 1 <= t < tmax:  # parabolic interpolation
        a, b, c = cmnd[t - 1], cmnd[t], cmnd[t + 1]
        den = a - 2 * b + c
        t = t + (0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0)
    return fs / t, float(max(0.0, 1.0 - cmnd[int(round(t))]))


class PitchShifter:
    """Two read heads on a delay line, crossfaded with complementary windows."""

    def __init__(self, fs, window_ms=30.0, base_ms=3.0):
        self.fs = fs
        self.size = 1 << 15
        self.buf = np.zeros(self.size, np.float32)
        self.w = 0
        self.W = fs * window_ms / 1000
        self.base = fs * base_ms / 1000
        self.phase = 0.0

    def process(self, x, semitones):
        n = len(x)
        size = self.size
        idx = (self.w + np.arange(n)) % size
        self.buf[idx] = x
        r = 2.0 ** (semitones / 12.0)
        # delay changes by (1 - r) samples per sample; phase wraps every W samples
        ph = (self.phase + np.arange(1, n + 1) * (1.0 - r) / self.W) % 1.0
        self.phase = float(ph[-1])
        out = np.zeros(n, np.float32)
        for off in (0.0, 0.5):
            p = (ph + off) % 1.0
            delay = self.base + p * self.W
            pos = (self.w + np.arange(n)) - delay
            i0 = np.floor(pos).astype(np.int64)
            frac = (pos - i0).astype(np.float32)
            s = self.buf[i0 % size] * (1 - frac) + self.buf[(i0 + 1) % size] * frac
            out += s * (np.sin(np.pi * p) ** 2).astype(np.float32)
        self.w = (self.w + n) % size
        return out


class AutoTune:
    DETECT = 2048

    def __init__(self, fs):
        self.fs = fs
        self.hist = np.zeros(self.DETECT, np.float32)
        self.shifter = PitchShifter(fs)
        self.shift = 0.0
        self.freq = 0.0
        self.target = 0.0
        self.conf = 0.0
        self.count = 0
        self.p = {}

    def set_params(self, p, song):
        self.p = p
        key = song.get("key", "C")
        scale = "chromatic" if p.get("scale") == "chromatic" else song.get("scale", "major")
        self.classes = allowed_classes(key, scale)
        self.fmin, self.fmax = VOICES.get(p.get("voice", "any"), VOICES["any"])

    def _nearest(self, midi):
        best, bd = midi, 99.0
        base = math.floor(midi / 12) * 12
        for octv in (base - 12, base, base + 12):
            for c in self.classes:
                cand = octv + c
                d = abs(cand - midi)
                if d < bd:
                    best, bd = cand, d
        return best

    def process(self, x):
        n = len(x)
        self.hist = np.concatenate([self.hist[n:], x]) if n < self.DETECT else x[-self.DETECT:].copy()
        self.count += 1
        if self.count % 2 == 0:  # detect every other block (~100 Hz at 256 frames)
            f, conf = yin(self.hist.astype(np.float64), self.fs, self.fmin, self.fmax)
            self.freq, self.conf = f, conf
            if f > 0 and conf > 0.5:
                midi = 69 + 12 * math.log2(f / 440.0)
                tgt = self._nearest(midi)
                self.target = tgt
                want = (tgt - midi) * (float(self.p.get("amount", 100)) / 100.0)
            else:
                want = 0.0
            speed = max(float(self.p.get("speed", 40)), 0.0)  # retune time in ms (0 = instant / robotic)
            dt = 2 * n / self.fs * 1000
            k = 1.0 if speed < 1 else 1 - math.exp(-dt / speed)
            self.shift += (want - self.shift) * k
            self.shift = max(min(self.shift, 2.0), -2.0)
        return self.shifter.process(x, self.shift)

    def readout(self):
        if self.freq <= 0 or self.conf <= 0.5:
            return None
        midi = 69 + 12 * math.log2(self.freq / 440.0)
        note = int(round(self.target)) if self.target else int(round(midi))
        return {"note": NOTE_NAMES[note % 12] + str(note // 12 - 1), "cents": round((midi - note) * 100),
                "shift": round(self.shift * 100), "hz": round(self.freq, 1)}
