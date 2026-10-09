"""Listening on the computer itself (headphones / speakers) while the WING is the audio interface.

The mix is NOT sent back into the WING unless that's switched on in Setup: the WING's USB returns
are often patched into channels, and sending the mix there makes a feedback loop. So the main
stream reads the WING's inputs and this second stream plays the mix on the computer's own output.
Its clock is independent, so a short buffer absorbs the difference.
"""
import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover
    sd = None

from .inputs import _Ring


def is_wing_name(name):
    return any(k in (name or "").upper() for k in ("WING", "BEHRINGER"))


def pick_listen_device(choice):
    """choice: "" = off, None/"auto" = the computer's own output, else "Name (API)"."""
    if sd is None or choice == "":
        return None
    apis = sd.query_hostapis()
    devs = [(i, d, apis[d["hostapi"]]["name"]) for i, d in enumerate(sd.query_devices()) if d["max_output_channels"] > 0]
    if choice and choice != "auto":
        for i, d, api in devs:
            if f'{d["name"]} ({api})' == choice or d["name"] == choice:
                return i
        return None
    try:
        dflt = sd.default.device[1]
        if dflt is not None and dflt >= 0 and not is_wing_name(sd.query_devices(dflt)["name"]):
            return dflt
    except Exception:
        pass
    # the system default is the WING (or unknown): take the first other output, never the WING
    rank = {"Windows WASAPI": 0, "Core Audio": 0, "MME": 1, "Windows DirectSound": 2}
    others = sorted((x for x in devs if not is_wing_name(x[1]["name"]) and x[2] != "ASIO"), key=lambda x: rank.get(x[2], 5))
    return others[0][0] if others else None


class ListenOut:
    def __init__(self):
        self.stream = None
        self.ring = None
        self.name = ""
        self.error = ""

    def start(self, dev, sr, block):
        from .engine import com_init
        com_init()
        self.stop()
        if sd is None or dev is None:
            return
        try:
            d = sd.query_devices(dev)
            api = sd.query_hostapis(d["hostapi"])["name"]
            ch = max(1, min(2, int(d["max_output_channels"])))
            ring = _Ring(2, 8192)   # at most ~85 ms behind the main stream

            def cb(outdata, frames, t, status):
                x = ring.read(frames)
                if ch == 2:
                    outdata[:] = x
                else:
                    outdata[:, 0] = x.mean(axis=1)
            kw = {}
            if api == "Windows WASAPI":
                kw["extra_settings"] = sd.WasapiSettings(auto_convert=True)   # any device sample rate
            st = sd.OutputStream(device=dev, channels=ch, samplerate=sr, blocksize=block, dtype="float32",
                                 latency="low", callback=cb, **kw)
            st.start()
            self.stream, self.ring, self.name, self.error = st, ring, d["name"], ""
        except Exception as ex:
            self.stream, self.ring, self.name, self.error = None, None, "", str(ex)

    def push(self, stereo):
        r = self.ring
        if r is not None:
            r.write(stereo)

    def stop(self):
        st, self.stream, self.ring = self.stream, None, None
        if st is not None:
            try:
                st.abort()
                st.close()
            except Exception:
                pass
        self.name = ""
