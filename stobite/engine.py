"""Audio device I/O, transport, playback feeder and offline export."""
import collections
import json
import math
import os
import sys
import shutil
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
from .inputs import ExtraInputs
from .guard import LoopGuard
from .listen import ListenOut, pick_listen_device, is_wing_name
from .session import Session, Reader, Recorder, home_dir, list_sessions, safe_name, scratch_dir, recover_interrupted

DEFAULT_CFG = {
    "input": None, "output": None, "sr": 48000, "block": 256, "nch": 48,
    "main_l": 0, "main_r": 1, "direct_outs": False, "direct_offset": 0,
    "monitor_live": True, "session": None, "pin": "",
    "mon_l": -1, "mon_r": -1,              # optional separate monitor (headphone) outputs
    "cable_out": None, "cable_in": None,    # system loopback device(s) for the virtual cables
    "show_wing": False,
    "export_dir": "",                       # empty = Stobite Compact/Exports
    # Safety: never send audio back into the WING unless asked. Its USB returns are often patched
    # into channels that also go back out over USB, which makes a screaming feedback loop.
    "wing_return": False,
    "listen": "auto",                       # where to hear the mix when the WING is the interface
    "stream_out": "",
    "theme": "auto",
    "hp_model": "", "hp_amount": 100,       # headphone correction (what you hear only)
    "metronome": False, "countin": False, "click_db": -12.0,   # click: headphones / speakers only                        # Auto (follow the computer) / light / dark                       # a second copy of the mix for OBS / Zoom, e.g. a virtual cable
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


_com = threading.local()


def com_init():
    """Windows: ASIO drivers are COM objects, and COM must be switched on in every thread that
    opens or closes an audio stream. PortAudio only does that in the thread that first loaded it,
    so opening the WING from any other thread fails with "Failed to load ASIO driver"."""
    if sys.platform != "win32" or getattr(_com, "ok", False):
        return
    try:
        import ctypes
        ctypes.windll.ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED, as ASIO expects
    except Exception:
        pass
    _com.ok = True


def device_fingerprint():
    """A cheap answer to "has an audio device been plugged in or removed?", asked of the
    operating system directly. (Re-scanning through PortAudio means restarting the audio.)
    None when the system can't tell us."""
    try:
        import ctypes
        if sys.platform == "darwin":
            ca = ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")

            class Addr(ctypes.Structure):
                _fields_ = [("sel", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("elem", ctypes.c_uint32)]
            four = lambda t: int.from_bytes(t.encode(), "big")
            addr = Addr(four("dev#"), four("glob"), 0)
            size = ctypes.c_uint32(0)
            if ca.AudioObjectGetPropertyDataSize(1, ctypes.byref(addr), 0, None, ctypes.byref(size)) != 0:
                return None
            ids = (ctypes.c_uint32 * (size.value // 4))()
            if ca.AudioObjectGetPropertyData(1, ctypes.byref(addr), 0, None, ctypes.byref(size), ids) != 0:
                return None
            return tuple(ids)
        if sys.platform == "win32":
            w = ctypes.windll.winmm
            return (w.waveInGetNumDevs(), w.waveOutGetNumDevs())
    except Exception:
        return None
    return None


API_RANK = {"ASIO": 0, "Windows WASAPI": 1, "Windows WDM-KS": 2, "MME": 3, "Windows DirectSound": 4}


def explain_audio_error(msg, api=""):
    """Turn PortAudio's error into what to check."""
    m = str(msg)
    if "ASIO" in m or api == "ASIO":
        if "load" in m.lower() or "-9999" in m:
            return (m + " | Check: 1) the USB cable runs from the WING's back-panel USB port to this PC (the network cable"
                    " carries control only, not audio); 2) no other program is using the WING's ASIO driver"
                    " (OBS, another DAW, a streaming app): close it; 3) the WING USB driver is installed, then"
                    " unplug/replug the USB cable and press Restart audio.")
    if "sample rate" in m.lower():
        return m + " | The WING and this app must use the same sample rate (48 kHz is the WING default)."
    return m


SLEEP_LEVEL = 3.2e-4  # -70 dBFS: any input above this wakes the engine instantly


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
    ("fx", "ret"), ("fx", "mute"), ("fx", "duck"), ("channels", "chain"), ("buses", "chain"),
}


def automatable(path):
    if path[0] == "master":
        return len(path) >= 3 and path[1] == "chain"
    return len(path) >= 3 and (path[0], path[2]) in AUTOMATABLE


def auto_target(path):
    """Which automation-mode button governs this parameter."""
    p0 = str(path[0])
    if p0 == "channels":
        return str(path[1])
    if p0 == "buses":
        return f"bus:{path[1]}"
    if p0 == "fx":
        return f"fx:{path[1]}"
    return "master"


def find_device(name, kind):
    """Find a device by its saved name.
    Input:  the chosen device, or with "Auto" the WING. Never the computer's own microphone:
            if the WING (or the chosen device) isn't connected there is simply no main input.
    Output: the chosen device, else a WING, else the system default output."""
    if name == "none":
        return None   # deliberately no device
    devs = list_devices()
    key = "ins" if kind == "input" else "outs"
    if name:
        for d in devs:
            if f'{d["name"]} ({d["api"]})' == name and d[key] > 0:
                return d["id"]
        for d in devs:
            if d["name"] == name and d[key] > 0:
                return d["id"]
        if kind == "input":
            return None  # the chosen interface isn't plugged in
    wings = [d for d in devs if d["wing"] and d[key] > 0]
    if wings:
        asio = [d for d in wings if "ASIO" in d["api"]]
        return (asio or wings)[0]["id"]
    if kind == "input":
        return None
    try:
        idx = sd.default.device[0 if kind == "input" else 1]
        return idx if idx is not None and idx >= 0 else None
    except Exception:
        return None


def pair_output(ind, outd):
    """An output that can share a stream with input device `ind`."""
    if ind is None:
        return outd
    devs = list_devices()
    di = devs[ind]
    if outd is not None and devs[outd]["api"] == di["api"] and (di["api"] != "ASIO" or outd == ind):
        return outd
    if di["api"] == "ASIO":
        return ind if di["outs"] > 0 else None
    same = [d for d in devs if d["api"] == di["api"] and d["outs"] > 0]
    wing = [d for d in same if d["wing"]]
    if wing:
        return wing[0]["id"]
    try:
        api_i = [a["name"] for a in sd.query_hostapis()].index(di["api"])
        dflt = sd.query_hostapis(api_i)["default_output_device"]
        if dflt is not None and dflt >= 0:
            return dflt
    except Exception:
        pass
    return same[0]["id"] if same else None


def input_candidates(name):
    """Main input devices to try, best first. If the WING's ASIO driver won't open, the WING's
    other Windows drivers (WASAPI, WDM-KS, MME) are tried before giving up."""
    first = find_device(name, "input")
    if first is None:
        return []
    devs = list_devices()
    picked = devs[first]
    if not picked["wing"]:
        return [first]
    rest = sorted((d for d in devs if d["wing"] and d["ins"] > 0 and d["id"] != first),
                  key=lambda d: (API_RANK.get(d["api"], 9), -d["ins"]))
    return [first] + [d["id"] for d in rest]


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
                self.wake.wait(0.02 if self.e.playing else 1.0)  # play()/seek() wake it immediately
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
        self.extra = ExtraInputs()   # other microphones / interfaces used by channels
        self.listen = ListenOut()    # the computer's own output, when the WING is the interface
        self.hp_eq = None            # headphone correction, made on first use
        self.stream_out = ListenOut()  # the mix for OBS / Zoom (usually "CABLE Input", a virtual cable)
        self.guard = LoopGuard(int(self.cfg["sr"]), self.nch)
        self.out_is_wing = False
        self.counting = 0            # samples of count-in left before recording starts
        self.tuner_ch = None         # channel the tuner listens to (its raw input)
        self.tuner_buf = np.zeros(8192, np.float32)
        self._clicks = []            # [wave, index] clicks still sounding
        self._click_waves = None
        self.quiet = 0          # samples of continuous input silence
        self.asleep = False     # idle: skip mixing until a signal arrives
        self.auto_values = {}
        self.touching = {}     # automation key -> (last write pos, wall time)
        self.last_auto = None
        name = self.cfg.get("session")
        try:
            if not name:
                raise FileNotFoundError
            self.open_session(name)
        except Exception:
            self.open_scratch()   # no project yet (or it was deleted): nothing is created until it's needed
        threading.Thread(target=self._autosave, daemon=True).start()
        threading.Thread(target=self._auto_loop, daemon=True).start()
        threading.Thread(target=self._extra_loop, daemon=True).start()
        threading.Thread(target=self._device_watch, daemon=True).start()
        threading.Thread(target=self._guard_loop, daemon=True).start()

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
        com_init()
        self.stop_audio()
        self.audio_note = ""
        try:
            sr = int(self.cfg["sr"])
            kw = dict(samplerate=sr, blocksize=int(self.cfg["block"]), dtype="float32", latency="low")
            no_out = self.cfg.get("output") == "none"
            want_out = None if no_out else find_device(self.cfg.get("output"), "output")
            failures = []
            ind = outd = None
            for cand in input_candidates(self.cfg.get("input")):
                o = None if no_out else pair_output(cand, want_out)
                if o is None and not no_out:
                    continue
                try:
                    nin = sd.query_devices(cand)["max_input_channels"]
                    if no_out:   # record / feed the stream output without playing on the interface
                        self.stream = sd.InputStream(device=cand, channels=nin,
                                                     callback=lambda i_, f, t, st: self._callback(i_, None, f, t, st), **kw)
                        ind, outd, self.dev_ins, self.dev_outs = cand, None, nin, 0
                        break
                    nout = sd.query_devices(o)["max_output_channels"]
                    self.stream = sd.Stream(device=(cand, o), channels=(nin, nout), callback=self._callback, **kw)
                    ind, outd, self.dev_ins, self.dev_outs = cand, o, nin, nout
                    break
                except Exception as ex:
                    api = list_devices()[cand]["api"]
                    failures.append(f"{sd.query_devices(cand)['name']} ({api}): {ex}")
                    print("Audio input failed:", failures[-1], flush=True)
                    self.stream = None
            if self.stream is None and no_out:
                self.dev_ins = self.dev_outs = 0
                self.in_name = self.out_name = ""
                self.out_is_wing = False
                self.listen.stop()
                self.stream_out.stop()
                self.status = "stopped"
                self.error = (explain_audio_error(failures[0]) if failures else
                              "No input and no output selected, so audio is off. Pick a device in Setup to hear or record."
                              if self.cfg.get("input") == "none" else
                              "Output is set to None and no input is connected (is the WING plugged in?), so audio is off.")
                self.emit("status")
                return
            if self.stream is None:
                # no main input: keep playback and the mixer working on the output alone
                outd = want_out
                if outd is not None and list_devices()[outd]["api"] == "ASIO" and failures:
                    outd = None   # the ASIO driver is the thing that failed: use Windows' normal output
                if outd is None:
                    try:
                        outd = sd.default.device[1]
                        outd = outd if outd is not None and outd >= 0 else None
                    except Exception:
                        outd = None
                if outd is None:
                    raise RuntimeError(explain_audio_error(failures[0]) if failures else "No output device found")
                self.dev_ins = 0
                self.dev_outs = sd.query_devices(outd)["max_output_channels"]
                self.stream = sd.OutputStream(device=outd, channels=self.dev_outs,
                                              callback=lambda o_, f, t, st: self._callback(None, o_, f, t, st),
                                              **kw)
            elif failures:
                self.audio_note = (f"The WING's first choice of driver failed, so it is connected through "
                                   f"{list_devices()[ind]['api']} instead ({self.dev_ins} channels). " + explain_audio_error(failures[0]))
            if sr != self.sr:
                self.sr = sr
                self.mixer = Mixer(self.nch, sr, self.mixer.snapshot())
                self.guard = LoopGuard(sr, self.nch)
            self.stream.start()
            self.in_name = sd.query_devices(ind)["name"] if ind is not None else ""
            self.in_is_wing = bool(self.in_name) and any(k in self.in_name.upper() for k in ("WING", "BEHRINGER"))
            self.out_name = sd.query_devices(outd)["name"] if outd is not None else ""
            self.out_is_wing = is_wing_name(self.out_name)
            self.start_listen()
            self.status, self.error = "running", ""
            if failures and ind is None:
                # output works but the WING didn't open: say why, loudly
                self.error = explain_audio_error(failures[0])
                self.audio_note = "Playback works, but no channels are coming in. " + self.error
            self.start_cables()
        except Exception as ex:
            self.stream = None
            self.status, self.error = "error", explain_audio_error(ex)
        self.emit("status")

    def start_listen(self):
        """Hear the mix on the computer when the WING (which gets nothing back by default) is the output."""
        if self.out_is_wing and self.stream is not None:
            self.listen.start(pick_listen_device(self.cfg.get("listen", "auto")), self.sr, int(self.cfg["block"]))
        else:
            self.listen.stop()
        choice = self.cfg.get("stream_out") or ""
        if choice and self.stream is not None:
            dev = pick_listen_device(choice)
            if dev is None:
                self.stream_out.stop()
                self.stream_out.error = f"{choice} isn't connected (is the virtual cable installed?)"
            else:
                self.stream_out.start(dev, self.sr, int(self.cfg["block"]))
        else:
            self.stream_out.stop()
            self.stream_out.error = ""

    def _guard_loop(self):
        """Look for feedback a few times a second while sound is going out (and watch the disk)."""
        while True:
            time.sleep(0.2)
            try:
                rec = self.recorder
                if self.recording and getattr(rec, "disk_low", False):
                    self.stop()
                    self.notify("Recording stopped: the disk is full. Everything up to now is saved.")
                elif self.recording and getattr(rec, "disk_warn", False) and not getattr(rec, "warned", False):
                    rec.warned = True
                    self.notify("The disk is nearly full: about 15 minutes of recording left.")
                if self.stream is None or self.asleep or self.guard.tripped:
                    continue
                names = [c.get("name", "") for c in self.mixer.state.get("channels", [])]
                if self.guard.check(names):
                    print(self.guard.message, flush=True)
                    self.emit("status")
            except Exception:
                traceback.print_exc()

    def reset_feedback(self):
        self.guard.reset()
        self.emit("status")

    def start_cables(self):
        co = find_named(self.cfg.get("cable_out"), "output")
        ci = find_named(self.cfg.get("cable_in"), "input")
        self.cables.start(co, ci, self.sr, int(self.cfg["block"]))

    def stop_audio(self):
        com_init()
        self.listen.stop()
        self.stream_out.stop()
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
        if outdata is None:   # input-only stream (output set to None): mix into a scratch buffer
            buf = getattr(self, "_null_out", None)
            if buf is None or buf.shape[0] != frames:
                buf = self._null_out = np.zeros((frames, 2), np.float32)
            outdata = buf
        try:
            if status:
                self.xruns += 1
            nch = self.nch
            mixer = self.mixer
            cable_in = self.cables.exchange(mixer.cable_out, frames)
            hw = indata if indata is not None else np.zeros((frames, 0), np.float32)
            extra, extra_map = self.extra.read(frames)
            # each channel's chosen input, exactly as it arrived: no trim, EQ, dynamics or fader
            raw = mixer.route_inputs(hw, cable_in, extra, extra_map)
            tc = self.tuner_ch
            if tc is not None and 0 <= tc < raw.shape[1]:   # the tuner hears the raw input, before any processing
                n = min(frames, len(self.tuner_buf))
                self.tuner_buf = np.concatenate([self.tuner_buf[n:], raw[-n:, tc]])
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
            # ---- sleep while idle: nothing playing, every input silent and the mix has rung out
            busy = self.playing or self.recording or self.counting > 0
            if not busy:
                in_pk = float(np.abs(src).max()) if src.size else 0.0
                self.quiet = 0 if in_pk > SLEEP_LEVEL else self.quiet + frames
                if self.quiet > self.sr * 3 and mixer.last_out_peak < 1e-5:
                    if not self.asleep:
                        self.asleep = True
                        mixer.cable_out = None
                    np.maximum(mixer.m_in, np.abs(raw).max(axis=0), out=mixer.m_in)
                    mixer.loud.silence(frames)
                    outdata.fill(0)
                    self.load = max(self.load * 0.95, (time.perf_counter() - t0) / (frames / self.sr))
                    return
            else:
                self.quiet = 0
            self.asleep = False
            direct = np.zeros((frames, nch), np.float32) if self.cfg["direct_outs"] else None
            if self.playing and not self.recording and self.session is not None:
                mixer.auto = self.last_auto = self.auto_for(self.session, self.playhead, self.touched())
            else:
                mixer.auto = None
            master = mixer.process(src, direct)
            outdata.fill(0)
            guard = self.guard
            guard.push(master.mean(axis=1), raw)
            if guard.tripped:   # feedback: everything stays silent until Unmute
                self._advance(frames)
                self.load = max(self.load * 0.95, (time.perf_counter() - t0) / (frames / self.sr))
                return
            self.stream_out.push(master)          # the stream never hears the click or the before/after compare
            proc = master                         # what the WING gets back (if that's switched on)
            hear = master                         # what you listen on: headphones / speakers
            if mixer.compare and mixer.before_out is not None and mixer.before_out.shape == master.shape:
                hear = mixer.before_out           # the unprocessed "before" mix
            hp = self.cfg.get("hp_model")
            if hp:                                # headphone correction: only what you listen on
                if self.hp_eq is None or self.hp_eq.sr != self.sr:
                    from .hpcorrect import HeadphoneEQ
                    self.hp_eq = HeadphoneEQ(self.sr)
                hear = self.hp_eq.process(hear, hp, float(self.cfg.get("hp_amount", 100)))
            click = self._click(frames)
            if click is not None:
                hear = hear + click[:, None]
            self.listen.push(hear)
            master = proc if self.out_is_wing else hear
            if self.out_is_wing and not self.cfg.get("wing_return", False):
                self._advance(frames)     # nothing goes back into the WING
                self.load = max(self.load * 0.95, (time.perf_counter() - t0) / (frames / self.sr))
                return
            outs = outdata.shape[1]
            if direct is not None:
                off = int(self.cfg["direct_offset"])
                n = max(0, min(nch, outs - off)) if off >= 0 else 0   # -1 = None
                if n:
                    outdata[:, off:off + n] = direct[:, :n]
            l, r = int(self.cfg["main_l"]), int(self.cfg["main_r"])
            if 0 <= l < outs:
                outdata[:, l] = master[:, 0]
            if 0 <= r < outs:
                outdata[:, r] = master[:, 1]
            ml, mr = int(self.cfg.get("mon_l", -1)), int(self.cfg.get("mon_r", -1))
            mode = mixer.state.get("monitor", "stereo")
            if (0 <= ml < outs and 0 <= mr < outs) or mode != "stereo":
                mon = monitor_mix(hear if 0 <= ml < outs and 0 <= mr < outs else master, mode)
                if 0 <= ml < outs and 0 <= mr < outs:
                    outdata[:, ml], outdata[:, mr] = mon[:, 0], mon[:, 1]
                elif mode != "stereo" and 0 <= l < outs and 0 <= r < outs:
                    # no separate monitor outs: the check applies to the main outs (and so the stream)
                    outdata[:, l], outdata[:, r] = mon[:, 0], mon[:, 1]
            self._advance(frames)
        except Exception:
            outdata.fill(0)
            traceback.print_exc()
        dt = time.perf_counter() - t0
        self.load = max(self.load * 0.95, dt / (frames / self.sr))

    NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]

    def tuner_read(self, a4=440.0):
        """Pitch of the tuner channel: note, cents off, Hz (or None when nothing is playing)."""
        from .autotune import yin
        x = self.tuner_buf.astype(np.float64)
        if float(np.sqrt(np.mean(x ** 2))) < 1e-3:       # quieter than -60 dBFS: nothing to tune
            return None
        hz, conf = yin(x, self.sr, 30.0, 1600.0, 0.12)
        if hz <= 0 or conf < 0.5:
            return None
        midi = 69 + 12 * math.log2(hz / a4)
        near = int(round(midi))
        return {"hz": round(hz, 1), "note": self.NOTE_NAMES[near % 12], "oct": near // 12 - 1,
                "cents": round((midi - near) * 100), "conf": round(conf, 2)}

    def _click(self, frames):
        """The metronome for this block (mono), or None. Beats follow the session tempo; the first
        beat of each bar is higher. Count-in counts its own bar before recording starts."""
        on = self.cfg.get("metronome") and (self.playing or self.recording)
        if not on and not self.counting and not self._clicks:
            return None
        if self._click_waves is None or self._click_waves[0] != self.sr:
            t = np.arange(int(self.sr * 0.03)) / self.sr
            env = np.exp(-t * 140).astype(np.float32)
            hi = (np.sin(2 * np.pi * 1600 * t) * env).astype(np.float32)
            lo = (np.sin(2 * np.pi * 1000 * t) * env).astype(np.float32)
            self._click_waves = (self.sr, hi, lo)
        _, hi, lo = self._click_waves
        bpm = float(self.mixer.state.get("tempo") or 120)
        per = 60.0 / max(bpm, 20) * self.sr
        beats = int((self.mixer.state.get("timesig") or [4, 4])[0])
        if self.counting:
            done = beats * per - self.counting          # samples into the count-in bar
            k0, k1 = math.ceil(done / per), math.ceil((done + frames) / per)
            for k in range(k0, min(k1, beats)):
                self._clicks.append([hi if k == 0 else lo, -int(round(k * per - done))])
            self.counting = max(0, self.counting - frames)
            if self.counting == 0:
                self._count_done.set()
        elif on:
            pos = self.playhead
            k0, k1 = math.ceil(pos / per), math.ceil((pos + frames) / per)
            for k in range(k0, k1):
                self._clicks.append([hi if k % beats == 0 else lo, -int(round(k * per - pos))])
        if not self._clicks:
            return None
        out = np.zeros(frames, np.float32)
        keep = []
        for c in self._clicks:
            wave, i = c
            start = max(0, -i)                 # where in this block the click begins
            src = max(0, i)
            n = min(frames - start, len(wave) - src)
            if n > 0:
                out[start:start + n] += wave[src:src + n]
            c[1] = src + n
            if c[1] < len(wave):
                keep.append(c)
        self._clicks = keep
        return out * (10 ** (float(self.cfg.get("click_db", -12)) / 20))

    def _advance(self, frames):
        """Move the playhead on (and round the loop) after each block."""
        if self.playing or self.recording:
            lp = self.session.loop if self.session else None
            before = self.playhead
            self.playhead += frames
            if (self.playing and not self.recording and lp and lp["on"] and lp["end"] - lp["start"] > 2048
                    and lp["start"] <= before < lp["end"] <= self.playhead):
                self.playhead = lp["start"] + (self.playhead - lp["end"])

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
            s = self.session
            if not (s and self.playing and not self.recording):
                last.clear()
                time.sleep(0.25)  # nothing to automate while stopped
                continue
            time.sleep(0.01)
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
        self.counting = 0     # stopping during a count-in cancels it
        if self.recording:
            self.recording = False
            self.recorder.stop()
            self.save()
            self.emit("session")
        self.feeder.flush()
        self.emit("transport")
        return was_rec

    def locate(self, pos):
        if self.recording or self.counting:
            return       # the playhead is the recording's position: moving it would cut the take short
        self.playhead = max(0, int(pos))
        if self.playing:
            self.feeder.flush()
            self.feeder.seek(self.playhead)
        self.emit("transport")

    def notify(self, text):
        """A message every screen should show (crash recovery, disk space...)."""
        self.notice = text
        self.emit("notice")

    def rec_check(self):
        """How long the disk can record the armed channels for."""
        s = self.session
        armed = sum(1 for a in (s.armed if s else []) if a) or 1
        try:
            free = shutil.disk_usage(s.dir if s else home_dir()).free
        except Exception:
            free = 0
        secs = free / (self.sr * 3 * armed)
        return {"free": free, "armed": armed, "seconds": int(secs), "gbPerHour": round(self.sr * 3 * armed * 3600 / 1e9, 1)}

    def record(self):
        if self.recording or self.session is None:
            return
        if self.stream is None or self.dev_ins == 0:
            raise RuntimeError("No input device running - pick your WING in Setup first")
        chk = self.rec_check()
        if chk["seconds"] < 10 * 60:
            raise RuntimeError(f"Only {chk['seconds'] // 60} minutes of space left on this disk for {chk['armed']} channels. Free some space (or disarm unused channels) first.")
        if self.counting:
            return
        self.promote()
        self.playing = False
        start = self.session.length() if self.cfg.get("rec_at_end", True) and self.playhead < self.session.length() else self.playhead
        self.playhead = start
        if self.cfg.get("countin"):
            # one bar of clicks first; the audio thread signals when it has played
            bpm = float(self.mixer.state.get("tempo") or 120)
            beats = int((self.mixer.state.get("timesig") or [4, 4])[0])
            self._count_done = threading.Event()
            self.asleep = False
            self.counting = int(beats * 60.0 / max(bpm, 20) * self.sr)
            self.emit("transport")

            def go():
                if self._count_done.wait(beats * 60.0 / max(bpm, 20) + 2) and self.counting == 0 and not self.recording:
                    self.recorder.start(self.session, start)
                    self.recording = True
                    self.emit("transport")
            threading.Thread(target=go, daemon=True).start()
            return
        self.recorder.start(self.session, start)
        self.recording = True
        self.emit("transport")

    def transport(self):
        return {"playing": self.playing, "recording": self.recording, "playhead": self.playhead,
                "sr": self.sr, "recFrames": self.recorder.frames if self.recording else 0,
                "recStart": self.recorder.start_pos if self.recording else None,
                "counting": self.counting > 0, "metronome": bool(self.cfg.get("metronome")), "countin": bool(self.cfg.get("countin")),
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

    def open_scratch(self):
        """No project open. Uses a hidden, empty project that is never listed."""
        if self.recording:
            raise RuntimeError("Stop recording first")
        self.stop()
        if self.session and not self.session.scratch:
            self.save()
        shutil.rmtree(scratch_dir(), ignore_errors=True)   # only ever holds an empty, unsaved project
        self.session = Session("", self.sr, self.nch, scratch=True)
        self.playhead = 0
        self.cfg["session"] = None
        self.save_cfg()
        self.emit("session")

    def promote(self):
        """Audio is about to go into the hidden project: make it a real one first, so nothing
        recorded or imported can ever be lost."""
        s = self.session
        if s is None or not s.scratch:
            return
        base = safe_name(time.strftime("Service %Y-%m-%d"))
        root = os.path.join(home_dir(), "Sessions")
        name, k = base, 2
        while os.path.exists(os.path.join(root, name)):
            name, k = f"{base} {k}", k + 1
        s.save(self.mixer.snapshot())
        shutil.move(s.dir, os.path.join(root, name))
        with s.lock:
            s.scratch, s.name, s.dir = False, name, os.path.join(root, name)
        s.save(self.mixer.snapshot())
        self.cfg["session"] = name
        self.save_cfg()
        self.emit("session")

    def open_session(self, name, progress=lambda frac, msg: None):
        if self.recording:
            raise RuntimeError("Stop recording first")
        self.stop()
        if self.session:
            self.save()
        progress(0.02, "Opening")
        s = Session.load(name, self.nch)
        # waveform overviews first (building a missing one reads the whole recording), so the
        # timeline draws at once; this is most of the wait on a long service
        files = sorted({c["file"] for c in s.clips})
        for k, f in enumerate(files):
            progress(0.05 + 0.8 * k / max(len(files), 1), f"Loading tracks {k + 1} of {len(files)}")
            try:
                s.peaks(f, 1024)
            except Exception:
                traceback.print_exc()
        progress(0.88, "Loading the mix")
        if s.nch != self.nch:
            s.nch = self.nch
        try:
            n = recover_interrupted(s)
            if n:
                s.save(s.mixer_state)
                self.notify(f"Recovered {n} track{'s' if n != 1 else ''} from a recording that was cut off (crash or power loss).")
        except Exception:
            traceback.print_exc()
        self.session = s
        self.playhead = 0
        if s.mixer_state:
            self.mixer.replace_state(s.mixer_state)
            self.restore_inserts()
        self.cfg["session"] = s.name
        self.save_cfg()
        progress(1.0, "Ready")
        self.emit("session")
        self.emit("mixer")

    def save(self):
        if self.session:
            self.session.save(self.mixer.snapshot())
            self.dirty = False

    def _device_watch(self):
        """While no main input is connected, connect the WING (or the chosen interface) as soon
        as it is plugged in. The audio is only restarted when the system's device list actually
        changes, and never while playing or recording."""
        com_init()
        last = device_fingerprint()
        quiet_since = time.time()
        while True:
            time.sleep(2)
            try:
                fp = device_fingerprint()
                changed = fp != last
                if fp is None:   # can't ask the system cheaply: fall back to an occasional re-scan
                    changed = time.time() - quiet_since > 30
                if not changed or self.dev_ins > 0 or self.playing or self.recording or self.status == "starting":
                    if self.dev_ins > 0:
                        last = fp      # connected: just keep the list current
                    continue
                last, quiet_since = fp, time.time()
                time.sleep(1.5)  # a device that was just plugged in needs a moment to be ready
                self.stop_audio()
                self.cables.stop()
                self.extra.stop()
                self._extra_force = True   # reopen other microphones after the re-scan
                try:  # PortAudio only sees newly plugged devices after a re-scan
                    sd._terminate()
                    sd._initialize()
                except Exception:
                    pass
                self.start_audio()
                if self.dev_ins > 0:
                    print(f"Connected to {self.in_name}", flush=True)
            except Exception:
                traceback.print_exc()

    def _extra_loop(self):
        """Open / close other input devices as channels start or stop using them."""
        com_init()
        last = None
        while True:
            time.sleep(1.0)
            try:
                want = frozenset(self.mixer.devices_in_use()) if self.stream is not None else frozenset()
                if want != last or getattr(self, "_extra_force", False):
                    self._extra_force = False
                    self.extra.sync(want, self.sr, int(self.cfg["block"]))
                    last = want
                    self.emit("status")
            except Exception:
                traceback.print_exc()

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
        """Plug-ins now live in each processing chain and are loaded by the mixer itself."""

    def plugin_params(self, mid):
        inst = self.mixer.plugins.get(mid)
        return inst.params() if inst is not None else []

    # ------------------------------------------------------------- export
    # LAME constant-bitrate steps: libsndfile takes a 0-1 "compression level", not kbps
    MP3_LEVEL = {320: 0.0, 256: 0.18, 224: 0.33, 192: 0.44, 160: 0.55, 128: 0.65, 112: 0.72, 96: 0.78, 64: 0.88}

    @classmethod
    def out_format(cls, fmt="wav", depth="24", kbps=None, channels=2):
        """(file extension, soundfile keyword arguments) for an export format."""
        pcm = {"16": "PCM_16", "24": "PCM_24", "32f": "FLOAT"}
        if fmt == "mp3":
            k = min(cls.MP3_LEVEL, key=lambda b: abs(b - int(kbps or 192)))
            return "mp3", {"format": "MP3", "subtype": "MPEG_LAYER_III", "bitrate_mode": "CONSTANT",
                           "compression_level": cls.MP3_LEVEL[k]}
        if fmt == "opus":
            # Opus is variable-rate: busy sound sits at the chosen rate, silence drops far below it.
            # Its level scale assumes stereo, so a mono file asks for twice the number to land on it.
            rate = int(kbps or 128) * (2 if channels == 1 else 1)
            level = min(max((514 - rate) / 502, 0.0), 1.0)
            return "opus", {"format": "OGG", "subtype": "OPUS", "compression_level": level}
        if fmt == "flac":
            return "flac", {"format": "FLAC", "subtype": pcm["24" if depth == "32f" else depth]}
        if fmt == "aiff":
            return "aiff", {"format": "AIFF", "subtype": pcm.get(depth, "PCM_24")}
        return "wav", {"format": "WAV", "subtype": pcm.get(depth, "PCM_24")}

    def export_dir(self):
        """Where exports go: the folder chosen in the Export window, or Stobite Compact/Exports."""
        d = self.cfg.get("export_dir") or ""
        if d and os.path.isdir(d) and os.access(d, os.W_OK):
            return d
        out = os.path.join(home_dir(), "Exports")
        os.makedirs(out, exist_ok=True)
        return out

    def export_estimate(self, start=None, end=None):
        """What the export window needs to predict file sizes."""
        s = self.session
        start = int(start or 0)
        end = int(end or s.length())
        with s.lock:
            tracks = len({c["track"] for c in s.clips if not c.get("mute")})
        proj = 0
        for root, _, names in os.walk(s.dir):
            for n in names:
                if not n.endswith(".tmp"):
                    try:
                        proj += os.path.getsize(os.path.join(root, n))
                    except OSError:
                        pass
        outdir = self.export_dir()
        return {"folder": outdir, "default": outdir == os.path.join(home_dir(), "Exports"), "seconds": max(end - start, 0) / s.sr, "tail": 2.0, "sr": s.sr, "tracks": tracks,
                "projectBytes": proj, "freeBytes": shutil.disk_usage(outdir).free}

    def export(self, kind="mix", fmt="wav", start=None, end=None, target=None, depth="24", kbps=None, channels=2, extra=None):
        if self.export_job and self.export_job.get("running"):
            raise RuntimeError("An export is already running")
        s = self.session
        start = int(start or 0)
        end = int(end or s.length())
        if end <= start:
            raise RuntimeError("Nothing to export - the timeline is empty")
        job = {"running": True, "progress": 0.0, "kind": kind, "file": None, "error": None}
        self.export_job = job
        if fmt == "opus" and s.sr not in (8000, 12000, 16000, 24000, 48000):
            raise RuntimeError("Opus needs a 48 kHz session. Pick MP3 or another format.")
        if fmt == "mp3" and s.sr > 48000:
            raise RuntimeError("MP3 can't go above 48 kHz. Pick WAV, AIFF or FLAC.")
        opts = {"depth": str(depth), "kbps": kbps, "channels": 1 if int(channels or 2) == 1 else 2, **(extra or {})}
        threading.Thread(target=self._export, args=(job, kind, fmt, start, end, target, opts), daemon=True).start()
        return job

    def _export(self, job, kind, fmt, start, end, target=None, opts=None):
        opts = opts or {}
        s = self.session
        try:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            outdir = self.export_dir()
            reader = Reader(s)
            with s.lock:
                clips = [dict(c) for c in s.clips]
            block = 1024 if s.automation else 4096  # finer steps keep automation smooth
            if kind == "tracks":
                folder = os.path.join(outdir, f"{s.name} tracks {stamp}")
                os.makedirs(folder, exist_ok=True)
                used = sorted({c["track"] for c in clips if not c.get("mute")})
                names = self.mixer.state["channels"]
                ext, kw = self.out_format(fmt if fmt in ("wav", "aiff", "flac") else "wav", opts.get("depth", "24"))
                files = {t: sf.SoundFile(os.path.join(folder, f"{t + 1:02d} {names[t]['name']}.{ext}".replace("/", "-")),
                                         "w", s.sr, 1, **kw) for t in used}
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
                job["bytes"] = sum(os.path.getsize(f.name) for f in files.values())
            else:
                from . import postservice
                tail = 2 * s.sr

                def make_mix(extra_db=0.0):
                    st = self.mixer.snapshot()
                    st["master"]["fader"] = min(st["master"]["fader"] + extra_db, 24.0)
                    st["master"]["mute"] = False
                    if kind == "podcast" and opts.get("speechOnly"):
                        # just the speaking: channels on the Preaching bus or set up as preacher / host
                        for g in st.get("dcas") or []:
                            g["solo"] = False
                        for ch in st["channels"]:
                            ch["solo"] = False
                            if not (ch.get("out") == "speech" or ch.get("type") in postservice.SPEECH):
                                ch["mute"] = True
                    return Mixer(s.nch, s.sr, st)

                def rd(pos, n):
                    """The recording from pos (which may be before the start: silence there)."""
                    if pos >= 0:
                        return reader.render(pos, n, clips) if pos < end else np.zeros((n, s.nch), np.float32)
                    out = np.zeros((n, s.nch), np.float32)
                    k = min(n, -pos)
                    if n > k:
                        out[k:] = reader.render(0, n - k, clips)
                    return out

                def mix_file(path, a, b, p0, p1, nout, kw, target, with_tail=True):
                    """Render [a, b) of the mix into path (two passes when matching a loudness target)."""
                    span = max(b - a, 1)
                    passes = 2 if target is not None else 1
                    gain = 0.0
                    if target is not None:
                        mix = make_mix()
                        mix.set_master_limiters(False)
                        pos = a
                        while pos < b:
                            n = min(block, b - pos)
                            mix.auto = self.auto_for(s, max(pos, 0))
                            mix.process(rd(pos, n))
                            pos += n
                            job["progress"] = p0 + (p1 - p0) * (pos - a) / span / passes
                        measured = mix.loud.integrated()
                        if measured > -70:
                            gain = max(min(float(target) - measured, 24.0), -24.0)
                        job["measured"], job["gain"] = round(measured, 1), round(gain, 1)
                    mix = make_mix(gain)
                    stop = b + (tail if with_tail else 0)
                    with sf.SoundFile(path, "w", s.sr, nout, **kw) as f:
                        pos = a
                        while pos < stop:
                            n = min(block, stop - pos)
                            mix.auto = self.auto_for(s, max(pos, 0))
                            y = mix.process(rd(pos, n) if pos < b else np.zeros((n, s.nch), np.float32))
                            f.write(y.mean(axis=1) if nout == 1 else y)
                            pos += n
                            job["progress"] = min(p0 + (p1 - p0) * ((passes - 1) + (pos - a) / max(stop - a, 1)) / passes, p1)
                    return round(mix.loud.integrated(), 1)

                nout = opts.get("channels", 2)
                if kind == "sections":
                    secs = opts.get("sections") or postservice.sections_from_markers(s)
                    if not secs:
                        raise RuntimeError("No sections: add markers at the start of each song (or use Find songs) first.")
                    ext, kw = self.out_format(fmt, opts.get("depth", "24"), opts.get("kbps"), nout)
                    folder = os.path.join(outdir, f"{s.name} sections {stamp}")
                    os.makedirs(folder, exist_ok=True)
                    total = sum(max(int(e_) - int(a_), 1) for _, a_, e_ in secs)
                    done = 0
                    for k, (name, a_, e_) in enumerate(secs):
                        a_, e_ = int(a_), int(e_)
                        fn = f"{k + 1:02d} {safe_name(name) or 'Section'}.{ext}"
                        mix_file(os.path.join(folder, fn), a_, e_, done / total, (done + e_ - a_) / total, nout, kw, target)
                        done += e_ - a_
                    job["file"] = folder
                    job["bytes"] = sum(os.path.getsize(os.path.join(folder, x)) for x in os.listdir(folder))
                elif kind == "podcast":
                    tags = opts.get("tags") or {}
                    nout = 1 if opts.get("mono", True) else 2
                    ext, kw = self.out_format("mp3", "16", opts.get("kbps") or 96, nout)
                    title = tags.get("title") or f"{s.name}"
                    path = os.path.join(outdir, f"{safe_name(title)} {stamp}.mp3")
                    job["lufs"] = mix_file(path, start, end, 0.0, 1.0, nout, kw, target if target is not None else -16.0)
                    postservice.tag_mp3(path, title=title, artist=tags.get("artist", ""), album=tags.get("album", ""),
                                        year=tags.get("year", time.strftime("%Y")), comment=tags.get("comment", ""))
                    job["file"], job["bytes"] = path, os.path.getsize(path)
                else:
                    ext, kw = self.out_format(fmt, opts.get("depth", "24"), opts.get("kbps"), nout)
                    label = "for video" if kind == "video" else "mix"
                    path = os.path.join(outdir, f"{s.name} {label} {stamp}.{ext}")
                    job["lufs"] = mix_file(path, start, end, 0.0, 1.0, nout, kw, target, with_tail=(kind != "video" and opts.get("tail", True)))
                    job["file"], job["bytes"] = path, os.path.getsize(path)
            reader.close()
        except Exception as ex:
            traceback.print_exc()
            job["error"] = str(ex)
        job["running"] = False
        job["progress"] = 1.0
        self.emit("export")

    def info(self):
        return {"status": self.status, "error": self.error, "cfg": {k: v for k, v in self.cfg.items() if k != "pin"},
                "extraInputs": dict(self.extra.status),
                "nIn": self.dev_ins, "inIsWing": bool(getattr(self, "in_is_wing", False)),
                "hasPin": bool(self.cfg.get("pin")), "nch": self.nch, "sr": self.sr,
                "devIns": self.dev_ins, "devOuts": self.dev_outs,
                "inName": getattr(self, "in_name", ""), "audioNote": getattr(self, "audio_note", ""),
                "feedback": self.guard.message if self.guard.tripped else "",
                "outIsWing": self.out_is_wing, "listenName": self.listen.name, "listenError": self.listen.error,
                "streamOutName": self.stream_out.name, "streamOutError": self.stream_out.error, "outName": getattr(self, "out_name", ""),
                "home": home_dir(), "sessions": list_sessions()}
