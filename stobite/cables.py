"""Four stereo virtual cables.

Inside the app each cable works like a VB-Cable: whatever you route *to* it
(master, a bus or a channel) comes back out of it as an input you can put on
any channel - a "speaker" and a "microphone" at the same time.

To reach other apps (OBS, Zoom, YouTube Studio, a second DAW) the cables can be
attached to a system loopback device:
  Mac:     BlackHole 16ch  (cable 1 = channels 1-2, cable 2 = 3-4, ...)
  Windows: VB-Audio Virtual Cable (CABLE Input / CABLE Output), or A+B / C+D
Without a device the cables loop back internally.
"""
import threading

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover
    sd = None

N_CABLES = 4
CH = N_CABLES * 2


class Ring:
    """Single-producer / single-consumer ring of float32 frames (frames, CH)."""

    def __init__(self, size=48000):
        self.buf = np.zeros((size, CH), np.float32)
        self.r = 0
        self.w = 0
        self.lock = threading.Lock()

    def avail(self):
        return (self.w - self.r) % len(self.buf)

    def write(self, x):
        n = len(self.buf)
        with self.lock:
            k = len(x)
            idx = (self.w + np.arange(k)) % n
            self.buf[idx, :x.shape[1]] = x
            self.w = (self.w + k) % n
            if self.avail() > n // 2:  # consumer stalled or clocks drifted: drop the oldest
                self.r = (self.w - n // 4) % n

    def read(self, frames):
        out = np.zeros((frames, CH), np.float32)
        with self.lock:
            k = min(frames, self.avail())
            if k:
                idx = (self.r + np.arange(k)) % len(self.buf)
                out[frames - k:] = self.buf[idx]
                self.r = (self.r + k) % len(self.buf)
        return out


class CableIO:
    def __init__(self):
        self.to_dev = Ring()
        self.from_dev = Ring()
        self.loop = None          # internal loopback block when no device is attached
        self.streams = []
        self.status = "internal"
        self.error = ""
        self.names = ("", "")

    # ---- called from the main audio callback
    def exchange(self, cable_out, frames):
        """Send this block's cable outputs; return this block's cable inputs (frames, 8)."""
        if not self.streams:
            back = self.loop if self.loop is not None and len(self.loop) == frames else np.zeros((frames, CH), np.float32)
            self.loop = cable_out.copy() if cable_out is not None else None
            return back
        if cable_out is not None:
            self.to_dev.write(cable_out)
        return self.from_dev.read(frames)

    # ---- device side
    def _cb_duplex(self, indata, outdata, frames, t, status):
        outdata.fill(0)
        blk = self.to_dev.read(frames)
        n = min(outdata.shape[1], CH)
        outdata[:, :n] = blk[:, :n]
        self.from_dev.write(indata[:, :min(indata.shape[1], CH)])

    def _cb_out(self, outdata, frames, t, status):
        outdata.fill(0)
        blk = self.to_dev.read(frames)
        n = min(outdata.shape[1], CH)
        outdata[:, :n] = blk[:, :n]

    def _cb_in(self, indata, frames, t, status):
        self.from_dev.write(indata[:, :min(indata.shape[1], CH)])

    def stop(self):
        for s in self.streams:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
        self.streams = []
        self.status = "internal"

    def start(self, out_dev, in_dev, sr, block):
        """out_dev/in_dev: device indices (the same index for BlackHole-style duplex devices)."""
        from .engine import com_init
        com_init()
        self.stop()
        if sd is None or (out_dev is None and in_dev is None):
            return
        try:
            kw = dict(samplerate=sr, blocksize=block, dtype="float32", latency="low")
            if out_dev is not None and out_dev == in_dev:
                d = sd.query_devices(out_dev)
                s = sd.Stream(device=(in_dev, out_dev), channels=(min(d["max_input_channels"], CH), min(d["max_output_channels"], CH)),
                              callback=self._cb_duplex, **kw)
                self.streams = [s]
                self.names = (d["name"], d["name"])
            else:
                if out_dev is not None:
                    d = sd.query_devices(out_dev)
                    self.streams.append(sd.OutputStream(device=out_dev, channels=min(d["max_output_channels"], CH), callback=self._cb_out, **kw))
                if in_dev is not None:
                    d2 = sd.query_devices(in_dev)
                    self.streams.append(sd.InputStream(device=in_dev, channels=min(d2["max_input_channels"], CH), callback=self._cb_in, **kw))
                self.names = (sd.query_devices(out_dev)["name"] if out_dev is not None else "",
                              sd.query_devices(in_dev)["name"] if in_dev is not None else "")
            for s in self.streams:
                s.start()
            self.status, self.error = "device", ""
        except Exception as ex:
            self.stop()
            self.status, self.error = "error", str(ex)
