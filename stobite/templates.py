"""Built-in mix templates: a whole sound you apply to a recorded (or live) service in one go.

"Worship: Big & Polished" is modelled on the modern live-worship records (Bethel, Elevation,
Hillsong): an upfront, glued lead vocal floating on a long hall and a plate, wide and airy
backing vocals, a huge but clear pad bed, punchy drums with a crushed room underneath, a solid
low end that doesn't fight the kick, and instruments that duck out of the vocal's way.

These are starting points built from proven settings. Every module stays editable, and the
faders are left alone: the balance depends on how each source was recorded.
"""
import copy

from .chain import module as M
from .mixer import DEFAULT_BUSES, default_bus, default_fx, default_master


def _eq(hpf=None, lpf=None, *bands):
    """bands: (type, freq, gain, q). HPF/LPF as (freq, slope) or None."""
    out = [{"type": t, "freq": f, "gain": g, "q": q, "on": True, "slope": 12} for t, f, g, q in bands]
    return M("eq", hpf={"on": hpf is not None, "freq": hpf[0] if hpf else 80, "slope": hpf[1] if hpf else 24},
             lpf={"on": lpf is not None, "freq": lpf[0] if lpf else 16000, "slope": lpf[1] if lpf else 12},
             bands=out)


def _comp(thr, ratio, att, rel, makeup=0, knee=6, mix=100, sc=""):
    return M("comp", thr=thr, ratio=ratio, att=att, rel=rel, makeup=makeup, knee=knee, mix=mix, range=30, sc=sc)


def _dyneq(*bands, sc=""):
    """bands: (freq, q, thr, range dB, att, rel)."""
    return M("dyneq", sc=sc, bands=[{"on": True, "type": "bell", "freq": f, "q": q, "gain": 0, "thr": t, "range": r,
                                      "att": a, "rel": rl} for f, q, t, r, a, rl in bands])


def _gate(thr, rng, rel):
    return M("gate", thr=thr, range=rng, att=0.5, rel=rel)


# sends: [Vocal Plate, Vocal Hall, Instrument Verb, Delay] in dB (-90 = off)
OFF = -90.0


def _ch(label, chain, sends=(OFF, OFF, OFF, OFF), out=None):
    d = {"name": label, "chain": chain, "sends": list(sends)}
    if out:
        d["out"] = out
    return d


