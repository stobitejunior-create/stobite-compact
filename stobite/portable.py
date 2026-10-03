"""Things you carry between church and home.

  Project file  (<name>.stobite)          the whole session: every recording, edits, markers,
                                         automation and the full mix. Open it on any computer.
  Channel file  (<name>.stobite-channel)  one channel's sound: its processing chain, sends,
                                         levels, routing and identity. Apply to any channel.
  Mix folder    (<name>/)                one channel file per channel plus
                                         "Buses, FX and Master.stobite-mix".
"""
import copy
import json
import os
import re
import shutil
import tempfile
import time
import zipfile

from . import chain as chainmod
from .session import home_dir, safe_name

CH_EXT, MIX_EXT, PROJ_EXT = ".stobite-channel", ".stobite-mix", ".stobite"
GLOBAL_FILE = "Buses, FX and Master" + MIX_EXT


def presets_dir(*parts):
    d = os.path.join(home_dir(), "Presets", *parts)
    os.makedirs(d, exist_ok=True)
    return d


def _clean(name):
    name = re.sub(r"[/\\:]+", "-", name or "")
    name = re.sub(r"[^\w\- ()&+.,']+", "", name)
    return re.sub(r"\s+", " ", name).strip()[:80] or "Untitled"


# ---------------------------------------------------------------- channel settings

def channel_data(ch):
    return {
        "kind": "stobite-channel", "version": 1, "saved": time.strftime("%Y-%m-%d %H:%M"),
        "name": ch.get("name", ""), "type": ch.get("type", ""), "icon": ch.get("icon", ""), "color": ch.get("color", ""),
        "chain": copy.deepcopy(ch.get("chain") or []), "sends": list(ch.get("sends") or []),
        "pan": ch.get("pan", 0.0), "fader": ch.get("fader", 0.0), "trim": ch.get("trim", 0.0),
        "phase": bool(ch.get("phase")), "out": ch.get("out", "music"),
    }


def save_channel(ch, name=None):
    data = channel_data(ch)
    path = os.path.join(presets_dir("Channels"), _clean(name or ch.get("name")) + CH_EXT)
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
    return path, data


def list_library():
    chans = sorted(os.path.splitext(f)[0] for f in os.listdir(presets_dir("Channels")) if f.endswith(CH_EXT))
    mixes = sorted(d for d in os.listdir(presets_dir("Mixes")) if os.path.isdir(os.path.join(presets_dir("Mixes"), d)))
    return {"channels": chans, "mixes": mixes, "folder": presets_dir()}


def read_channel(name):
    with open(os.path.join(presets_dir("Channels"), _clean(name) + CH_EXT)) as f:
        return json.load(f)


def delete_channel(name):
    p = os.path.join(presets_dir("Channels"), _clean(name) + CH_EXT)
    if os.path.exists(p):
        os.remove(p)


def apply_channel(ch, data, opts):
    """Apply a channel file onto a live channel. opts: which parts to take."""
    opts = opts or {}
    if opts.get("chain", True):
        ch["chain"] = chainmod.fresh_ids(data.get("chain"))
    if opts.get("sends", True) and data.get("sends"):
        ch["sends"] = list(data["sends"])[:4] + [-90.0] * max(0, 4 - len(data["sends"]))
    if opts.get("levels", False):
        for k in ("fader", "pan", "trim", "phase"):
            if k in data:
                ch[k] = data[k]
    if opts.get("routing", True) and data.get("out"):
        ch["out"] = data["out"]
    if opts.get("identity", True):
        for k in ("name", "type", "icon", "color"):
            if data.get(k):
                ch[k] = data[k]


# ---------------------------------------------------------------- whole mix

def mix_globals(state):
    return {"kind": "stobite-mix", "version": 1, "saved": time.strftime("%Y-%m-%d %H:%M"),
            **{k: copy.deepcopy(state.get(k)) for k in ("buses", "fx", "master", "tempo", "song", "cables")}}


def _is_used(ch, i):
    default_name = re.fullmatch(r"Ch \d+", ch.get("name", "")) is not None
    return not default_name or bool(ch.get("type"))


