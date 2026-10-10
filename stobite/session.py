"""Sessions on disk, the clip timeline, non-destructive edits and recording."""
import copy
import json
import shutil
import os
import queue
import re
import threading
import time
import uuid

import numpy as np
import soundfile as sf

PEAK_RES = 256  # samples per stored peak value


def home_dir():
    base = os.environ.get("STOBITE_HOME") or os.path.join(os.path.expanduser("~"), "Stobite Compact")
    os.makedirs(os.path.join(base, "Sessions"), exist_ok=True)
    os.makedirs(os.path.join(base, "Exports"), exist_ok=True)
    return base


def safe_name(name):
    return re.sub(r"[^\w\- ]+", "", name).strip()[:60] or "Untitled"


def list_sessions(detail=False):
    root = os.path.join(home_dir(), "Sessions")
    out = []
    for n in sorted(os.listdir(root)):
        p = os.path.join(root, n, "session.json")
        if not os.path.exists(p):
            continue
        item = {"name": n, "modified": os.path.getmtime(p)}
        if detail:
            try:
                with open(p) as f:
                    data = json.load(f)
                clips = data.get("clips", [])
                sr = data.get("sr", 48000) or 48000
                item["seconds"] = round(max((c["start"] + c["length"] for c in clips), default=0) / sr, 1)
                item["tracks"] = len({c["track"] for c in clips})
                item["markers"] = len(data.get("markers", []))
            except Exception:
                pass
            size = 0
            for dp, _, files in os.walk(os.path.join(root, n)):
                for fn in files:
                    try:
                        size += os.path.getsize(os.path.join(dp, fn))
                    except OSError:
                        pass
            item["bytes"] = size
        out.append(item)
    out.sort(key=lambda s: -s["modified"])
    return out


def delete_session(name):
    """Move a project to the Trash (Mac) or delete it (elsewhere)."""
    import shutil
    import sys
    path = os.path.join(home_dir(), "Sessions", safe_name(name))
    if not os.path.isdir(path):
        raise RuntimeError("That project no longer exists.")
    if sys.platform == "darwin":
        trash = os.path.expanduser("~/.Trash")
        dest = os.path.join(trash, os.path.basename(path))
        k = 2
        while os.path.exists(dest):
            dest = os.path.join(trash, f"{os.path.basename(path)} {k}")
            k += 1
        shutil.move(path, dest)
        return "trash"
    shutil.rmtree(path)
    return "deleted"


SFC_SET_UPDATE_HEADER_AUTO = 0x1061   # libsndfile: rewrite the WAV header after every write


def crash_safe(f):
    """Keep a WAV's header current while it's being written, so a crash leaves a readable file."""
    try:
        from soundfile import _snd, _ffi
        _snd.sf_command(f._file, SFC_SET_UPDATE_HEADER_AUTO, _ffi.NULL, 1)
    except Exception:
        pass


def repair_wav(path, sr):
    """A WAV whose header says it's empty but holds audio (cut off mid-recording): rebuild it."""
    try:
        if sf.info(path).frames > 0:
            return True
    except Exception:
        pass
    size = os.path.getsize(path)
    if size <= 44 + 3:
        return False
    with open(path, "rb") as fh:
        head = fh.read(4096)
        k = head.find(b"data")
        off = k + 8 if k >= 0 else 44
        fh.seek(off)
        raw = fh.read()
    n = len(raw) // 3
    b = np.frombuffer(raw[: n * 3], np.uint8).reshape(n, 3).astype(np.int32)
    v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
    v = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float32) / (1 << 23)
    tmp = path + ".fixed.wav"
    sf.write(tmp, v, sr, subtype="PCM_24")
    os.replace(tmp, path)
    return True


