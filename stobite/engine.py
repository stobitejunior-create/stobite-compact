"""Audio device I/O, transport, playback feeder and offline export."""
import collections
import json
import os
import sys
import threading
import time
import traceback

import numpy as np
import soundfile as sf

if sys.platform == "win32":
    os.environ.setdefault("SD_ENABLE_ASIO", "1")  # expose Behringer WING ASIO driver
import sounddevice as sd

from .mixer import Mixer, Insert
from .cables import CableIO
from .session import Session, Reader, Recorder, home_dir, list_sessions

DEFAULT_CFG = {
    "input": None, "output": None, "sr": 48000, "block": 256, "nch": 48,
    "main_l": 0, "main_r": 1, "direct_outs": False, "direct_offset": 0,
    "monitor_live": True, "session": None, "pin": "",
    "mon_l": -1, "mon_r": -1,              # optional separate monitor (headphone) outputs
    "cable_out": None, "cable_in": None,    # system loopback device(s) for the virtual cables
    "show_wing": False,
}


def cfg_path():
    return os.path.join(home_dir(), "config.json")


def load_cfg():
    cfg = dict(DEFAULT_CFG)
    try:
        with open(cfg_path()) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def list_devices():
    apis = sd.query_hostapis()
    out = []
    for i, d in enumerate(sd.query_devices()):
        out.append({"id": i, "name": d["name"], "api": apis[d["hostapi"]]["name"],
                    "ins": d["max_input_channels"], "outs": d["max_output_channels"],
                    "sr": d["default_samplerate"],
                    "wing": any(k in d["name"].upper() for k in ("WING", "BEHRINGER"))})
    return out


def find_named(name, kind):
    """Exact device lookup (no fallback) for optional devices like the cable loopback."""
    if not name:
        return None
    key = "ins" if kind == "input" else "outs"
    for d in list_devices():
        if (f'{d["name"]} ({d["api"]})' == name or d["name"] == name) and d[key] > 0:
            return d["id"]
    return None


def monitor_mix(x, mode):
    """Engineer's checks: mono compatibility, mid only, side only, left, right."""
    if mode == "mono":
        m = (x[:, 0] + x[:, 1]) * 0.5
        return np.stack([m, m], axis=1)
    if mode == "mid":
        m = (x[:, 0] + x[:, 1]) * 0.5
        return np.stack([m, m], axis=1)
    if mode == "side":
        sd_ = (x[:, 0] - x[:, 1]) * 0.5
        return np.stack([sd_, -sd_], axis=1)
    if mode == "left":
        return np.stack([x[:, 0], x[:, 0]], axis=1)
    if mode == "right":
        return np.stack([x[:, 1], x[:, 1]], axis=1)
    return x


AUTOMATABLE = {
    ("channels", "sends"), ("buses", "fader"), ("buses", "mute"), ("buses", "sends"), ("buses", "duck"),
    ("fx", "ret"), ("fx", "mute"), ("fx", "duck"), ("master", "width"), ("ins",),
}


def automatable(path):
    if path[0] == "ins":
        return True
    return len(path) >= 3 and (path[0], path[2]) in AUTOMATABLE or (len(path) == 2 and path == ["master", "width"])


def auto_target(path):
    """Which automation-mode button governs this parameter."""
    p0 = str(path[0])
    if p0 == "channels":
        return str(path[1])
    if p0 == "buses":
        return f"bus:{path[1]}"
    if p0 == "fx":
        return f"fx:{path[1]}"
    if p0 == "ins":
        t = str(path[1])
        return "master" if t == "master" else (t if not t.startswith("bus:") else t)
    return "master"


def find_device(name, kind):
    """Find device index by saved name; fall back to a WING, then the default."""
    devs = list_devices()
    key = "ins" if kind == "input" else "outs"
    if name:
        for d in devs:
            if f'{d["name"]} ({d["api"]})' == name and d[key] > 0:
                return d["id"]
        for d in devs:
            if d["name"] == name and d[key] > 0:
                return d["id"]
    wings = [d for d in devs if d["wing"] and d[key] > 0]
    if wings:
        asio = [d for d in wings if "ASIO" in d["api"]]
        return (asio or wings)[0]["id"]
    try:
        idx = sd.default.device[0 if kind == "input" else 1]
        return idx if idx is not None and idx >= 0 else None
    except Exception:
        return None


