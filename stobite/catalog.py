"""Instrument library (icons, default bus, starting preset) and processing presets.

Presets are deliberately gentle starting points for a worship / livestream mix:
they set filters, EQ, dynamics, saturation and sends, and everything stays
fully adjustable afterwards.
"""

# key, label, icon, bus, preset, colour
INSTRUMENTS = [
    ("lead_vocal", "Lead Vocal", "mic", "lead", "Lead Vocal", "#e5484d"),
    ("worship_vocal", "Worship Leader", "mic", "lead", "Worship Vocal", "#e5484d"),
    ("bgv", "Backing Vocal", "mic2", "bgv", "Background Vocal", "#f76b15"),
    ("choir", "Choir", "choir", "bgv", "Background Vocal", "#f76b15"),
    ("preacher", "Preacher", "pulpit", "speech", "Preaching Mic", "#ffc53d"),
    ("host", "Host / MC", "headset", "speech", "Preaching Mic", "#ffc53d"),
    ("kick", "Kick", "kick", "drums", "Kick", "#46a758"),
    ("snare", "Snare", "snare", "drums", "Snare", "#46a758"),
    ("tom", "Tom", "tom", "drums", "Toms", "#46a758"),
    ("hihat", "Hi-hat", "hihat", "drums", "Hi-hat", "#46a758"),
    ("overhead", "Overheads", "cymbal", "drums", "Overheads", "#46a758"),
    ("room", "Room Mic", "room", "drums", "Room", "#46a758"),
    ("perc", "Percussion", "perc", "drums", "Percussion", "#46a758"),
    ("bass", "Bass", "bass", "bass", "Bass", "#12a594"),
    ("synth_bass", "Synth Bass", "synth", "bass", "Bass", "#12a594"),
    ("eg", "Electric Guitar", "eguitar", "gtr", "Electric Guitar", "#0090ff"),
    ("ag", "Acoustic Guitar", "aguitar", "gtr", "Acoustic Guitar", "#0090ff"),
    ("piano", "Piano", "piano", "keys", "Piano", "#6e56cf"),
    ("keys", "Keys / Synth", "keys", "keys", "Keys", "#6e56cf"),
    ("pad", "Worship Pad", "pad", "keys", "Worship Pad", "#6e56cf"),
    ("organ", "Organ", "organ", "keys", "Keys", "#6e56cf"),
    ("strings", "Strings", "violin", "other", "Strings", "#d6409f"),
    ("brass", "Brass / Sax", "trumpet", "other", "Brass", "#d6409f"),
    ("tracks", "Tracks / Playback", "laptop", "music", "Playback", "#8b8d98"),
    ("video", "Video / Media", "video", "broadcast", "Playback", "#8b8d98"),
    ("click", "Click / Cues", "click", "none", None, "#5b5e66"),
    ("ambient", "Audience / Ambient", "audience", "broadcast", "Audience", "#8b8d98"),
]


def _eq(*bands):
    out = []
    for b in bands:
        t, f, g, q = b
        out.append({"type": t, "freq": f, "gain": g, "q": q, "on": True, "slope": 12})
    while len(out) < 4:
        out.append({"type": "bell", "freq": [100, 400, 2500, 8000][len(out)], "gain": 0, "q": 1.0, "on": True, "slope": 12})
    return {"on": True, "bands": out}


def _comp(thr, ratio, att, rel, makeup=0, knee=6, mix=100):
    return {"on": True, "thr": thr, "ratio": ratio, "att": att, "rel": rel, "makeup": makeup, "knee": knee, "mix": mix, "range": 30}


OFF = {"on": False}

