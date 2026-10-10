"""Mic alignment and polarity: compare each mic with a reference mic on the recording.

Close mics hear a drum a few milliseconds before the overheads or room mics do, and some mics
are wired (or placed) so their signal is upside down. Mixed together, both make the sound thin
and hollow. For each mic this finds how much earlier it hears the same sound as the reference,
and whether its polarity is flipped, from the stretch of the recording where both are busiest.
The fix is to delay the earlier mic by that much (and flip it if needed).
"""
import numpy as np

from .session import Reader

MAX_MS = 20.0


def _band(x, sr, lo=80.0, hi=5000.0):
    """Keep the part of the sound mics share (drop rumble and fizz)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / sr)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def busiest(session, chans, secs=20):
    """Start of the stretch where all the given channels have the most sound."""
    sr = session.sr
    total = session.length()
    if total <= secs * sr:
        return 0
    r = Reader(session)
    hop = 5 * sr
    best, at = -1.0, 0
    for pos in range(0, total - secs * sr, hop):
        d = r.render(pos, sr // 2)
        e = float(np.prod([np.sqrt(np.mean(d[:, c].astype(np.float64) ** 2)) + 1e-9 for c in chans]))
        if e > best:
            best, at = e, pos
    r.close()
    return at


def analyse(session, ref, chans, start=None, secs=20):
    """[{ch, delay_ms (how much earlier than the reference), flip, match 0-1}] for each channel."""
    sr = session.sr
    if start is None:
        start = busiest(session, [ref] + list(chans), secs)
    r = Reader(session)
    d = r.render(int(start), int(secs * sr)).astype(np.float64)
    r.close()
    a = _band(d[:, ref], sr)
    maxlag = int(MAX_MS / 1000 * sr)
    out = []
    for c in chans:
        b = _band(d[:, c], sr)
        n = len(a)
        size = 1 << int(np.ceil(np.log2(2 * n)))
        xc = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
        # xc[k] large when the reference matches this mic k samples later (mic earlier by k)
        lags = np.r_[np.arange(0, maxlag + 1), np.arange(-maxlag, 0)]
        vals = np.r_[xc[: maxlag + 1], xc[-maxlag:]]
        i = int(np.argmax(np.abs(vals)))
        norm = np.sqrt((a * a).sum() * (b * b).sum()) + 1e-12
        match = float(abs(vals[i]) / norm)
        lag = int(lags[i])
        out.append({"ch": int(c), "delay_ms": round(lag / sr * 1000, 2), "flip": bool(vals[i] < 0), "match": round(match, 2),
                    "start": round(start / sr, 1)})
    return out