class Feeder:
    """Background thread that renders the timeline ahead of the audio callback."""
    CHUNK = 4096
    AHEAD = 6

    def __init__(self, engine):
        self.e = engine
        self.chunks = collections.deque()
        self.gen = 0
        self.pos = 0
        self.cur = None
        self.cur_off = 0
        self.wake = threading.Event()
        self.reader = None
        self.running = True
        threading.Thread(target=self._run, daemon=True).start()

    def seek(self, pos):
        self.gen += 1
        self.pos = int(pos)
        self.chunks.clear()
        self.wake.set()

    def _run(self):
        while self.running:
            s = self.e.session
            if s is None or not self.e.playing or len(self.chunks) >= self.AHEAD:
                self.wake.wait(0.02)
                self.wake.clear()
                continue
            if self.reader is None or self.reader.s is not s:
                if self.reader:
                    self.reader.close()
                self.reader = Reader(s)
            gen, pos = self.gen, self.pos
            lp = s.loop
            looping = lp["on"] and lp["end"] - lp["start"] > 2048 and lp["start"] <= pos < lp["end"]
            try:
                if looping and pos + self.CHUNK > lp["end"]:
                    n1 = lp["end"] - pos
                    data = np.concatenate([self.reader.render(pos, n1), self.reader.render(lp["start"], self.CHUNK - n1)])
                    nxt = lp["start"] + self.CHUNK - n1
                else:
                    data = self.reader.render(pos, self.CHUNK)
                    nxt = pos + self.CHUNK
            except Exception:
                traceback.print_exc()
                data = np.zeros((self.CHUNK, s.nch), np.float32)
                nxt = pos + self.CHUNK
            if gen == self.gen:
                self.chunks.append((gen, data))
                self.pos = nxt

    def pull(self, frames, nch):
        out = np.zeros((frames, nch), np.float32)
        got = 0
        while got < frames:
            if self.cur is None:
                while self.chunks:
                    gen, data = self.chunks.popleft()
                    if gen == self.gen:
                        self.cur, self.cur_off = data, 0
                        break
                if self.cur is None:
                    self.e.underruns += 1
                    break
            n = min(frames - got, len(self.cur) - self.cur_off)
            w = min(nch, self.cur.shape[1])
            out[got:got + n, :w] = self.cur[self.cur_off:self.cur_off + n, :w]
            got += n
            self.cur_off += n
            if self.cur_off >= len(self.cur):
                self.cur = None
        self.wake.set()
        return out

    def flush(self):
        self.cur = None