# sends order = FX slots: 0 Vocal Plate, 1 Vocal Hall, 2 Instrument Verb, 3 Delay
CHANNEL_PRESETS = {
    "Lead Vocal": dict(
        hpf={"on": True, "freq": 100, "slope": 24},
        eq=_eq(("bell", 300, -2.5, 1.2), ("bell", 3200, 2.0, 1.0), ("bell", 5500, -1.0, 3.0), ("highshelf", 12000, 2.5, 0.7)),
        comp=_comp(-20, 4, 6, 120, 3), deess={"on": True, "freq": 6500, "thr": -28, "range": 6},
        sat={"on": True, "type": "tube", "drive": 3, "mix": 60}, gate=OFF, trans=OFF,
        sends=[-14, -16, -90, -18]),
    "Worship Vocal": dict(
        hpf={"on": True, "freq": 110, "slope": 24},
        eq=_eq(("bell", 250, -2.0, 1.0), ("bell", 450, -1.0, 1.5), ("bell", 3000, 1.5, 0.9), ("highshelf", 12000, 3.0, 0.7)),
        comp=_comp(-22, 3.5, 8, 150, 3), deess={"on": True, "freq": 7000, "thr": -30, "range": 6},
        sat={"on": True, "type": "tape", "drive": 2.5, "mix": 50}, gate=OFF, trans=OFF,
        sends=[-15, -12, -90, -16]),
    "Background Vocal": dict(
        hpf={"on": True, "freq": 140, "slope": 24},
        eq=_eq(("bell", 300, -3.0, 1.0), ("bell", 2500, -1.0, 1.0), ("bell", 5000, 0.0, 1.0), ("highshelf", 11000, 2.0, 0.7)),
        comp=_comp(-24, 4, 10, 150, 3), deess={"on": True, "freq": 6500, "thr": -32, "range": 8},
        sat={"on": True, "type": "tape", "drive": 2, "mix": 50}, gate=OFF, trans=OFF,
        sends=[-90, -10, -90, -16]),
    "Preaching Mic": dict(
        hpf={"on": True, "freq": 120, "slope": 24},
        eq=_eq(("bell", 200, -2.0, 1.0), ("bell", 400, -2.5, 1.4), ("bell", 3000, 2.5, 1.0), ("highshelf", 9000, 1.0, 0.7)),
        comp=_comp(-24, 3.5, 5, 180, 4), deess={"on": True, "freq": 6000, "thr": -28, "range": 6},
        gate={"on": True, "thr": -55, "range": 12, "att": 1, "rel": 300},
        sat={"on": False, "type": "tube", "drive": 2, "mix": 50}, trans=OFF, sends=[-90, -90, -90, -90]),
    "Kick": dict(
        hpf={"on": True, "freq": 35, "slope": 24},
        eq=_eq(("bell", 60, 3.0, 1.2), ("bell", 350, -5.0, 1.5), ("bell", 3500, 3.0, 1.4), ("highshelf", 9000, -2.0, 0.7)),
        comp=_comp(-16, 4, 15, 90, 2), gate={"on": True, "thr": -36, "range": 25, "att": 0.5, "rel": 120},
        trans={"on": True, "attack": 3, "sustain": -2}, sat={"on": True, "type": "tape", "drive": 3, "mix": 70},
        deess=OFF, sends=[-90, -90, -90, -90]),
    "Snare": dict(
        hpf={"on": True, "freq": 90, "slope": 24},
        eq=_eq(("bell", 200, 2.0, 1.2), ("bell", 600, -3.0, 2.0), ("bell", 5000, 2.0, 1.0), ("highshelf", 10000, 1.5, 0.7)),
        comp=_comp(-18, 4, 8, 110, 2), gate={"on": True, "thr": -34, "range": 15, "att": 0.5, "rel": 150},
        trans={"on": True, "attack": 2, "sustain": 0}, sat={"on": True, "type": "tape", "drive": 3, "mix": 60},
        deess=OFF, sends=[-90, -90, -14, -90]),
    "Toms": dict(
        hpf={"on": True, "freq": 60, "slope": 24},
        eq=_eq(("bell", 100, 2.0, 1.0), ("bell", 400, -5.0, 1.5), ("bell", 4000, 2.0, 1.2), ("highshelf", 9000, -2.0, 0.7)),
        comp=_comp(-18, 3, 15, 150, 2), gate={"on": True, "thr": -38, "range": 20, "att": 0.5, "rel": 250},
        trans={"on": True, "attack": 2, "sustain": -1}, sat=OFF, deess=OFF, sends=[-90, -90, -16, -90]),
    "Hi-hat": dict(
        hpf={"on": True, "freq": 300, "slope": 24},
        eq=_eq(("bell", 600, -2.0, 1.0), ("bell", 2500, -1.5, 1.5), ("bell", 6000, 0.0, 1.0), ("highshelf", 11000, 1.5, 0.7)),
        comp=OFF, gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -90, -90]),
    "Overheads": dict(
        hpf={"on": True, "freq": 180, "slope": 24},
        eq=_eq(("bell", 400, -2.0, 1.0), ("bell", 2500, -1.0, 1.5), ("bell", 5000, 0.0, 1.0), ("highshelf", 12000, 2.0, 0.7)),
        comp=_comp(-20, 2, 20, 200, 1), gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -90, -90]),
    "Room": dict(
        hpf={"on": True, "freq": 120, "slope": 24},
        eq=_eq(("bell", 300, -3.0, 1.0), ("bell", 2000, 0, 1.0), ("bell", 5000, 0, 1.0), ("highshelf", 10000, 1.0, 0.7)),
        comp=_comp(-28, 6, 10, 80, 4, mix=60), gate=OFF, trans=OFF, sat={"on": True, "type": "tape", "drive": 4, "mix": 60},
        deess=OFF, sends=[-90, -90, -90, -90]),
    "Percussion": dict(
        hpf={"on": True, "freq": 150, "slope": 24},
        eq=_eq(("bell", 400, -2.0, 1.0), ("bell", 3000, 1.0, 1.0)), comp=_comp(-18, 3, 10, 120, 1),
        gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -16, -90]),
    "Bass": dict(
        hpf={"on": True, "freq": 35, "slope": 24},
        eq=_eq(("lowshelf", 80, 1.5, 0.7), ("bell", 250, -2.5, 1.2), ("bell", 800, 1.5, 1.0), ("highshelf", 5000, -2.0, 0.7)),
        comp=_comp(-20, 4, 20, 160, 3), sat={"on": True, "type": "tube", "drive": 4, "mix": 50},
        dyneq={"on": True, "bands": [{"on": True, "type": "bell", "freq": 120, "q": 1.4, "gain": 0, "thr": -18, "range": -4, "att": 10, "rel": 150}]},
        gate=OFF, trans=OFF, deess=OFF, sends=[-90, -90, -90, -90]),
    "Electric Guitar": dict(
        hpf={"on": True, "freq": 100, "slope": 24}, lpf={"on": True, "freq": 11000, "slope": 12},
        eq=_eq(("bell", 250, -2.0, 1.0), ("bell", 500, -1.0, 1.0), ("bell", 2500, 1.5, 1.0), ("highshelf", 8000, -1.0, 0.7)),
        comp=_comp(-18, 2.5, 20, 150, 1), gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -14, -16]),
    "Acoustic Guitar": dict(
        hpf={"on": True, "freq": 110, "slope": 24},
        eq=_eq(("bell", 200, -3.0, 1.0), ("bell", 900, -1.0, 1.5), ("bell", 5000, 2.0, 1.0), ("highshelf", 12000, 2.0, 0.7)),
        comp=_comp(-20, 3, 10, 150, 2), gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -14, -90]),
    "Piano": dict(
        hpf={"on": True, "freq": 80, "slope": 24},
        eq=_eq(("bell", 250, -2.0, 1.0), ("bell", 1000, 0.0, 1.0), ("bell", 4000, 1.5, 1.0), ("highshelf", 10000, 1.5, 0.7)),
        comp=_comp(-20, 2.5, 15, 180, 1), gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -14, -90]),
    "Keys": dict(
        hpf={"on": True, "freq": 90, "slope": 24},
        eq=_eq(("bell", 300, -2.0, 1.0), ("bell", 1000, 0, 1.0), ("bell", 3000, 1.0, 1.0), ("highshelf", 10000, 1.0, 0.7)),
        comp=_comp(-18, 2, 20, 200, 1), gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -16, -90]),
    "Worship Pad": dict(
        hpf={"on": True, "freq": 140, "slope": 24},
        eq=_eq(("bell", 400, -3.0, 0.8), ("bell", 1500, -1.5, 1.0), ("bell", 3000, 0, 1.0), ("highshelf", 9000, -1.0, 0.7)),
        comp=OFF, gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -20, -90]),
    "Strings": dict(
        hpf={"on": True, "freq": 120, "slope": 24},
        eq=_eq(("bell", 300, -2.0, 1.0), ("bell", 3000, 1.0, 1.0)), comp=_comp(-20, 2, 20, 200, 1),
        gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -14, -90, -90]),
    "Brass": dict(
        hpf={"on": True, "freq": 120, "slope": 24},
        eq=_eq(("bell", 350, -2.0, 1.0), ("bell", 2500, -1.0, 1.5)), comp=_comp(-18, 3, 10, 150, 2),
        gate=OFF, trans=OFF, sat=OFF, deess={"on": False, "freq": 5000, "thr": -28, "range": 6}, sends=[-90, -16, -90, -90]),
    "Playback": dict(
        hpf={"on": True, "freq": 30, "slope": 24}, eq=_eq(), comp=OFF, gate=OFF, trans=OFF, sat=OFF, deess=OFF,
        sends=[-90, -90, -90, -90]),
    "Audience": dict(
        hpf={"on": True, "freq": 150, "slope": 24},
        eq=_eq(("bell", 300, -3.0, 1.0), ("bell", 3000, 1.0, 1.0)), comp=_comp(-30, 3, 30, 300, 4),
        gate=OFF, trans=OFF, sat=OFF, deess=OFF, sends=[-90, -90, -90, -90]),
}

