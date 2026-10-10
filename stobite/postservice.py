"""After the service: find the songs and the sermon, tag a podcast MP3, and line the recording up
with a livestream video.

Sections are markers: each marker starts a section that runs to the next one. A marker whose name
starts with "(" (like "(gap)") marks a stretch that isn't exported on its own.
"""
import os
import struct

import numpy as np

from .session import PEAK_RES, Reader

MUSIC = {"kick", "snare", "tom", "hihat", "overhead", "room", "perc", "bass", "synth_bass", "eg", "ag", "piano", "keys", "pad",
         "organ", "strings", "brass", "tracks", "lead_vocal", "worship_vocal", "bgv", "choir"}
SPEECH = {"preacher", "host"}


def _activity(session, mixer_state, kinds, sr_out=1):
    """Per-second level (linear power) of the channels of the given instrument kinds, from the peak files."""
    sr = session.sr
    secs = int(session.length() // sr) + 1
    e = np.zeros(secs)
    chs = mixer_state.get("channels", [])
    for c in session.clips:
        if c.get("mute") or c["track"] >= len(chs):
            continue
        ch = chs[c["track"]]
        if ch.get("mute") or ch.get("type") not in kinds:
            continue
        p = session.peaks_path(c["file"])
        if not os.path.exists(p):
            continue
        pk = np.load(p).astype(np.float64)
        per = sr // PEAK_RES
        a = c["offset"] // PEAK_RES
        seg = pk[a:a + c["length"] // PEAK_RES] ** 2 * 10 ** ((float(ch.get("trim", 0)) + float(ch.get("fader", 0))) / 10)
        n = len(seg) // per
        if n:
            s0 = c["start"] // sr
            m = min(n, secs - s0)
            e[s0:s0 + m] += seg[: n * per].reshape(n, per).mean(axis=1)[:m]
    return e


def _runs(on, min_len, bridge):
    """Stretches where `on` is true, joining gaps shorter than `bridge` seconds and dropping
    stretches shorter than `min_len`."""
    on = on.copy()
    idx = np.flatnonzero(np.diff(np.r_[0, on.astype(int), 0]))
    starts, ends = idx[::2], idx[1::2]
    for a, b in zip(ends[:-1], starts[1:]):       # bridge short gaps (a quiet bar, a breath)
        if b - a <= bridge:
            on[a:b] = True
    idx = np.flatnonzero(np.diff(np.r_[0, on.astype(int), 0]))
    return [(int(a), int(b)) for a, b in zip(idx[::2], idx[1::2]) if b - a >= min_len]


def find_sections(session, mixer_state):
    """Songs (the band playing) and talk (a preaching / host mic busy) as [{name, start, end, kind}] in samples."""
    sr = session.sr
    music = _activity(session, mixer_state, MUSIC)
    speech = _activity(session, mixer_state, SPEECH)
    out = []
    if music.any():
        db = 10 * np.log10(music + 1e-20)
        loud = np.percentile(db[db > -100], 90) if (db > -100).any() else -60
        songs = _runs(db > loud - 24, min_len=45, bridge=8)
        for k, (a, b) in enumerate(songs):
            out.append({"name": f"Song {k + 1}", "start": a * sr, "end": b * sr, "kind": "song"})
    if speech.any():
        db = 10 * np.log10(speech + 1e-20)
        loud = np.percentile(db[db > -100], 90) if (db > -100).any() else -60
        talks = _runs(db > loud - 20, min_len=120, bridge=20)
        if talks:
            a, b = max(talks, key=lambda r: r[1] - r[0])     # the longest stretch of talking: the sermon
            out.append({"name": "Sermon", "start": a * sr, "end": b * sr, "kind": "sermon"})
    return sorted(out, key=lambda s: s["start"])


def sections_from_markers(session):
    """[(name, start, end)] from the markers; "(...)" markers end a section without starting one."""
    ms = sorted(session.markers, key=lambda m: m["pos"])
    end = session.length()
    out = []
    for i, m in enumerate(ms):
        if m["name"].startswith("("):
            continue
        stop = ms[i + 1]["pos"] if i + 1 < len(ms) else end
        if stop - m["pos"] > session.sr:
            out.append((m["name"], int(m["pos"]), int(stop)))
    return out


# ---------------------------------------------------------------- podcast tags (ID3v2.3)

def _frame(fid, text):
    data = b"\x01" + text.encode("utf-16")             # UTF-16 with BOM: any language works
    return fid.encode() + struct.pack(">I", len(data)) + b"\x00\x00" + data


def _syncsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def tag_mp3(path, title="", artist="", album="", year="", comment=""):
    """Put title / speaker / church / date into an MP3 so podcast apps and phones show them."""
    frames = b""
    for fid, val in (("TIT2", title), ("TPE1", artist), ("TALB", album), ("TYER", year)):
        if val:
            frames += _frame(fid, str(val))
    if comment:
        data = b"\x01" + b"eng" + "".encode("utf-16") + b"\x00\x00" + str(comment).encode("utf-16")   # empty description, then the text
        frames += b"COMM" + struct.pack(">I", len(data)) + b"\x00\x00" + data
    if not frames:
        return
    head = b"ID3" + b"\x03\x00" + b"\x00" + _syncsafe(len(frames))
    with open(path, "rb") as f:
        body = f.read()
    with open(path, "wb") as f:
        f.write(head + frames + body)


# ---------------------------------------------------------------- lining up with a video

def _env(x, sr, rate=200):
    """A loudness outline (rate per second): matches between a raw recording and a processed stream."""
    hop = sr // rate
    n = len(x) // hop
    e = np.sqrt((x[: n * hop].reshape(n, hop).astype(np.float64) ** 2).mean(axis=1))
    e = np.log10(e + 1e-5)
    return e - np.convolve(e, np.ones(rate) / rate, "same")     # remove slow level changes


def video_offset(session, media_path, progress=lambda f: None):
    """Seconds into the project where the video starts (negative if the video started first),
    found by matching the video's sound against the recording. Also returns the video length."""
    from pedalboard.io import AudioFile
    sr = session.sr
    with AudioFile(media_path) as f:
        vsr = f.samplerate
        vlen = f.frames / vsr
        chunks = []
        while f.tell() < f.frames:
            chunks.append(f.read(int(vsr * 30)).mean(axis=0))
            progress(0.4 * f.tell() / max(f.frames, 1))
    v = np.concatenate(chunks) if chunks else np.zeros(0)
    if len(v) < vsr * 10:
        raise RuntimeError("That file has less than 10 seconds of sound.")
    # the project: every track summed, read in the same outline form
    r = Reader(session)
    total = session.length()
    acc = []
    pos = 0
    while pos < total:
        n = min(sr * 30, total - pos)
        acc.append(r.render(pos, n).sum(axis=1))
        pos += n
        progress(0.4 + 0.4 * pos / max(total, 1))
    r.close()
    p = np.concatenate(acc) if acc else np.zeros(0)
    rate = 200
    ev, ep = _env(v, vsr, rate), _env(p, sr, rate)
    size = 1 << int(np.ceil(np.log2(len(ev) + len(ep))))
    xc = np.fft.irfft(np.fft.rfft(ep, size) * np.conj(np.fft.rfft(ev, size)), size)
    k = int(np.argmax(xc))
    lag = k if k < size // 2 else k - size                       # project index = video index + lag
    peak = xc[k] / (np.sqrt((ev ** 2).sum() * (ep ** 2).sum()) + 1e-12)
    progress(1.0)
    return {"offset": round(lag / rate, 3), "length": round(vlen, 2), "match": round(float(peak), 2)}