def save_mix(state, name):
    folder = os.path.join(presets_dir("Mixes"), _clean(name))
    if os.path.exists(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    n = 0
    for pos, c in enumerate(state["order"]):
        ch = state["channels"][c]
        if not _is_used(ch, c):
            continue
        n += 1
        data = channel_data(ch)
        data["position"] = pos
        data["input"] = ch.get("input")
        with open(os.path.join(folder, f"{pos + 1:02d} {_clean(ch['name'])}{CH_EXT}"), "w") as f:
            json.dump(data, f, indent=1)
        with open(os.path.join(presets_dir("Channels"), _clean(ch["name"]) + CH_EXT), "w") as f:  # also in the library
            json.dump(channel_data(ch), f, indent=1)
    with open(os.path.join(folder, GLOBAL_FILE), "w") as f:
        json.dump(mix_globals(state), f, indent=1)
    return folder, n


def read_mix(name):
    folder = os.path.join(presets_dir("Mixes"), _clean(name))
    return read_mix_folder(folder)


def read_mix_folder(folder):
    chans, glob_ = [], None
    for fn in sorted(os.listdir(folder)):
        p = os.path.join(folder, fn)
        if fn.endswith(CH_EXT):
            with open(p) as f:
                d = json.load(f)
            d["file"] = fn
            chans.append(d)
        elif fn.endswith(MIX_EXT):
            with open(p) as f:
                glob_ = json.load(f)
    return {"channels": chans, "globals": glob_}


def store_upload(rel_name, raw):
    """Save an uploaded settings file into the library. Files from a folder keep their folder as a mix."""
    rel = rel_name.replace("\\", "/")
    base = os.path.basename(rel)
    data = json.loads(raw.decode("utf-8"))
    if "/" in rel:  # came from a folder -> a mix
        folder = os.path.join(presets_dir("Mixes"), _clean(rel.split("/")[-2]))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, _clean(os.path.splitext(base)[0]) + os.path.splitext(base)[1]), "w") as f:
            json.dump(data, f, indent=1)
    if base.endswith(CH_EXT):
        with open(os.path.join(presets_dir("Channels"), _clean(data.get("name") or os.path.splitext(base)[0]) + CH_EXT), "w") as f:
            json.dump(data, f, indent=1)
    data["file"] = base
    return data


# ---------------------------------------------------------------- projects

def export_project(session, mixer_state, progress=lambda f: None):
    """Zip the session folder (recordings, edits, mix) into Exports/<name>.stobite."""
    session.save(mixer_state)
    out = os.path.join(home_dir(), "Exports", f"{session.name}{PROJ_EXT}")
    files = []
    for root, _, names in os.walk(session.dir):
        for n in names:
            if n.endswith(".tmp"):
                continue
            files.append(os.path.join(root, n))
    total = sum(os.path.getsize(p) for p in files) or 1
    done = 0
    tmp = out + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:  # WAV doesn't compress; storing is fast
        for p in files:
            z.write(p, os.path.relpath(p, session.dir))
            done += os.path.getsize(p)
            progress(done / total)
    os.replace(tmp, out)
    return out


def import_project(path):
    """Unpack a .stobite file into Sessions/ and return the session name."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "session.json" not in names:
            raise RuntimeError("That file isn't a Stobite Compact project (no session.json inside).")
        meta = json.loads(z.read("session.json"))
        base = safe_name(meta.get("name") or os.path.splitext(os.path.basename(path))[0])
        root = os.path.join(home_dir(), "Sessions")
        name, k = base, 2
        while os.path.exists(os.path.join(root, name)):
            name, k = f"{base} {k}", k + 1
        dest = os.path.join(root, name)
        os.makedirs(dest)
        for n in names:
            target = os.path.realpath(os.path.join(dest, n))
            if not target.startswith(os.path.realpath(dest) + os.sep):  # refuse paths escaping the folder
                continue
            if n.endswith("/"):
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(n) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
    # the copy carries its own name
    sj = os.path.join(dest, "session.json")
    with open(sj) as f:
        data = json.load(f)
    data["name"] = name
    with open(sj, "w") as f:
        json.dump(data, f)
    return name


def temp_path(suffix):
    fd, p = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return p
