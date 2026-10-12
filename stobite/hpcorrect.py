"""Headphone correction: flattens the sound of popular headphones so a mix made on them
translates to the speakers, phones and cars people actually listen on.

The corrections are AutoEq's parametric EQs (github.com/jaakkopasanen/AutoEq, MIT licence,
Copyright (c) 2018-2022 Jaakko Pasanen), measured by oratory1990, crinacle, Rtings and others,
tuned to the Harman target. They apply only to what you hear (headphones, speakers, monitor
outs), never to the stream, the recording, an export or what goes back to the WING.
"""
import json
import os

import numpy as np

try:
    import pedalboard as pb
except Exception:       # pragma: no cover
    pb = None

_DB = None


def models():
    global _DB
    if _DB is None:
        try:
            with open(os.path.join(os.path.dirname(__file__), "headphones.json")) as f:
                _DB = json.load(f)
        except Exception:
            _DB = {}
    return _DB


class HeadphoneEQ:
    def __init__(self, sr):
        self.sr = sr
        self.key = None
        self.board = None

    def process(self, x, model, amount=100.0):
        """x: (frames, 2). Returns x unchanged when off or the model is unknown."""
        if not model or pb is None or amount <= 0:
            self.key = None
            return x
        key = (model, round(float(amount)))
        if key != self.key:
            d = models().get(model)
            if not d:
                return x
            a = float(np.clip(amount, 0, 100)) / 100
            fx = [pb.Gain(d["preamp"] * a)]        # keeps boosts from clipping
            for typ, f, g, q in d["bands"]:
                f = float(min(f, self.sr * 0.45))
                cls = {"bell": pb.PeakFilter, "lowshelf": pb.LowShelfFilter, "highshelf": pb.HighShelfFilter}[typ]
                fx.append(cls(cutoff_frequency_hz=f, gain_db=g * a, q=q))
            self.board = pb.Pedalboard(fx)
            self.key = key
        return self.board(x.T.astype(np.float32), self.sr, reset=False).T
