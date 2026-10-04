"""Sessions on disk, the clip timeline, non-destructive edits and recording."""
import copy
import json
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
        self.peak_acc = {c: [] for c in self.chans}
        self.live_peaks = {c: [] for c in self.chans}
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
            if pending and (sum(len(p) for p in pending) >= 12000 or not self.active):
                data = np.concatenate(pending)
                pending = []
                for j, c in enumerate(self.chans):
                    self.files[c].write(data[:, j])
                    acc = self.peak_acc[c]
                    acc.append(data[:, j])
                self.frames += len(data)
                self._roll_peaks()
        if pending:
            data = np.concatenate(pending)
            for j, c in enumerate(self.chans):
                self.files[c].write(data[:, j])
                self.peak_acc[c].append(data[:, j])
            self.frames += len(data)
            self._roll_peaks()

    def _roll_peaks(self):
        for c in self.chans:
            buf = np.concatenate(self.peak_acc[c]) if self.peak_acc[c] else np.zeros(0, np.float32)
            n = len(buf) // PEAK_RES
            if n:
                self.live_peaks[c].append(np.abs(buf[: n * PEAK_RES]).reshape(n, PEAK_RES).max(axis=1).astype(np.float16))
            self.peak_acc[c] = [buf[n * PEAK_RES:]]

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
            pk = np.concatenate(self.live_peaks[c]) if self.live_peaks[c] else np.zeros(0, np.float16)
            np.save(s.peaks_path(rel), pk)
            if self.frames:
                clips.append(Session.new_clip(c, rel, self.start_pos, self.frames, name=f"Take {s.take}"))
            else:
                os.remove(os.path.join(s.dir, rel))
        with s.lock:
            s._checkpoint()
            s.clips.extend(clips)
            s._bump()
        return clips