class Engine:
    def __init__(self):
        self.cfg = load_cfg()
        self.nch = int(self.cfg["nch"])
        self.sr = int(self.cfg["sr"])
        self.mixer = Mixer(self.nch, self.sr)
        self.session = None
        self.stream = None
        self.status = "stopped"
        self.error = ""
        self.playing = False
        self.recording = False
        self.playhead = 0
        self.underruns = 0
        self.xruns = 0
        self.load = 0.0
        self.dev_ins = 0
        self.dev_outs = 0
        self.recorder = Recorder()
        self.feeder = Feeder(self)
        self.listeners = []
        self.export_job = None
        self.dirty = False
        self.cables = CableIO()
        self.auto_values = {}
        self.touching = {}     # automation key -> (last write pos, wall time)
        self.last_auto = None
        name = self.cfg.get("session")
        try:
            self.open_session(name) if name else self.new_session("First Session")
        except Exception:
            self.new_session(time.strftime("Session %Y-%m-%d"))
        threading.Thread(target=self._autosave, daemon=True).start()
        threading.Thread(target=self._auto_loop, daemon=True).start()

    # ------------------------------------------------------------- config
    def save_cfg(self):
        with open(cfg_path(), "w") as f:
            json.dump(self.cfg, f, indent=2)

    def emit(self, kind, data=None):
        for fn in list(self.listeners):
            try:
                fn(kind, data)
            except Exception:
                pass

    # ------------------------------------------------------------- devices
    def start_audio(self):
        self.stop_audio()
        try:
            ind = find_device(self.cfg.get("input"), "input")
            outd = find_device(self.cfg.get("output"), "output")
            if outd is None:
                raise RuntimeError("No output device found")
            self.dev_ins = sd.query_devices(ind)["max_input_channels"] if ind is not None else 0
            self.dev_outs = sd.query_devices(outd)["max_output_channels"]
            sr = int(self.cfg["sr"])
            kw = dict(samplerate=sr, blocksize=int(self.cfg["block"]), dtype="float32",
                      latency="low", callback=self._callback)
            if ind is not None and self.dev_ins > 0:
                self.stream = sd.Stream(device=(ind, outd), channels=(self.dev_ins, self.dev_outs), **kw)
            else:
                self.stream = sd.OutputStream(device=outd, channels=self.dev_outs,
                                              callback=lambda o, f, t, s: self._callback(None, o, f, t, s),
                                              **{k: v for k, v in kw.items() if k != "callback"})
            if sr != self.sr:
                self.sr = sr
                self.mixer = Mixer(self.nch, sr, self.mixer.snapshot())
            self.stream.start()
            self.in_name = sd.query_devices(ind)["name"] if ind is not None else "None"
            self.out_name = sd.query_devices(outd)["name"]
            self.status, self.error = "running", ""
            self.start_cables()
        except Exception as ex:
            self.stream = None
            self.status, self.error = "error", str(ex)
        self.emit("status")

    def start_cables(self):
        co = find_named(self.cfg.get("cable_out"), "output")
        ci = find_named(self.cfg.get("cable_in"), "input")
        self.cables.start(co, ci, self.sr, int(self.cfg["block"]))

    def stop_audio(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        self.status = "stopped"

    def _callback(self, indata, outdata, frames, tinfo, status):
        t0 = time.perf_counter()
        try:
            if status:
                self.xruns += 1
            nch = self.nch
            mixer = self.mixer
            cable_in = self.cables.exchange(mixer.cable_out, frames)
            hw = indata if indata is not None else np.zeros((frames, 0), np.float32)
            # each channel's chosen input, exactly as it arrived: no trim, EQ, dynamics or fader
            raw = mixer.route_inputs(hw, cable_in)
            if self.recording:
                self.recorder.push(raw)
            if self.playing and not self.recording:
                src = self.feeder.pull(frames, nch)
                live_mask = self.live_tracks()
                if live_mask is not None:  # channels with no recorded audio stay live (mics, cable returns)
                    src[:, live_mask] = raw[:, live_mask]
            elif self.cfg["monitor_live"] or self.recording:
                src = raw.copy()
            else:
                src = np.zeros((frames, nch), np.float32)
                np.maximum(mixer.m_in, np.abs(raw).max(axis=0), out=mixer.m_in)
            direct = np.zeros((frames, nch), np.float32) if self.cfg["direct_outs"] else None
            if self.playing and not self.recording and self.session is not None:
                mixer.auto = self.last_auto = self.auto_for(self.session, self.playhead, self.touched())
            else:
                mixer.auto = None
            master = mixer.process(src, direct)
            outdata.fill(0)
            outs = outdata.shape[1]
            if direct is not None:
                off = int(self.cfg["direct_offset"])
                n = max(0, min(nch, outs - off))
                outdata[:, off:off + n] = direct[:, :n]
            l, r = int(self.cfg["main_l"]), int(self.cfg["main_r"])
            if 0 <= l < outs:
                outdata[:, l] = master[:, 0]
            if 0 <= r < outs:
                outdata[:, r] = master[:, 1]
            ml, mr = int(self.cfg.get("mon_l", -1)), int(self.cfg.get("mon_r", -1))
            mode = mixer.state.get("monitor", "stereo")
            if (0 <= ml < outs and 0 <= mr < outs) or mode != "stereo":
                mon = monitor_mix(master, mode)
                if 0 <= ml < outs and 0 <= mr < outs:
                    outdata[:, ml], outdata[:, mr] = mon[:, 0], mon[:, 1]
                elif mode != "stereo" and 0 <= l < outs and 0 <= r < outs:
                    # no separate monitor outs: the check applies to the main outs (and so the stream)
                    outdata[:, l], outdata[:, r] = mon[:, 0], mon[:, 1]
            if self.playing or self.recording:
                lp = self.session.loop if self.session else None
                before = self.playhead
                self.playhead += frames
                if (self.playing and not self.recording and lp and lp["on"] and lp["end"] - lp["start"] > 2048
                        and lp["start"] <= before < lp["end"] <= self.playhead):
                    self.playhead = lp["start"] + (self.playhead - lp["end"])
        except Exception:
            outdata.fill(0)
            traceback.print_exc()
        dt = time.perf_counter() - t0
        self.load = max(self.load * 0.95, dt / (frames / self.sr))

    # ------------------------------------------------------------- automation
    @staticmethod
    def auto_for(s, pos, skip=()):
        lanes = s.auto_lanes()
        if not lanes:
            return None
        out = {"fader": {}, "pan": {}, "mute": {}, "master": None}
        for key in lanes:
            if not (key.startswith("ch:") or key == "master:fader"):
                continue  # buses, FX, sends, plug-ins: applied by the automation thread
            parts = key.split(":")
            if parts[0] == "ch" and not parts[1].isdigit():
                continue
            target = parts[1] if parts[0] == "ch" else "master"
            if s.automode.get(target, "read") == "off" or key in skip:
                continue
            v = s.auto_value(key, pos)
            if parts[0] == "master":
                out["master"] = v
            elif int(parts[1]) < s.nch:
                out[parts[2]][int(parts[1])] = v
        return out

    AUTO_FAST = ("fader", "pan", "mute")

    def live_tracks(self):
        s = self.session
        if s is None:
            return None
        key = (id(s), s.version)
        if getattr(self, "_live_key", None) != key:
            used = {c["track"] for c in s.clips}
            mask = np.array([i not in used for i in range(self.nch)])
            self._live_mask = mask if mask.any() else None
            self._live_key = key
        return self._live_mask

    def _auto_loop(self):
        """Applies automation for buses, FX, sends and plug-in parameters (the audio
        callback handles channel fader/pan/mute and the master fader itself)."""
        last = {}
        while True:
            time.sleep(0.01)
            s = self.session
            if not (s and self.playing and not self.recording):
                last.clear()
                continue
            try:
                skip = self.touched()
                for key in list(s.auto_lanes()):
                    if not key.startswith("p:") or key in skip:
                        continue
                    target = auto_target(key[2:].split("/"))
                    if s.automode.get(target, "read") == "off":
                        continue
                    v = s.auto_value(key, self.playhead)
                    if v is None or abs(last.get(key, 1e9) - v) < 0.05:
                        continue
                    last[key] = v
                    self.apply_auto_path(key[2:].split("/"), v)
            except Exception:
                traceback.print_exc()

    def apply_auto_path(self, path, v):
        path = [int(p) if p.lstrip("-").isdigit() else p for p in path]
        if path[0] == "ins":  # ins/<target>/<idx>/<param key>
            lst, _ = self._ins_target(str(path[1]))
            lst[int(path[2])].set_raw(str(path[3]), v)
            self.auto_values["/".join(map(str, path))] = v
            return
        if path[-1] == "mute":
            v = v >= 0.5
        self.mixer.set(path, v)
        self.auto_values["/".join(map(str, path))] = v

    def touched(self):
        now = time.time()
        return {k for k, (_, t) in self.touching.items() if now - t < 0.6}

    def touch(self, path, value):
        """Called when a control moves. Records it if that strip is in Touch mode and we're playing."""
        s = self.session
        if not (s and self.playing and not self.recording):
            return False
        if path[0] == "channels" and len(path) == 3 and path[2] in ("fader", "pan", "mute"):
            target, key = str(path[1]), f"ch:{path[1]}:{path[2]}"
        elif path == ["master", "fader"]:
            target, key = "master", "master:fader"
        elif automatable(path):
            target, key = auto_target(path), "p:" + "/".join(map(str, path))
        else:
            return False
        if s.automode.get(target) != "touch":
            return False
        prev = self.touching.get(key)
        since = prev[0] if prev and time.time() - prev[1] < 0.6 else None
        v = float(value) if not isinstance(value, bool) else (1.0 if value else 0.0)
        s.auto_write(key, self.playhead, v, since)
        self.touching[key] = (self.playhead, time.time())
        self.dirty = True
        return True

    # ------------------------------------------------------------- transport
    def play(self):
        if self.recording:
            return
        self.feeder.flush()
        self.feeder.seek(self.playhead)
        time.sleep(0.03)
        self.playing = True
        self.emit("transport")

    def stop(self):
        was_rec = self.recording
        self.playing = False
        if self.recording:
            self.recording = False
            self.recorder.stop()
            self.save()
            self.emit("session")
        self.feeder.flush()
        self.emit("transport")
        return was_rec

    def locate(self, pos):
        self.playhead = max(0, int(pos))
        if self.playing:
            self.feeder.flush()
            self.feeder.seek(self.playhead)
        self.emit("transport")

    def record(self):
        if self.recording or self.session is None:
            return
        if self.stream is None or self.dev_ins == 0:
            raise RuntimeError("No input device running - pick your WING in Setup first")
        self.playing = False
        start = self.session.length() if self.cfg.get("rec_at_end", True) and self.playhead < self.session.length() else self.playhead
        self.playhead = start
        self.recorder.start(self.session, start)
        self.recording = True
        self.emit("transport")

    def transport(self):
        return {"playing": self.playing, "recording": self.recording, "playhead": self.playhead,
                "sr": self.sr, "recFrames": self.recorder.frames if self.recording else 0,
                "dropped": self.recorder.dropped, "load": round(self.load, 3),
                "xruns": self.xruns, "underruns": self.underruns}

    # ------------------------------------------------------------- sessions
    def new_session(self, name):
        if self.recording:
            raise RuntimeError("Stop recording first")
        self.stop()
        self.save()
        s = Session(name, self.sr, self.nch)
        base = s.name
        k = 2
        while os.path.exists(os.path.join(s.dir, "session.json")):
            s = Session(f"{base} {k}", self.sr, self.nch)
            k += 1
        self.session = s
        self.playhead = 0
        s.save(self.mixer.snapshot())
        self.cfg["session"] = s.name
        self.save_cfg()
        self.emit("session")

    def open_session(self, name):
        if self.recording:
            raise RuntimeError("Stop recording first")
        self.stop()
        if self.session:
            self.save()
        s = Session.load(name, self.nch)
        if s.nch != self.nch:
            s.nch = self.nch
        self.session = s
        self.playhead = 0
        if s.mixer_state:
            self.mixer.replace_state(s.mixer_state)
            self.restore_inserts()
        self.cfg["session"] = s.name
        self.save_cfg()
        self.emit("session")
        self.emit("mixer")

    def save(self):
        if self.session:
            self.session.save(self.mixer.snapshot())
            self.dirty = False

    def _autosave(self):
        while True:
            time.sleep(10)
            if self.dirty and not self.recording:
                try:
                    self.save()
                except Exception:
                    traceback.print_exc()

    # ------------------------------------------------------------- plugins
    def restore_inserts(self):
        st = self.mixer.state
        for c, ch in enumerate(st["channels"]):
            self.mixer.inserts[c] = self._load_list(ch.get("inserts", []))
        self.mixer.minserts = self._load_list(st["master"].get("inserts", []))
        for b in st.get("buses", []):
            self.mixer.binserts[b["id"]] = self._load_list(b.get("inserts", []))

    def _load_list(self, lst):
        out = []
        for spec in lst:
            try:
                ins = Insert(spec["path"])
                for k, v in spec.get("params", {}).items():
                    ins.set_raw(k, v)
                ins.bypass = spec.get("bypass", False)
                out.append(ins)
            except Exception:
                traceback.print_exc()
        return out

    def _ins_target(self, target):
        if target == "master":
            return self.mixer.minserts, self.mixer.state["master"]
        if str(target).startswith("bus:"):
            bid = target[4:]
            st = next(b for b in self.mixer.state["buses"] if b["id"] == bid)
            return self.mixer.binserts.setdefault(bid, []), st
        c = int(target)
        return self.mixer.inserts[c], self.mixer.state["channels"][c]

    def add_insert(self, target, path):
        ins = Insert(path)
        lst, st = self._ins_target(target)
        st.setdefault("inserts", []).append({"path": path, "name": ins.name, "params": {}, "bypass": False})
        if target == "master":
            self.mixer.minserts = lst + [ins]
        elif str(target).startswith("bus:"):
            self.mixer.binserts[target[4:]] = lst + [ins]
        else:
            self.mixer.inserts[int(target)] = lst + [ins]
        self.dirty = True

    def remove_insert(self, target, idx):
        lst, st = self._ins_target(target)
        lst = [p for i, p in enumerate(lst) if i != idx]
        del st["inserts"][idx]
        if target == "master":
            self.mixer.minserts = lst
        elif str(target).startswith("bus:"):
            self.mixer.binserts[target[4:]] = lst
        else:
            self.mixer.inserts[int(target)] = lst
        self.dirty = True

    def insert_param(self, target, idx, key, value):
        lst, st = self._ins_target(target)
        lst[idx].set_raw(key, value)
        st["inserts"][idx]["params"][key] = float(value)
        self.dirty = True

    def insert_bypass(self, target, idx, value):
        lst, st = self._ins_target(target)
        lst[idx].bypass = bool(value)
        st["inserts"][idx]["bypass"] = bool(value)
        self.dirty = True

    # ------------------------------------------------------------- export
    def export(self, kind="mix", fmt="wav", start=None, end=None, target=None):
        if self.export_job and self.export_job.get("running"):
            raise RuntimeError("An export is already running")
        s = self.session
        start = int(start or 0)
        end = int(end or s.length())
        if end <= start:
            raise RuntimeError("Nothing to export - the timeline is empty")
        job = {"running": True, "progress": 0.0, "kind": kind, "file": None, "error": None}
        self.export_job = job
        threading.Thread(target=self._export, args=(job, kind, fmt, start, end, target), daemon=True).start()
        return job

    def _export(self, job, kind, fmt, start, end, target=None):
        s = self.session
        try:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            outdir = os.path.join(home_dir(), "Exports")
            reader = Reader(s)
            with s.lock:
                clips = [dict(c) for c in s.clips]
            block = 1024 if s.automation else 4096  # finer steps keep automation smooth
            if kind == "tracks":
                folder = os.path.join(outdir, f"{s.name} tracks {stamp}")
                os.makedirs(folder, exist_ok=True)
                used = sorted({c["track"] for c in clips if not c.get("mute")})
                names = self.mixer.state["channels"]
                files = {t: sf.SoundFile(os.path.join(folder, f"{t + 1:02d} {names[t]['name']}.wav".replace("/", "-")),
                                         "w", s.sr, 1, "PCM_24") for t in used}
                pos = start
                while pos < end:
                    n = min(block, end - pos)
                    d = reader.render(pos, n, clips)
                    for t, f in files.items():
                        f.write(d[:, t])
                    pos += n
                    job["progress"] = (pos - start) / (end - start)
                for f in files.values():
                    f.close()
                job["file"] = folder
            else:
                def make_mix(extra_db=0.0):
                    st = self.mixer.snapshot()
                    st["master"]["fader"] = min(st["master"]["fader"] + extra_db, 24.0)
                    st["master"]["mute"] = False
                    m = Mixer(s.nch, s.sr, st)
                    m.inserts = [self._load_list(ch.get("inserts", [])) for ch in m.state["channels"]]
                    m.minserts = self._load_list(m.state["master"].get("inserts", []))
                    m.binserts = {b["id"]: self._load_list(b.get("inserts", [])) for b in m.state["buses"]}
                    return m
                tail = 2 * s.sr
                passes = 2 if target is not None else 1
                gain = 0.0
                if target is not None:
                    # pass 1: measure integrated loudness of the mix as it stands
                    mix = make_mix()
                    mix.limiter.on = False
                    pos = start
                    while pos < end:
                        n = min(block, end - pos)
                        mix.auto = self.auto_for(s, pos)
                        mix.process(reader.render(pos, n, clips))
                        pos += n
                        job["progress"] = (pos - start) / (end - start) / passes
                    measured = mix.loud.integrated()
                    if measured > -70:
                        gain = max(min(float(target) - measured, 24.0), -24.0)
                    job["measured"] = round(measured, 1)
                    job["gain"] = round(gain, 1)
                mix = make_mix(gain)
                if target is not None:
                    mix.limiter.on = True
                # fresh plugin instances so the live engine's copies aren't shared across threads
                ext = "mp3" if fmt == "mp3" else "wav"
                path = os.path.join(outdir, f"{s.name} mix {stamp}.{ext}")
                kw = {"format": "MP3"} if ext == "mp3" else {"subtype": "PCM_24"}
                with sf.SoundFile(path, "w", s.sr, 2, **kw) as f:
                    pos = start
                    while pos < end + tail:
                        n = min(block, end + tail - pos)
                        d = reader.render(pos, n, clips) if pos < end else np.zeros((n, s.nch), np.float32)
                        mix.auto = self.auto_for(s, pos)
                        f.write(mix.process(d))
                        pos += n
                        job["progress"] = min(((passes - 1) + (pos - start) / (end + tail - start)) / passes, 1)
                job["file"] = path
                job["lufs"] = round(mix.loud.integrated(), 1)
            reader.close()
        except Exception as ex:
            traceback.print_exc()
            job["error"] = str(ex)
        job["running"] = False
        job["progress"] = 1.0
        self.emit("export")

    def info(self):
        return {"status": self.status, "error": self.error, "cfg": {k: v for k, v in self.cfg.items() if k != "pin"},
                "nIn": self.dev_ins,
                "hasPin": bool(self.cfg.get("pin")), "nch": self.nch, "sr": self.sr,
                "devIns": self.dev_ins, "devOuts": self.dev_outs,
                "inName": getattr(self, "in_name", ""), "outName": getattr(self, "out_name", ""),
                "home": home_dir(), "sessions": list_sessions()}