def worship_channels():
    lead = lambda: [
        _eq((100, 24), None, ("bell", 250, -2.5, 1.2), ("bell", 450, -1.0, 1.6), ("bell", 3000, 1.5, 1.0), ("highshelf", 10000, 3.0, 0.7)),
        _comp(-22, 4, 3, 80, 3),                      # fast: catches the peaks
        _comp(-18, 2.5, 20, 250, 2, knee=10),         # slow: the smooth, "always there" level
        M("deess", freq=6800, thr=-30, range=7),
        _dyneq((300, 1.2, -26, -3, 15, 150), (3200, 2.0, -28, -2.5, 3, 90)),   # mud / harshness only when they build
        M("sat", flavor="tape", drive=2, mix=40),
        M("tune", on=False, amount=60, speed=50),    # off: switch on for a gentle correction
    ]
    bgv = lambda: [
        _eq((150, 24), None, ("bell", 300, -3.0, 1.0), ("bell", 2500, -1.5, 1.2), ("highshelf", 11000, 2.5, 0.7)),
        _comp(-26, 5, 5, 120, 4),                     # tight, even stack
        M("deess", freq=6500, thr=-33, range=9),     # stacked S's add up fast
        M("sat", flavor="tape", drive=2, mix=40),
    ]
    kick = [
        _eq((30, 24), None, ("bell", 55, 3.0, 1.4), ("bell", 350, -5.0, 1.6), ("bell", 3500, 3.0, 1.4), ("highshelf", 10000, -2.0, 0.7)),
        _gate(-36, 25, 120), M("trans", attack=3, sustain=-3), _comp(-16, 4, 20, 80, 2), M("sat", flavor="tape", drive=3, mix=60),
    ]
    snare = [
        _eq((90, 24), None, ("bell", 200, 2.5, 1.2), ("bell", 800, -2.0, 2.0), ("bell", 5000, 2.0, 1.0), ("highshelf", 10000, 2.0, 0.7)),
        _gate(-34, 15, 150), M("trans", attack=3, sustain=0), _comp(-18, 4, 10, 100, 2), M("sat", flavor="tape", drive=4, mix=50),
    ]
    toms = [
        _eq((60, 24), None, ("bell", 90, 3.0, 1.0), ("bell", 400, -6.0, 1.5), ("bell", 4000, 3.0, 1.2), ("highshelf", 9000, -2.0, 0.7)),
        _gate(-38, 20, 250), M("trans", attack=2, sustain=-1), _comp(-18, 3, 15, 150, 2),
    ]
    hat = [_eq((350, 24), None, ("bell", 2500, -1.5, 1.5), ("highshelf", 12000, 1.0, 0.7))]
    oh = [_eq((200, 24), None, ("bell", 400, -2.0, 1.0), ("highshelf", 12000, 2.5, 0.7)), _comp(-20, 2, 20, 200, 1)]
    room = [   # the "big room": crushed and blended in underneath the close mics
        _eq((120, 24), None, ("bell", 300, -3.0, 1.0), ("highshelf", 10000, 1.0, 0.7)),
        _comp(-32, 8, 5, 60, 6, mix=45), M("sat", flavor="tape", drive=5, mix=60),
    ]
    perc = [_eq((150, 24), None, ("bell", 400, -2.0, 1.0), ("bell", 3000, 1.0, 1.0)), _comp(-18, 3, 10, 120, 1)]
    bass = [
        _eq((35, 24), None, ("lowshelf", 80, 2.0, 0.7), ("bell", 250, -3.0, 1.2), ("bell", 800, 1.5, 1.0), ("highshelf", 5000, -2.0, 0.7)),
        _comp(-22, 4, 15, 120, 3), _dyneq((120, 1.4, -18, -4, 10, 150)), M("sat", flavor="tube", drive=5, mix=50),
    ]
    synth_bass = [
        _eq((30, 24), None, ("lowshelf", 70, 1.5, 0.7), ("bell", 250, -3.0, 1.2), ("highshelf", 4000, -2.0, 0.7)),
        _comp(-20, 4, 15, 120, 2), M("sat", flavor="tube", drive=3, mix=40),
    ]
    eg = [
        _eq((100, 24), (10000, 12), ("bell", 250, -2.5, 1.0), ("bell", 2200, 1.5, 1.0), ("bell", 4000, -1.0, 2.0)),
        _comp(-18, 2.5, 20, 150, 1),
    ]
    ag = [
        _eq((120, 24), None, ("bell", 200, -3.5, 1.0), ("bell", 900, -1.5, 1.5), ("bell", 5000, 2.0, 1.0), ("highshelf", 12000, 2.5, 0.7)),
        _comp(-20, 3, 10, 150, 2),
    ]
    piano = [
        _eq((80, 24), None, ("bell", 250, -2.0, 1.0), ("bell", 4000, 1.5, 1.0), ("highshelf", 10000, 2.0, 0.7)),
        _comp(-20, 2.5, 15, 180, 1),
    ]
    keys = [_eq((90, 24), None, ("bell", 300, -2.0, 1.0), ("bell", 3000, 1.0, 1.0)), _comp(-18, 2, 20, 200, 1)]
    pad = [   # the wash under everything: no lows, a dip where the words live
        _eq((160, 24), None, ("bell", 400, -3.0, 0.8), ("bell", 1500, -2.0, 1.0), ("highshelf", 9000, -1.5, 0.7)),
    ]
    strings = [_eq((120, 24), None, ("bell", 300, -2.0, 1.0), ("bell", 3000, 1.0, 1.0)), _comp(-20, 2, 20, 200, 1)]
    brass = [_eq((120, 24), None, ("bell", 350, -2.0, 1.0), ("bell", 2500, -1.0, 1.5)), _comp(-18, 3, 10, 150, 2)]
    playback = [_eq((30, 24), None)]
    preacher = [
        _eq((120, 24), None, ("bell", 200, -2.0, 1.0), ("bell", 400, -2.5, 1.4), ("bell", 3000, 2.5, 1.0), ("highshelf", 9000, 1.0, 0.7)),
        M("gate", thr=-55, range=12, att=1, rel=300), _comp(-24, 3.5, 5, 180, 4), M("deess", freq=6000, thr=-28, range=6),
    ]
    audience = [_eq((150, 24), None, ("bell", 300, -3.0, 1.0), ("bell", 3000, 1.0, 1.0)), _comp(-30, 3, 30, 300, 4)]

    return {
        "lead_vocal": _ch("Lead vocal: upfront, plate + long hall", lead(), (-12, -16, OFF, -17)),
        "worship_vocal": _ch("Worship leader: upfront, plate + long hall", lead(), (-12, -16, OFF, -17)),
        "bgv": _ch("Backing vocal: tight, airy, big hall", bgv(), (OFF, -11, OFF, -22)),
        "choir": _ch("Choir: airy, big hall", bgv(), (OFF, -10, OFF, OFF)),
        "preacher": _ch("Preaching: clear and even, dry", preacher, out="speech"),
        "host": _ch("Host / MC: clear and even, dry", copy.deepcopy(preacher), out="speech"),
        "kick": _ch("Kick: deep and punchy", kick),
        "snare": _ch("Snare: fat with a big room", snare, (OFF, OFF, -12, OFF)),
        "tom": _ch("Toms: big and round", toms, (OFF, OFF, -14, OFF)),
        "hihat": _ch("Hi-hat: tucked, no clang", hat),
        "overhead": _ch("Overheads: open and airy", oh),
        "room": _ch("Room mic: crushed, under the kit", room),
        "perc": _ch("Percussion", perc, (OFF, OFF, -16, OFF)),
        "bass": _ch("Bass: solid, defined, sits under the kick", bass),
        "synth_bass": _ch("Synth bass: deep and controlled", synth_bass),
        "eg": _ch("Electric guitar: ambient, out of the vocal's way", eg, (OFF, OFF, -14, -18)),
        "ag": _ch("Acoustic guitar: bright strum, no boom", ag, (OFF, OFF, -16, OFF)),
        "piano": _ch("Piano: clear with space", piano, (OFF, -20, -14, OFF)),
        "keys": _ch("Keys / synth", keys, (OFF, -18, OFF, OFF)),
        "pad": _ch("Worship pad: wide wash under everything", pad, (OFF, -16, OFF, OFF)),
        "organ": _ch("Organ", copy.deepcopy(keys), (OFF, -20, OFF, OFF)),
        "strings": _ch("Strings: lush", strings, (OFF, -12, OFF, OFF)),
        "brass": _ch("Brass / sax", brass, (OFF, -16, OFF, OFF)),
        "tracks": _ch("Tracks / playback: untouched", playback),
        "video": _ch("Video / media: untouched", copy.deepcopy(playback)),
        "ambient": _ch("Audience / ambient: room energy", audience),
        "click": _ch("Click / cues: never on the stream", [], out="none"),
    }


