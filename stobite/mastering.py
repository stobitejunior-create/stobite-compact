"""Mastering assistant: listens to the project and sets up the master chain.

1. Finds the loudest stretches of the recording (from the waveform overviews, so it's quick).
2. Renders them through the current mix with the master chain switched off, and measures the
   tonal balance (octave bands) and loudness.
3. Builds a master chain: corrective EQ towards a reference curve in the chosen style, gentle glue
   compression, a light multiband, a touch of width when the mix is solidly stereo, and a true-peak
   limiter.
4. Renders again and trims the limiter until the result lands on the loudness target.
Everything stays editable afterwards, and the whole change is one undo step.
"""
import copy
import os

import numpy as np

from . import chain as chainmod
from .mixer import Mixer
from .session import PEAK_RES, Reader

OCT = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
# octave energy of a polished modern mix, relative to its 250 Hz-4 kHz average
REF = {63: 6.7, 125: 7.7, 250: 4.7, 500: 2.2, 1000: -0.3, 2000: -2.3, 4000: -4.3, 8000: -7.3, 16000: -14.3}
STYLES = {
    "balanced": [0, 0, 0, 0, 0, 0, 0, 0, 0],
    "warm": [1.0, 0.8, 0.3, 0, 0, -0.3, -0.8, -1.2, -1.5],
    "bright": [-0.5, -0.3, 0, 0, 0, 0.4, 1.0, 1.5, 1.5],
}
# what a boost / a cut at each band is heard as
BAND_WORDS = {70: ("low end", "low end"), 160: ("warmth", "muddiness"), 400: ("body", "boxiness"),
              1200: ("midrange", "honk"), 3500: ("presence", "harshness"), 10000: ("air", "brightness")}
WIN_S, N_WIN = 12, 6


