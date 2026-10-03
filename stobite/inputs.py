"""Extra input devices: any microphone the computer can see (built-in mic, a USB
mic, a webcam, a second interface) can feed a channel alongside the WING.

A channel's input "dev:<device key>|<channel>" (device key = "Name (API)").
Each device in use gets its own input stream, opened only while some channel
uses it. Its clock is independent of the main interface, so a small buffer
absorbs the difference (an occasional sample is dropped or repeated).
"""
import threading

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover
    sd = None


def parse_dev(spec):
    """'dev:Name (API)|3' -> ('Name (API)', 3) or None."""
    if not isinstance(spec, str) or not spec.startswith("dev:") or "|" not in spec:
        return None
    key, _, ch = spec[4:].rpartition("|")
    try:
        return key, int(ch)
    except ValueError:
        return None


class _Ring:
    def __init__(self, nch, size=48000):
        self.buf = np.zeros((size, nch), np.float32)
        self.r = self.w = 0
        self.lock = threading.Lock()

    def write(self, x):
        n = len(self.buf)
        with self.lock:
            idx = (self.w + np.arange(len(x))) % n
            self.buf[idx] = x
            self.w = (self.w + len(x)) % n
            if (self.w - self.r) % n > n // 2:  # reader fell behind: keep latency low
                self.r = (self.w - 1024) % n

    def read(self, frames):
        n = len(self.buf)
        out = np.zeros((frames, self.buf.shape[1]), np.float32)
        with self.lock:
            k = min(frames, (self.w - self.r) % n)
            if k:
                idx = (self.r + np.arange(k)) % n
                out[frames - k:] = self.buf[idx]
                self.r = (self.r + k) % n
        return out


class ExtraInputs:
    def __init__(self):
        self.devs = {}       # key -> {"stream", "ring", "nch"}
        self.status = {}     # key -> "ok" | error text
        self.lock = threading.Lock()
        self.layout = ((), {})

    @staticmethod
    def find(key):
        if sd is None:
            return None
        apis = sd.query_hostapis()
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0 and f'{d["name"]} ({apis[d["hostapi"]]["name"]})' == key:
                return i, d
        return None

    def sync(self, keys, sr, block):
        """Open streams for devices now in use, close the rest."""
        keys = set(keys)
        with self.lock:
            for k in [k for k in self.devs if k not in keys]:
                try:
                    self.devs[k]["stream"].stop()
                    self.devs[k]["stream"].close()
                except Exception:
                    pass
                self.devs.pop(k, None)
                self.status.pop(k, None)
            for k in keys - set(self.devs):
                found = self.find(k)
                if found is None:
                    self.status[k] = "not connected"
                    continue
                idx, d = found
                nch = int(d["max_input_channels"])
                ring = _Ring(nch)
                try:
                    st = sd.InputStream(device=idx, channels=nch, samplerate=sr, blocksize=block, dtype="float32",
                                        latency="low", callback=lambda indata, f, t, s, ring=ring: ring.write(indata))
                    st.start()
                    self.devs[k] = {"stream": st, "ring": ring, "nch": nch}
                    self.status[k] = "ok"
                except Exception as ex:
                    self.status[k] = str(ex)
            offs, o = {}, 0
            for k in sorted(self.devs):
                offs[k] = (o, self.devs[k]["nch"])
                o += self.devs[k]["nch"]
            self.layout = (tuple(sorted(offs.items())), offs)

    def read(self, frames):
        """(frames, total channels) block from every open device, plus {key: (offset, nch)}."""
        sig, offs = self.layout
        if not offs:
            return None, {}
        parts = []
        for k, (o, n) in sig:
            d = self.devs.get(k)
            parts.append(d["ring"].read(frames) if d else np.zeros((frames, n), np.float32))
        return np.concatenate(parts, axis=1), offs

    def stop(self):
        self.sync([], 48000, 256)