BUS_PRESETS = {
    "Vocal Bus": dict(
        hpf={"on": True, "freq": 80, "slope": 12}, eq=_eq(("bell", 350, -1.0, 1.0), ("highshelf", 10000, 1.0, 0.7)),
        comp=_comp(-14, 2, 15, 150, 1), sat={"on": True, "type": "tube", "drive": 2, "mix": 40},
        dyneq={"on": True, "bands": [{"on": True, "type": "bell", "freq": 3500, "q": 2.0, "gain": 0, "thr": -26, "range": -3, "att": 3, "rel": 100}]},
        mbc=OFF, limiter=OFF),
    "Drum Bus": dict(
        hpf={"on": True, "freq": 30, "slope": 12}, eq=_eq(("lowshelf", 70, 1.0, 0.7), ("highshelf", 10000, 1.0, 0.7)),
        comp=_comp(-18, 4, 30, 120, 3, mix=50), sat={"on": True, "type": "tape", "drive": 3, "mix": 60},
        dyneq=OFF, mbc=OFF, limiter=OFF),
    "Music Bus": dict(
        hpf={"on": True, "freq": 25, "slope": 12}, eq=_eq(("bell", 2500, -0.5, 0.8)),
        comp=_comp(-14, 1.6, 30, 250, 1, knee=10), sat={"on": True, "type": "console", "drive": 1.5, "mix": 50},
        dyneq={"on": True, "bands": [{"on": True, "type": "bell", "freq": 250, "q": 1.0, "gain": 0, "thr": -22, "range": -2.5, "att": 20, "rel": 200}]},
        mbc=OFF, limiter=OFF),
    "Speech Bus": dict(
        hpf={"on": True, "freq": 90, "slope": 24}, eq=_eq(("bell", 3000, 1.0, 1.0)),
        comp=_comp(-16, 3, 10, 200, 2), sat=OFF, dyneq=OFF, mbc=OFF,
        limiter={"on": True, "ceiling": -3, "threshold": 0, "gain": 0, "lookahead": 1.5, "release": 100, "truepeak": False}),
    "Broadcast Bus": dict(
        hpf={"on": True, "freq": 25, "slope": 24}, eq=_eq(("bell", 300, -0.5, 0.8), ("highshelf", 12000, 0.5, 0.7)),
        comp=_comp(-12, 1.5, 30, 300, 1, knee=10), sat={"on": True, "type": "tape", "drive": 1.5, "mix": 40},
        dyneq={"on": True, "bands": [{"on": True, "type": "bell", "freq": 3000, "q": 1.5, "gain": 0, "thr": -22, "range": -2, "att": 5, "rel": 120}]},
        mbc={"on": True, "x1": 180, "x2": 3500, "bands": [
            {"thr": -20, "ratio": 2, "att": 30, "rel": 250, "gain": 0, "range": 3},
            {"thr": -18, "ratio": 1.5, "att": 20, "rel": 200, "gain": 0, "range": 2},
            {"thr": -22, "ratio": 2, "att": 10, "rel": 150, "gain": 0, "range": 3}]},
        limiter={"on": True, "ceiling": -1.0, "threshold": -2, "gain": 0, "lookahead": 1.5, "release": 150, "truepeak": True}),
    "Worship Master": dict(
        hpf={"on": True, "freq": 20, "slope": 24}, eq=_eq(("lowshelf", 60, 0.5, 0.7), ("highshelf", 14000, 0.8, 0.7)),
        comp=_comp(-10, 1.5, 30, 300, 0.5, knee=10), sat={"on": False, "type": "tape", "drive": 1.5, "mix": 40},
        dyneq=OFF, mbc=OFF,
        limiter={"on": True, "ceiling": -1.0, "threshold": -1, "gain": 0, "lookahead": 1.5, "release": 150, "truepeak": True}),
}

SCENE_NAMES = ["Pre-Service", "Worship", "Worship Build", "Worship Quiet", "Prayer", "Preaching",
               "Altar Call", "Closing", "Post-Service"]


def catalog():
    from .chain import legacy_to_chain, TYPES, DEFAULTS
    from .hpcorrect import models as hp_models
    chp = {n: {"chain": legacy_to_chain(p), "sends": p.get("sends")} for n, p in CHANNEL_PRESETS.items()}
    bup = {n: {"chain": legacy_to_chain(p, bus=True)} for n, p in BUS_PRESETS.items()}
    return {
        "instruments": [dict(key=k, label=l, icon=i, bus=b, preset=p, color=c) for k, l, i, b, p, c in INSTRUMENTS],
        "channelPresets": chp, "busPresets": bup, "sceneNames": SCENE_NAMES,
        "moduleTypes": {k: {"label": v[0], "short": v[1], "ch": v[2], "bus": v[3]} for k, v in TYPES.items()},
        "moduleDefaults": {k: f() for k, f in DEFAULTS.items()},
        "headphones": sorted(hp_models(), key=str.lower),
    }
