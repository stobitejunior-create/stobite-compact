"""Feedback (loop) guard.

A loop happens when this app's output finds its way back into its own input: the mix sent to
the WING's USB returns comes back on a WING channel, or speakers are picked up by a mic. Each
trip round makes it louder, and within a second or two it screams.

How it's spotted: normally the output is a delayed copy of the input (the mix follows the
mics). In a loop the reverse also holds: an input is a delayed copy of the output. A
phase-only cross-correlation (GCC-PHAT) between the output and each live input shows a sharp
peak at the delay between them, and the sign of that delay tells the two cases apart, even
with music playing. When an input keeps following the output, the guard cuts every output and
says which channel the sound is coming back on.
"""
import threading

import numpy as np

WIN = 16384           # samples analysed per check (~0.34 s at 48 kHz)
MAX_CH = 8            # loudest inputs checked each time


class LoopGuard:
    def __init__(self, sr=48000, nch=48):
        self.sr = sr
        self.out = np.zeros(WIN, np.float32)
        self.ins = np.zeros((WIN, nch), np.float32)
        self.w = 0
        self.filled = 0
        self.hits = 0
        self.tripped = False
        self.message = ""
        self.lock = threading.Lock()
        k = np.fft.rfftfreq(WIN, 1 / sr)
        self.band = (k > 150) & (k < 8000)     # where loops ring; skips rumble and air

    def push(self, out_mono, raw):
        """From the audio callback: this block's output (mono) and every channel's raw input."""
        n = len(out_mono)
        if n == 0 or raw.shape[1] != self.ins.shape[1]:
            return
        idx = (self.w + np.arange(n)) % WIN
        self.out[idx] = out_mono
        self.ins[idx] = raw
        self.w = (self.w + n) % WIN
        self.filled = min(self.filled + n, WIN)

    def check(self, names=None):
        """Run from a background thread a few times a second. True when it has just tripped."""
        if self.tripped or self.filled < WIN:
            return False
        order = (np.arange(WIN) + self.w) % WIN
        out = self.out[order].astype(np.float64)
        if np.sqrt(np.mean(out ** 2)) < 0.003:        # output below about -50 dBFS: nothing to loop
            self.hits = 0
            return False
        ins = self.ins[order]
        rms = np.sqrt(np.mean(ins.astype(np.float64) ** 2, axis=0))
        live = [c for c in np.argsort(rms)[::-1][:MAX_CH] if rms[c] > 0.003]
        if not live:
            self.hits = 0
            return False
        win = np.hanning(WIN)
        lo, hi = int(0.004 * self.sr), int(0.3 * self.sr)   # a loop's round trip: 4 ms to 300 ms

        def spec(x):
            return np.fft.rfft(x * win)

        def lead_peak(A, Bc):
            """How sharply the signal behind B follows A (A leading by lo..hi samples)."""
            X = Bc * np.conj(A)
            X[~self.band] = 0
            X /= np.abs(X) + 1e-12
            r = np.abs(np.fft.irfft(X, WIN))
            ahead = r[lo:hi]
            return float(ahead.max()), lo + int(ahead.argmax()), float(np.median(r)) + 1e-9

        O = spec(out)
        S = {c: spec(ins[:, c]) for c in live}
        found = None
        for c in live:
            peak, lag, floor = lead_peak(O, S[c])
            if not (peak > 0.12 and peak > 12 * floor):
                continue
            # A mic that hears something another input already carries (the PA playing a song that
            # also comes in on its own channel) follows that input too. Only call it a loop when the
            # input follows the app's output more closely than any other input.
            rival = max((lead_peak(S[j], S[c])[0] for j in live if j != c), default=0.0)
            # several channels can show it (a loop smears into everything); name the clearest one
            if peak > 1.25 * rival and (found is None or peak > found[2]):
                found = (c, lag / self.sr * 1000, peak)
        if found is None:
            self.hits = max(0, self.hits - 1)
            return False
        self.hits += 1
        if self.hits < 3:     # must persist across three checks (about 0.6 s)
            return False
        c, ms, _ = found
        label = names[c] if names and c < len(names) else f"channel {c + 1}"
        with self.lock:
            self.tripped = True
            self.message = (f"Feedback stopped: the app's own output was coming back in on {label} "
                            f"(about {ms:.0f} ms later), so every output was cut. Usually the WING routes "
                            f"its USB returns into a channel that is also sent back to USB. Fix the routing "
                            f"(or turn off \"Send the mix back into the WING\" in Setup), then press Unmute.")
        return True

    def reset(self):
        with self.lock:
            self.tripped = False
            self.message = ""
            self.hits = 0
            self.filled = 0