def recover_interrupted(session):
    """After a crash: turn the files of a recording that never finished into clips. Returns how many."""
    note = os.path.join(session.dir, "recording.json")
    if not os.path.exists(note):
        return 0
    try:
        with open(note) as fh:
            info = json.load(fh)
    except Exception:
        os.remove(note)
        return 0
    have = {c["file"] for c in session.clips}
    clips = []
    for c, rel in info.get("files", {}).items():
        p = os.path.join(session.dir, rel)
        if rel in have or not os.path.exists(p) or not repair_wav(p, session.sr):
            continue
        frames = sf.info(p).frames
        if frames <= 0:
            continue
        d, _ = sf.read(p, dtype="float32")
        session.write_peaks(rel, d if d.ndim == 1 else d[:, 0])
        clips.append(Session.new_clip(int(c), rel, int(info.get("start", 0)), frames, name=info.get("name", "Recovered") + " (recovered)"))
    with session.lock:
        session.clips.extend(clips)
        session.take = max(session.take, int(info.get("take", 0)))
        session._bump()
    os.remove(note)
    return len(clips)


def scratch_dir():
    return os.path.join(home_dir(), ".scratch", "Untitled")


class Session:
    def __init__(self, name, sr, nch, scratch=False):
        # scratch: the hidden, unnamed project used while no project is open. It is never listed;
        # the moment audio is recorded or imported into it, it becomes a real project.
        self.scratch = scratch
        self.name = "No project" if scratch else safe_name(name)
        self.dir = scratch_dir() if scratch else os.path.join(home_dir(), "Sessions", self.name)
        os.makedirs(os.path.join(self.dir, "audio"), exist_ok=True)
        os.makedirs(os.path.join(self.dir, "peaks"), exist_ok=True)
        self.sr, self.nch = sr, nch
        self.clips = []
        self.markers = []
        self.mixer_state = None
        self.armed = [True] * nch
        self.automation = {}   # "ch:3:fader" / "ch:3:pan" / "ch:3:mute" / "master:fader" -> [[pos, value], ...]
        self.automode = {}     # "3" / "master" -> "off" | "read" | "touch"
        self.loop = {"on": False, "start": 0, "end": 0}
        self._auto_cache = None
        self.take = 0
        self.undo_stack, self.redo_stack = [], []
        self.lock = threading.RLock()
        self.version = 0
        self.peak_cache = {}

    # ------------------------------------------------------------ persistence
    def to_json(self, mixer_state):
        return {"name": self.name, "sr": self.sr, "nch": self.nch, "clips": self.clips,
                "markers": self.markers, "armed": self.armed, "take": self.take, "mixer": mixer_state,
                "automation": self.automation, "automode": self.automode, "loop": self.loop}

    def save(self, mixer_state):
        with self.lock:
            data = self.to_json(mixer_state)
        tmp = os.path.join(self.dir, "session.json.tmp")
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, os.path.join(self.dir, "session.json"))

    @classmethod
    def load(cls, name, nch_hint=48):
        d = os.path.join(home_dir(), "Sessions", safe_name(name), "session.json")
        with open(d) as f:
            data = json.load(f)
        s = cls(data["name"], data["sr"], data.get("nch", nch_hint))
        s.clips = data.get("clips", [])
        s.markers = data.get("markers", [])
        s.armed = (data.get("armed") or [True] * s.nch)[: s.nch]
        s.armed += [True] * (s.nch - len(s.armed))
        s.take = data.get("take", 0)
        s.mixer_state = data.get("mixer")
        s.automation = data.get("automation", {})
        s.automode = data.get("automode", {})
        s.loop = data.get("loop", s.loop)
        return s

    def public(self):
        with self.lock:
            return {"name": self.name, "scratch": self.scratch, "sr": self.sr, "nch": self.nch, "clips": self.clips,
                    "markers": self.markers, "armed": self.armed, "length": self.length(),
                    "automation": self.automation, "automode": self.automode, "loop": self.loop,
                    "canUndo": bool(self.undo_stack), "canRedo": bool(self.redo_stack),
                    "version": self.version}

    def length(self):
        return max((c["start"] + c["length"] for c in self.clips), default=0)

    # ------------------------------------------------------------ editing
    def _state(self):
        return copy.deepcopy((self.clips, self.markers, self.automation))

    def _restore(self, st):
        self.clips, self.markers, self.automation = st
        self._auto_cache = None

    def _checkpoint(self):
        self.undo_stack.append(self._state())
        del self.undo_stack[:-200]
        self.redo_stack.clear()

    def _bump(self):
        self.version += 1
        self._auto_cache = None

    def undo(self):
        with self.lock:
            if self.undo_stack:
                self.redo_stack.append(self._state())
                self._restore(self.undo_stack.pop())
                self._bump()

    def redo(self):
        with self.lock:
            if self.redo_stack:
                self.undo_stack.append(self._state())
                self._restore(self.redo_stack.pop())
                self._bump()

    # ------------------------------------------------------------ automation
    def auto_lanes(self):
        """Compiled lanes {key: (xs, ys)} as numpy arrays, rebuilt after edits."""
        cache = self._auto_cache
        if cache is None:
            cache = {}
            for k, pts in list(self.automation.items()):
                if pts:
                    a = np.asarray(pts, dtype=np.float64)
                    cache[k] = (a[:, 0], a[:, 1])
            self._auto_cache = cache
        return cache

    def auto_value(self, key, pos):
        lane = self.auto_lanes().get(key)
        if lane is None:
            return None
        xs, ys = lane
        if key.endswith(":mute"):
            i = int(np.searchsorted(xs, pos, side="right")) - 1
            return float(ys[max(i, 0)])
        return float(np.interp(pos, xs, ys))

    def auto_write(self, key, pos, value, since):
        """Touch-write: replace points in (since, pos] with a point at pos."""
        with self.lock:
            pts = self.automation.setdefault(key, [])
            if since is None:  # touch began: pin the old curve just before
                old = self.auto_value(key, pos)
                if old is not None:
                    pts[:] = [p for p in pts if p[0] < pos - 1] + [[pos - 1, old]] + [p for p in pts if p[0] > pos]
                since = pos - 1
            pts[:] = [p for p in pts if not (since < p[0] <= pos)] + [[int(pos), float(value)]]
            pts.sort(key=lambda p: p[0])
            self._auto_cache = None
            self.version += 1

    def _clip(self, cid):
        for c in self.clips:
            if c["id"] == cid:
                return c
        raise KeyError(cid)

    def edit(self, op, a):
        """Apply one edit. All positions are in samples."""
        with self.lock:
            self._checkpoint()
            ids = a.get("ids") or ([a["id"]] if "id" in a else [])
            if op == "split":
                at = int(a["at"])
                targets = [self._clip(i) for i in ids] if ids else [
                    c for c in self.clips if c["start"] < at < c["start"] + c["length"]
                    and (a.get("track") is None or c["track"] == a["track"])]
                for c in targets:
                    if not (c["start"] < at < c["start"] + c["length"]):
                        continue
                    cut = at - c["start"]
                    right = dict(c, id=uuid.uuid4().hex[:10], start=at, offset=c["offset"] + cut,
                                 length=c["length"] - cut, fin=0)
                    c["length"] = cut
                    c["fout"] = 0
                    self.clips.append(right)
            elif op == "delete":
                self.clips = [c for c in self.clips if c["id"] not in ids]
            elif op == "move":
                d = int(a.get("delta", 0))
                dt = int(a.get("trackDelta", 0))
                for i in ids:
                    c = self._clip(i)
                    c["start"] = max(0, c["start"] + d)
                    c["track"] = int(min(max(c["track"] + dt, 0), self.nch - 1))
            elif op == "trim":
                c = self._clip(ids[0])
                if "newStart" in a:  # trim left edge
                    ns = int(a["newStart"])
                    ns = max(ns, c["start"] - c["offset"], 0)
                    ns = min(ns, c["start"] + c["length"] - 64)
                    d = ns - c["start"]
                    c["start"], c["offset"], c["length"] = ns, c["offset"] + d, c["length"] - d
                if "newEnd" in a:
                    ne = int(a["newEnd"])
                    maxlen = c.get("fileLength", c["offset"] + c["length"]) - c["offset"]
                    c["length"] = int(min(max(ne - c["start"], 64), maxlen))
            elif op == "set":
                for i in ids:
                    c = self._clip(i)
                    for k in ("gain", "fin", "fout", "mute", "name"):
                        if k in a:
                            c[k] = a[k]
            elif op == "deleteRange":
                s, e = int(a["start"]), int(a["end"])
                ripple = bool(a.get("ripple"))
                tracks = a.get("tracks")
                for at in (s, e):
                    for c in list(self.clips):
                        if (tracks is None or c["track"] in tracks) and c["start"] < at < c["start"] + c["length"]:
                            cut = at - c["start"]
                            right = dict(c, id=uuid.uuid4().hex[:10], start=at, offset=c["offset"] + cut,
                                         length=c["length"] - cut, fin=0)
                            c["length"], c["fout"] = cut, 0
                            self.clips.append(right)
                keep = []
                for c in self.clips:
                    inside = c["start"] >= s and c["start"] + c["length"] <= e
                    if inside and (tracks is None or c["track"] in tracks):
                        continue
                    if ripple and c["start"] >= e and (tracks is None or c["track"] in tracks):
                        c["start"] -= (e - s)
                    keep.append(c)
                self.clips = keep
                if ripple:
                    d = e - s
                    for k, pts in self.automation.items():
                        self.automation[k] = [[p[0] - d if p[0] >= e else p[0], p[1]] for p in pts if not (s <= p[0] < e)]
                    self.markers = [dict(m, pos=m["pos"] - (e - s)) if m["pos"] >= e else m
                                    for m in self.markers if not (s <= m["pos"] < e)]
            elif op == "duplicate":
                for i in ids:
                    c = self._clip(i)
                    self.clips.append(dict(c, id=uuid.uuid4().hex[:10], start=c["start"] + c["length"]))
            elif op == "paste":
                # clips copied earlier (possibly from another place in the session), placed at a new position
                new_ids = []
                for c in a.get("clips") or []:
                    c = dict(c, id=uuid.uuid4().hex[:10])
                    c["track"] = int(min(max(int(c["track"]), 0), self.nch - 1))
                    c["start"] = max(0, int(c["start"]))
                    if not os.path.exists(os.path.join(self.dir, c["file"])):
                        continue
                    self.clips.append(c)
                    new_ids.append(c["id"])
                self.last_new = new_ids
            elif op == "normalize":
                # clip gain so its loudest peak sits at -1 dBFS
                for i in ids:
                    c = self._clip(i)
                    with sf.SoundFile(os.path.join(self.dir, c["file"])) as f:
                        f.seek(c["offset"])
                        d = f.read(c["length"], dtype="float32", always_2d=True)[:, 0]
                    pk = float(np.abs(d).max()) if len(d) else 0.0
                    if pk > 1e-6:
                        c["gain"] = round(float(np.clip(-1.0 - 20 * np.log10(pk), -24, 24)), 1)
            elif op == "reverse":
                for i in ids:
                    c = self._clip(i)
                    with sf.SoundFile(os.path.join(self.dir, c["file"])) as f:
                        f.seek(c["offset"])
                        d = f.read(c["length"], dtype="float32", always_2d=True)[:, 0]
                    rel = f"audio/Reversed_{uuid.uuid4().hex[:8]}.wav"
                    sf.write(os.path.join(self.dir, rel), d[::-1], self.sr, subtype="PCM_24")
                    self.write_peaks(rel, d[::-1])
                    c.update(file=rel, offset=0, fileLength=len(d), fin=c.get("fout", 0), fout=c.get("fin", 0),
                             name=(c["name"][9:] if c["name"].startswith("Reversed ") else "Reversed " + c["name"]))
            elif op == "join":
                # clips on one track become one clip: kept as-is when they already run on in one file,
                # otherwise rendered (gain and fades included) into a new file
                cs = sorted((self._clip(i) for i in ids), key=lambda c: c["start"])
                if len(cs) < 2 or len({c["track"] for c in cs}) != 1:
                    raise ValueError("Pick two or more clips on the same track to join")
                seamless = all(b["file"] == a_["file"] and b["start"] == a_["start"] + a_["length"]
                               and b["offset"] == a_["offset"] + a_["length"] and (a_.get("gain") or 0) == (b.get("gain") or 0)
                               for a_, b in zip(cs, cs[1:]))
                first, last = cs[0], cs[-1]
                end = max(c["start"] + c["length"] for c in cs)
                if seamless:
                    first["length"] = end - first["start"]
                    first["fout"] = last.get("fout", 0)
                else:
                    buf = np.zeros(end - first["start"], np.float32)
                    for c in cs:
                        with sf.SoundFile(os.path.join(self.dir, c["file"])) as f:
                            f.seek(c["offset"])
                            d = f.read(c["length"], dtype="float32", always_2d=True)[:, 0]
                        env = np.ones(len(d), np.float32)
                        if c.get("fin"):
                            n = min(int(c["fin"]), len(d)); env[:n] *= np.linspace(0, 1, n, dtype=np.float32)
                        if c.get("fout"):
                            n = min(int(c["fout"]), len(d)); env[len(d) - n:] *= np.linspace(1, 0, n, dtype=np.float32)
                        d = d * env * (10 ** ((c.get("gain") or 0) / 20))
                        o = c["start"] - first["start"]
                        buf[o:o + len(d)] += d
                    rel = f"audio/Joined_{uuid.uuid4().hex[:8]}.wav"
                    sf.write(os.path.join(self.dir, rel), buf, self.sr, subtype="PCM_24")
                    self.write_peaks(rel, buf)
                    first.update(file=rel, offset=0, length=len(buf), fileLength=len(buf), gain=0.0, fin=0, fout=0, mute=False)
                gone = {c["id"] for c in cs[1:]}
                self.clips = [c for c in self.clips if c["id"] not in gone]
            elif op == "marker":
                self.markers.append({"id": uuid.uuid4().hex[:8], "pos": int(a["pos"]),
                                     "name": a.get("name") or f"Marker {len(self.markers) + 1}"})
                self.markers.sort(key=lambda m: m["pos"])
            elif op == "markerDelete":
                self.markers = [m for m in self.markers if m["id"] != a["id"]]
            elif op == "markerRename":
                for m in self.markers:
                    if m["id"] == a["id"]:
                        m["name"] = a["name"]
            elif op == "arm":
                self.undo_stack.pop()
                self.armed = a["armed"]
            elif op == "auto":
                pts = sorted([[int(p[0]), float(p[1])] for p in a["points"]], key=lambda p: p[0])
                if pts:
                    self.automation[a["key"]] = pts
                else:
                    self.automation.pop(a["key"], None)
            elif op == "automode":
                self.undo_stack.pop()
                self.automode[str(a["target"])] = a["mode"]
            elif op == "loop":
                self.undo_stack.pop()
                self.loop = {"on": bool(a.get("on", self.loop["on"])), "start": int(a.get("start", self.loop["start"])),
                             "end": int(a.get("end", self.loop["end"]))}
            else:
                self.undo_stack.pop()
                raise ValueError(f"unknown edit {op}")
            self._bump()

    def import_file(self, path, track, start):
        """Import an audio file (split to mono tracks starting at `track`)."""
        info = sf.info(path)
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        if sr != self.sr:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(sr, self.sr)
            data = resample_poly(data, self.sr // g, sr // g, axis=0).astype(np.float32)
        base = safe_name(os.path.splitext(os.path.basename(path))[0])
        with self.lock:
            self._checkpoint()
            for ch in range(data.shape[1]):
                t = track + ch
                if t >= self.nch:
                    break
                rel = f"audio/{base}_{uuid.uuid4().hex[:6]}_{ch + 1}.wav"
                sf.write(os.path.join(self.dir, rel), data[:, ch], self.sr, subtype="PCM_24")
                self.write_peaks(rel, data[:, ch])
                self.clips.append(self.new_clip(t, rel, start, data.shape[0], name=base))
            self._bump()
        return info

    @staticmethod
    def new_clip(track, rel, start, length, name=None):
        return {"id": uuid.uuid4().hex[:10], "track": track, "file": rel, "start": int(start), "offset": 0,
                "length": int(length), "fileLength": int(length), "gain": 0.0, "fin": 0, "fout": 0,
                "mute": False, "name": name or os.path.basename(rel)}

    # ------------------------------------------------------------ peaks
    def peaks_path(self, rel):
        return os.path.join(self.dir, "peaks", os.path.basename(rel) + ".npy")

    def write_peaks(self, rel, mono):
        n = len(mono) // PEAK_RES
        pk = np.abs(mono[: n * PEAK_RES]).reshape(n, PEAK_RES).max(axis=1) if n else np.zeros(0)
        np.save(self.peaks_path(rel), pk.astype(np.float16))
        self.peak_cache.pop(rel, None)

    def peaks(self, rel, spp):
        pk = self.peak_cache.get(rel)
        if pk is None:
            p = self.peaks_path(rel)
            if not os.path.exists(p):
                d, _ = sf.read(os.path.join(self.dir, rel), dtype="float32")
                self.write_peaks(rel, d if d.ndim == 1 else d[:, 0])
            pk = np.load(p).astype(np.float32)
            self.peak_cache[rel] = pk
        f = max(int(spp) // PEAK_RES, 1)
        n = len(pk) // f
        out = pk[: n * f].reshape(n, f).max(axis=1) if n else pk
        # perceptual-ish scaling so quiet material is still visible
        return (np.sqrt(np.clip(out, 0, 1)) * 255).astype(np.uint8)


class Reader:
    """Renders the clip timeline into (frames, nch) blocks. One per thread."""

    def __init__(self, session):
        self.s = session
        self.files = {}

    def _f(self, rel):
        f = self.files.get(rel)
        if f is None:
            f = sf.SoundFile(os.path.join(self.s.dir, rel))
            self.files[rel] = f
        return f

    def close(self):
        for f in self.files.values():
            f.close()
        self.files.clear()

    def render(self, start, frames, clips=None):
        s = self.s
        out = np.zeros((frames, s.nch), dtype=np.float32)
        end = start + frames
        if clips is None:
            with s.lock:
                clips = list(s.clips)
        for c in clips:
            cs, ce = c["start"], c["start"] + c["length"]
            if c.get("mute") or ce <= start or cs >= end:
                continue
            a, b = max(cs, start), min(ce, end)
            try:
                f = self._f(c["file"])
                f.seek(c["offset"] + (a - cs))
                d = f.read(b - a, dtype="float32", always_2d=True)[:, 0]
            except Exception:
                continue
            n = len(d)
            if not n:
                continue
            g = 10 ** (c.get("gain", 0) / 20)
            pos = np.arange(a - cs, a - cs + n)
            env = np.full(n, g, dtype=np.float32)
            fin, fout = int(c.get("fin", 0)), int(c.get("fout", 0))
            if fin > 0:
                env *= np.clip(pos / fin, 0, 1)
            if fout > 0:
                env *= np.clip((c["length"] - pos) / fout, 0, 1)
            out[a - start:a - start + n, c["track"]] += d * env
        return out


class Recorder:
    """Writes armed input channels to mono 24-bit WAVs on a background thread."""

    def __init__(self):
        self.q = queue.Queue(maxsize=4000)
        self.active = False
        self.thread = None
        self.dropped = 0

    def start(self, session, start_pos):
        session.take += 1
        self.session = session
        self.start_pos = start_pos
        self.chans = [i for i, a in enumerate(session.armed) if a]
        stamp = time.strftime("%H%M%S")
        self.rels = {c: f"audio/T{session.take:03d}_{stamp}_Ch{c + 1:02d}.wav" for c in self.chans}
        self.files = {c: sf.SoundFile(os.path.join(session.dir, r), "w", session.sr, 1, "PCM_24")
                      for c, r in self.rels.items()}
        for f in self.files.values():
            crash_safe(f)
        # a note saying a recording is in progress: if the app or computer dies, the next start
        # finds it and turns the files into clips (see recover_interrupted)
        with open(os.path.join(session.dir, "recording.json"), "w") as fh:
            json.dump({"take": session.take, "start": int(start_pos), "files": {str(c): r for c, r in self.rels.items()},
                       "name": f"Take {session.take}", "time": time.time()}, fh)
        self.last_sync = time.time()
        self.disk_low = False
        self.disk_warn = False
        self.peak_acc = {c: [] for c in self.chans}
        # waveform outline while recording: one growing array per channel (doubles when full)
        self.flat = {c: np.zeros(4096, np.float16) for c in self.chans}
        self.n = 0
        self.frames = 0
        self.dropped = 0
        self.active = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def push(self, block):
        if self.active:
            try:
                self.q.put_nowait(block[:, self.chans].copy())
            except queue.Full:
                self.dropped += 1

    def _run(self):
        pending = []
        while self.active or not self.q.empty():
            try:
                pending.append(self.q.get(timeout=0.1))
            except queue.Empty:
                pass
            if pending and (sum(len(p) for p in pending) >= 4800 or not self.active):   # ~0.1 s: the waveform keeps up
                data = np.concatenate(pending)
                pending = []
                for j, c in enumerate(self.chans):
                    self.files[c].write(data[:, j])
                    acc = self.peak_acc[c]
                    acc.append(data[:, j])
                self.frames += len(data)
                self._roll_peaks()
                now = time.time()
                if now - self.last_sync > 5:          # push to the disk every few seconds
                    self.last_sync = now
                    for f in self.files.values():
                        try:
                            f.flush()
                        except Exception:
                            pass
                    self._check_disk()
        if pending:
            data = np.concatenate(pending)
            for j, c in enumerate(self.chans):
                self.files[c].write(data[:, j])
                self.peak_acc[c].append(data[:, j])
            self.frames += len(data)
            self._roll_peaks()

    def _roll_peaks(self):
        add = 0
        for c in self.chans:
            buf = np.concatenate(self.peak_acc[c]) if self.peak_acc[c] else np.zeros(0, np.float32)
            n = len(buf) // PEAK_RES
            if n:
                pk = np.abs(buf[: n * PEAK_RES]).reshape(n, PEAK_RES).max(axis=1).astype(np.float16)
                arr = self.flat[c]
                if self.n + n > len(arr):
                    grown = np.zeros(max(len(arr) * 2, self.n + n), np.float16)
                    grown[: self.n] = arr[: self.n]
                    self.flat[c] = arr = grown
                arr[self.n: self.n + n] = pk
                add = n
            self.peak_acc[c] = [buf[n * PEAK_RES:]]
        self.n += add   # every channel gets the same number of samples, so one count serves all

    def peaks_from(self, k):
        """Waveform outline values from index k onwards, per channel, as 0-255."""
        n = self.n
        return {c: np.minimum(self.flat[c][k:n].astype(np.float32) * 255, 255).astype(np.uint8).tolist() for c in self.chans}, n

    def _check_disk(self):
        """Running out of disk: warn with ~15 minutes left, stop cleanly with ~1 minute left."""
        try:
            free = shutil.disk_usage(self.session.dir).free
        except Exception:
            return
        per_sec = self.session.sr * 3 * max(len(self.chans), 1)
        left = free / per_sec
        self.disk_warn = left < 15 * 60
        self.disk_low = left < 60

    def stop(self):
        """Finish writing; returns the new clips."""
        if not self.active:
            return []
        self.active = False
        self.thread.join()
        s = self.session
        clips = []
        for c in self.chans:
            self.files[c].close()
            rel = self.rels[c]
            pk = self.flat[c][: self.n].copy()
            np.save(s.peaks_path(rel), pk)
            if self.frames:
                clips.append(Session.new_clip(c, rel, self.start_pos, self.frames, name=f"Take {s.take}"))
            else:
                os.remove(os.path.join(s.dir, rel))
        with s.lock:
            s._checkpoint()
            s.clips.extend(clips)
            s._bump()
        try:
            os.remove(os.path.join(s.dir, "recording.json"))   # finished cleanly
        except OSError:
            pass
        return clips