def pick_windows(session, mixer_state=None):
    """The loudest WIN_S-second stretches of what is actually heard, spread across the project."""
    sr = session.sr
    total = session.length()
    secs = int(total // sr) + 1
    if secs <= WIN_S * N_WIN:
        return [(0, total)]
    energy = np.zeros(secs)
    chs = (mixer_state or {}).get("channels") or []
    for c in session.clips:
        if c.get("mute"):
            continue
        ch = chs[c["track"]] if c["track"] < len(chs) else {}
        if ch.get("mute"):
            continue            # a muted channel isn't part of the mix
        level = 10 ** ((float(ch.get("trim", 0)) + float(ch.get("fader", 0))) / 10)
        p = session.peaks_path(c["file"])
        if not os.path.exists(p):
            continue
        pk = np.load(p).astype(np.float64)
        per = sr // PEAK_RES                    # peak values per second
        a = c["offset"] // PEAK_RES
        seg = pk[a:a + c["length"] // PEAK_RES] ** 2 * 10 ** ((c.get("gain") or 0) / 10) * level
        n = len(seg) // per
        if not n:
            continue
        e = seg[: n * per].reshape(n, per).mean(axis=1)
        s0 = c["start"] // sr
        m = min(n, secs - s0)
        if m > 0:
            energy[s0:s0 + m] += e[:m]
    # score each stretch by its typical second (median), so a single loud hit or a song ending
    # doesn't make a mostly quiet stretch look busy
    win = np.median(np.lib.stride_tricks.sliding_window_view(energy, WIN_S), axis=1)
    picks = []
    for i in np.argsort(win)[::-1]:
        if win[i] <= 0:
            break
        if all(abs(i - j) >= max(WIN_S * 2, secs // (N_WIN * 2)) for j in picks):   # spread across the service
            picks.append(int(i))
        if len(picks) >= N_WIN:
            break
    return sorted((p * sr, (p + WIN_S) * sr) for p in picks) or [(0, min(total, WIN_S * N_WIN * sr))]


def render(engine, state, windows, keep=False):
    s = engine.session
    m = Mixer(s.nch, s.sr, copy.deepcopy(state))
    r = Reader(s)
    out = []
    with s.lock:
        clips = [dict(c) for c in s.clips]
    for a, b in windows:
        pos = a
        while pos < b:
            n = min(4096, b - pos)
            d = r.render(pos, n, clips)
            m.auto = engine.auto_for(s, pos)
            for i in range(0, n, 256):
                y = m.process(d[i:i + 256])
                if keep:
                    out.append(y)
            pos += n
    r.close()
    res = {"lufs": round(m.loud.integrated(), 1), "tp": round(20 * np.log10(max(m.loud.tp_max, 1e-9)), 1), "lra": round(m.loud.lra(), 1)}
    if keep:
        y = np.concatenate(out) if out else np.zeros((0, 2), np.float32)
        res["audio"] = y
    return res


def octaves(y, sr):
    m = y.mean(axis=1).astype(np.float64)
    seg = 1 << 15
    acc = np.zeros(seg // 2 + 1)
    for i in range(0, max(len(m) - seg, 0), seg // 2):
        acc += np.abs(np.fft.rfft(m[i:i + seg] * np.hanning(seg))) ** 2
    f = np.fft.rfftfreq(seg, 1 / sr)
    o = {c: 10 * np.log10(acc[(f >= c / 2 ** 0.5) & (f < c * 2 ** 0.5)].sum() + 1e-20) for c in OCT}
    ref = np.mean([o[c] for c in (250, 500, 1000, 2000, 4000)])
    return {c: o[c] - ref for c in OCT}


def _band(t, f, g, q):
    return {"type": t, "freq": f, "gain": round(float(g), 1), "q": q, "on": True, "slope": 12}


def assist(engine, target=-14.0, style="balanced", progress=lambda f, msg: None):
    s = engine.session
    if s is None or not s.clips:
        raise RuntimeError("Record or import something first: the assistant listens to the project.")
    base = engine.mixer.snapshot()
    for ch in base["channels"]:
        ch["solo"] = False          # a solo is for listening, not part of the mix being mastered
    for g in base.get("dcas") or []:
        g["solo"] = False
    windows = pick_windows(s, base)
    progress(0.05, "Finding the loudest parts")

    # 1) the mix as it is, without the master chain; stretches far quieter than the busiest one
    #    (talking, a soft pad) would only drag the measurements, so they're left out
    pre = copy.deepcopy(base)
    pre["master"]["bypass"] = True
    each = [render(engine, pre, [w], keep=True) for w in windows]
    top = max(r["lufs"] for r in each)
    keep = [i for i, r in enumerate(each) if r["lufs"] >= top - 10]
    windows = [windows[i] for i in keep]
    a = render(engine, pre, windows)
    a["audio"] = np.concatenate([each[i]["audio"] for i in keep])
    if a["lufs"] < -60:
        raise RuntimeError("The mix is silent in the busiest parts: check the faders and mutes first.")
    progress(0.35, "Measuring the tone")
    y = a["audio"]
    oct_ = octaves(y, s.sr)
    shape = STYLES.get(style, STYLES["balanced"])
    corr = {c: float(np.clip(REF[c] + shape[k] - oct_[c], -6, 6)) * 0.6 for k, c in enumerate(OCT)}
    eq = [
        _band("lowshelf", 70, np.clip(corr[63], -4, 4), 0.7),
        _band("bell", 160, np.clip(corr[125], -4, 4), 0.9),
        _band("bell", 400, np.clip((corr[250] + corr[500]) / 2, -4, 4), 0.8),
        _band("bell", 1200, np.clip((corr[1000] + corr[2000]) / 2, -4, 4), 0.8),
        _band("bell", 3500, np.clip(corr[4000], -4, 4), 0.8),
        _band("highshelf", 10000, np.clip((corr[8000] + corr[16000]) / 2, -4, 4), 0.7),
    ]
    mono = y.mean(axis=1)
    rms = 20 * np.log10(np.sqrt(np.mean(mono.astype(np.float64) ** 2)) + 1e-12)
    l, r_ = y[:, 0].astype(np.float64), y[:, 1].astype(np.float64)
    corr_lr = float((l * r_).sum() / (np.sqrt((l * l).sum() * (r_ * r_).sum()) + 1e-12))

    M = chainmod.module
    lim = M("limiter", ceiling=-1.0, threshold=0.0, gain=0.0, release=150, truepeak=True)
    comp = M("comp", thr=round(rms + 3, 1), ratio=1.6, att=30, rel=250, knee=10, makeup=0, mix=100, range=10, sc="")
    master_chain = [
        M("eq", hpf={"on": True, "freq": 20, "slope": 24}, lpf={"on": False, "freq": 20000, "slope": 12}, bands=eq),
        comp,
        M("mbc", x1=150, x2=4000, bands=[
            {"thr": round(rms - 2, 1), "ratio": 2, "att": 30, "rel": 250, "gain": 0, "range": 3},
            {"thr": round(rms - 2, 1), "ratio": 1.4, "att": 20, "rel": 200, "gain": 0, "range": 2},
            {"thr": round(rms - 6, 1), "ratio": 2, "att": 10, "rel": 150, "gain": 0, "range": 3}]),
        M("width", width=108.0 if corr_lr > 0.5 else 100.0, balance=0.0),
        lim,
    ]

    # 2) set the limiter so the result lands on the target, re-measuring each time
    st = copy.deepcopy(base)
    st["master"]["chain"] = master_chain
    st["master"]["bypass"] = False
    st["master"]["target"] = target
    # The level comes from two places: the glue compressor (up to 6 dB, with a little more ratio
    # as it works harder) and the limiter (kept under ~8 dB so peaks aren't crushed).
    def split(total):
        makeup = float(np.clip(total - 8.0, 0.0, 6.0))
        comp.update(makeup=round(makeup, 1), thr=round(rms + 3 - makeup, 1), ratio=round(1.6 + 0.15 * makeup, 2))
        lim["gain"] = round(float(np.clip(total - makeup, -12, 20)), 1)
    total = float(np.clip(target - a["lufs"], -12, 26))
    res = None
    for k in range(4):
        split(total)
        res = render(engine, st, windows)
        progress(0.45 + 0.13 * (k + 1), "Setting the loudness")
        miss = target - res["lufs"]
        if abs(miss) < 0.3:
            break
        # each dB of extra drive gives less than a dB of loudness once the limiter works: overshoot a little
        total = float(np.clip(total + miss * (1.6 if miss > 0 else 1.0), -12, 26))
    notes = []
    for b in eq:
        if abs(b["gain"]) >= 0.8:
            up, down = BAND_WORDS.get(b["freq"], (f'{b["freq"]} Hz', f'{b["freq"]} Hz'))
            notes.append(f'{"More " + up if b["gain"] > 0 else "Less " + down} ({b["gain"]:+.1f} dB at {b["freq"] if b["freq"] < 1000 else str(b["freq"] / 1000).rstrip("0").rstrip(".") + "k"}{" Hz" if b["freq"] < 1000 else "Hz"})')
    if abs(res["lufs"] - target) > 1.0:
        notes.insert(0, f'Reached {res["lufs"]} LUFS instead of {target:g}: the mix going in is too quiet or too peaky to get there cleanly.')
    if comp["makeup"] >= 6 and lim["gain"] > 12:
        notes.append("The mix is quiet going into the master: raising faders a little would need less limiting.")
    if corr_lr < 0.2:
        notes.append("Left and right are very different (wide or out of phase): check it in mono on the Master page.")
    progress(1.0, "Done")
    return {"chain": master_chain, "target": target, "style": style, "windows": len(windows),
            "before": {k: a[k] for k in ("lufs", "tp", "lra")}, "after": {k: res[k] for k in ("lufs", "tp", "lra")},
            "limiter": lim["gain"], "glue": comp["makeup"], "eq": [(b["freq"], b["gain"]) for b in eq], "notes": notes}