def worship_globals():
    chains = {
        "lead": [
            _eq((80, 12), None, ("bell", 3000, 0.5, 1.0), ("highshelf", 12000, 1.5, 0.7)),
            _comp(-16, 2, 15, 150, 1.5),
            _dyneq((3500, 2.0, -26, -2.5, 3, 100)),
            M("sat", flavor="tube", drive=2, mix=35),
        ],
        "bgv": [
            _eq((120, 12), None, ("bell", 300, -1.5, 1.0), ("highshelf", 11000, 1.5, 0.7)),
            _comp(-18, 3, 10, 120, 2), M("width", width=135.0, balance=0.0), M("sat", flavor="tape", drive=1.5, mix=30),
        ],
        "drums": [   # parallel compression: the punch stays, the body gets bigger
            _eq((30, 12), None, ("lowshelf", 70, 1.0, 0.7), ("highshelf", 10000, 1.5, 0.7)),
            _comp(-24, 6, 10, 80, 5, mix=35), M("sat", flavor="tape", drive=3, mix=50),
        ],
        "bass": [_eq((30, 24), None), _comp(-16, 2.5, 20, 150, 1), M("sat", flavor="tube", drive=2, mix=30)],
        "gtr": [   # step back when the lead sings
            _eq((90, 12), None, ("bell", 250, -1.0, 1.0)), _comp(-16, 1.8, 25, 200, 1),
            _dyneq((3000, 1.2, -42, -3, 10, 200), sc="bus:lead"), M("width", width=120.0, balance=0.0),
        ],
        "keys": [
            _eq((90, 12), None, ("bell", 300, -1.0, 1.0)), _comp(-16, 1.8, 25, 200, 1),
            _dyneq((2800, 1.2, -42, -3, 10, 200), sc="bus:lead"), M("width", width=130.0, balance=0.0),
        ],
        "other": [_eq((80, 12), None), _comp(-16, 1.8, 25, 200, 1)],
        "music": [   # glue the band, and leave a pocket for the words
            _eq((25, 12), None, ("bell", 2500, -0.5, 0.8)),
            _comp(-16, 2, 30, 200, 1, knee=10),
            _dyneq((2500, 1.0, -40, -2, 10, 200), sc="bus:lead"),
            M("sat", flavor="console", drive=1.5, mix=50),
        ],
        "speech": [
            _eq((90, 24), None, ("bell", 3000, 1.0, 1.0)), _comp(-16, 3, 10, 200, 2),
            M("limiter", ceiling=-3.0, threshold=0, release=100, truepeak=False),
        ],
        "fx": [_eq((250, 24), (9000, 12))],
        "broadcast": [
            _eq((25, 24), None, ("bell", 300, -0.5, 0.8), ("highshelf", 12000, 0.5, 0.7)),
            _comp(-14, 1.6, 30, 250, 1, knee=10),
            M("limiter", ceiling=-1.0, threshold=-1, release=150, truepeak=True),
        ],
    }
    buses = []
    for bid, name, kind, out, color in DEFAULT_BUSES:
        b = default_bus(bid, name, kind, out, color)
        if bid in chains:
            b["chain"] = chains[bid]
        if bid == "fx":   # reverbs and delays dip while the lead sings a word, then bloom in the gaps
            b["duck"] = {"on": True, "src": "bus:lead", "amount": 3.0, "thr": -30, "att": 15, "rel": 450, "ratio": 4}
        buses.append(b)

    fx = default_fx()
    fx[0]["params"].update(predelay_ms=30, decay=0.55, size=0.45, damping=0.4, lowcut=350, highcut=8500)
    fx[0]["ret"] = -6.0
    fx[1]["params"].update(predelay_ms=60, decay=0.9, size=0.9, damping=0.45, lowcut=300, highcut=6500)   # the long, lush hall
    fx[1]["ret"] = -5.0
    fx[2]["params"].update(predelay_ms=15, decay=0.65, size=0.6, lowcut=250, highcut=8000)
    fx[2]["ret"] = -8.0
    fx[3]["params"].update(sync=True, note="1/4", feedback=0.28, lowcut=400, highcut=4500, pingpong=True)
    fx[3]["ret"] = -10.0

    master = default_master()
    master["target"] = -14.0
    master["chain"] = [
        _eq((20, 24), None, ("lowshelf", 50, 0.8, 0.7), ("bell", 300, -0.5, 0.8), ("highshelf", 13000, 1.2, 0.7)),
        _comp(-12, 1.5, 30, 300, 0.5, knee=10),
        M("sat", flavor="tape", drive=1.2, mix=30),
        M("mbc", x1=150, x2=4000, bands=[
            {"thr": -20, "ratio": 2, "att": 30, "rel": 250, "gain": 0, "range": 3},
            {"thr": -18, "ratio": 1.4, "att": 20, "rel": 200, "gain": 0, "range": 2},
            {"thr": -22, "ratio": 2, "att": 10, "rel": 150, "gain": 0, "range": 3}]),
        M("width", width=110.0, balance=0.0),
        M("limiter", ceiling=-1.0, threshold=-2, release=150, truepeak=True),
    ]
    return {"kind": "stobite-mix", "version": 1, "buses": buses, "fx": fx, "master": master}


TEMPLATES = {
    "worship-big": {
        "name": "Worship: Big & Polished",
        "style": "In the style of modern live worship records (Bethel, Elevation, Hillsong)",
        "about": ("Upfront, glued lead vocal on a plate and a long hall; wide, airy backing vocals; a huge pad bed; "
                  "punchy drums with a crushed room underneath; a solid low end; guitars and keys that duck out of the "
                  "vocal's way; reverbs that bloom between the words; mastered to -14 LUFS for streaming."),
        "channels": worship_channels,
        "globals": worship_globals,
    },
}


def list_templates():
    return [{"id": k, "name": t["name"], "style": t["style"], "about": t["about"]} for k, t in TEMPLATES.items()]


def get_template(tid):
    from .catalog import INSTRUMENTS
    t = TEMPLATES[tid]
    chans = t["channels"]()
    home = {k: bus for k, _l, _i, bus, _p, _c in INSTRUMENTS}
    for key, d in chans.items():
        d["type"] = key
        d.setdefault("out", home.get(key, "music"))   # each instrument into its own group bus
    return {"id": tid, "name": t["name"], "style": t["style"], "about": t["about"],
            "channels": chans, "globals": t["globals"]()}
