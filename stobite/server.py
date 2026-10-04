"""HTTP + WebSocket server. The desktop window and every remote browser on the
Wi-Fi use the same UI and stay in sync through /ws."""
import asyncio
import copy
import math
import glob
import json
import os
import socket
import sys
import tempfile
import threading
import time
import traceback

from aiohttp import web, WSMsgType

from .engine import Engine, list_devices
from .session import home_dir, safe_name
from . import wing as wingmod
from . import portable

PORT = int(os.environ.get("STOBITE_PORT", "8730"))


def web_dir():
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, "web")


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    # (no hostname lookup here: macOS can stall ~30 s resolving its own name)
    return sorted(ips)


def plugin_dirs():
    if sys.platform == "darwin":
        h = os.path.expanduser("~")
        return [("/Library/Audio/Plug-Ins/VST3", "*.vst3"), (h + "/Library/Audio/Plug-Ins/VST3", "*.vst3"),
                ("/Library/Audio/Plug-Ins/Components", "*.component"), (h + "/Library/Audio/Plug-Ins/Components", "*.component")]
    if sys.platform == "win32":
        pf = os.environ.get("CommonProgramFiles", r"C:\Program Files\Common Files")
        return [(os.path.join(pf, "VST3"), "**/*.vst3")]
    return [(os.path.expanduser("~/.vst3"), "*.vst3"), ("/usr/lib/vst3", "*.vst3")]


class App:
    def __init__(self):
        self.engine = Engine()
        self.clients = set()
        self.loop = None
        self.wing = wingmod.WingBridge(on_update=self._wing_update)
        self.want_spectrum = False
        self.runner = self.site = None
        self.mix_undo, self.mix_redo, self.mix_ck, self.auto_push = [], [], 0.0, 0.0
        self.engine.listeners.append(self._engine_event)

    # ------------------------------------------------------------- broadcast
    def _engine_event(self, kind, data):
        if self.loop:
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._push(kind)))

    def _wing_update(self, addr, val):
        if self.loop:
            msg = {"t": "wing", "addr": addr, "v": val}
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.broadcast(msg)))

    async def _push(self, kind):
        e = self.engine
        if kind == "session":
            await self.broadcast({"t": "session", "session": e.session.public()})
        elif kind == "mixer":
            await self.broadcast({"t": "mixer", "mixer": self.mixer_public()})
        elif kind == "transport":
            await self.broadcast({"t": "transport", **e.transport()})
        elif kind == "status":
            await self.broadcast({"t": "info", "info": self.info()})
        elif kind == "export":
            await self.broadcast({"t": "export", "job": e.export_job})

    async def broadcast(self, msg, skip=None):
        data = json.dumps(msg)
        for ws in list(self.clients):
            if ws is skip:
                continue
            try:
                await ws.send_str(data)
            except Exception:
                self.clients.discard(ws)

    def mixer_public(self):
        st = self.engine.mixer.snapshot()
        plugins = self.engine.mixer.plugins
        for owner in [*st["channels"], *st["buses"], st["master"]]:
            for m in owner.get("chain") or []:
                if m.get("type") == "plugin":
                    inst = plugins.get(m["id"])
                    m["failed"] = inst is None or bool(getattr(inst, "failed", False))
        return st

    async def set_remote(self, on):
        """Phone remote on = listen on the network; off = only this computer can connect."""
        if self.runner is None:
            return
        host = "0.0.0.0" if on else "127.0.0.1"
        if self.site is not None and getattr(self, "host", None) == host:
            return
        if self.site is not None:
            await self.site.stop()
        self.site = web.TCPSite(self.runner, host, PORT)
        await self.site.start()
        self.host = host

    def info(self):
        i = self.engine.info()
        i["remote"] = bool(self.engine.cfg.get("remote", False))
        cb = self.engine.cables
        i["cables"] = {"status": cb.status, "error": cb.error, "names": cb.names}
        i["urls"] = [f"http://{ip}:{PORT}" for ip in lan_ips()] if i["remote"] else []
        i["wing"] = {"ip": self.wing.ip, "connected": self.wing.connected}
        return i

    async def meter_loop(self):
        e = self.engine
        last_tr = 0
        while True:
            # 20 meter updates a second while there's sound, 4 while the engine sleeps
            await asyncio.sleep(0.25 if e.asleep else 0.05)
            if not self.clients:
                await asyncio.sleep(0.5)
                continue
            if e.playing and e.session and e.playhead > e.session.length() + e.sr:
                e.stop()  # ran off the end of the recording
            m = e.mixer.read_meters()
            r = lambda a: [int(min(v, 4.0) * 1000) for v in a]
            msg = {"t": "m", "i": r(m["i"]), "p": r(m["p"]), "rm": r(m["r"]), "m": r(m["m"]), "fx": r(m["fx"]),
                   "b": {k: r(v) for k, v in m["b"].items()}, "bm": m["bm"], "mm": m["mm"], "fxd": m["fxd"], "at": m["at"],
                   "tp": round(20 * math.log10(max(m["tp"], 1e-6)), 1), "mr": int(min(m["mr"], 4) * 1000),
                   "gr": [round(v, 1) for v in m["gr"]], "gg": [round(v, 1) for v in m["gg"]],
                   "mgr": round(m["mgr"], 1), "lim": round(m["lim"], 1),
                   "ph": e.playhead, "pl": e.playing, "rc": e.recording, "ld": round(e.load, 2)}
            if e.recording:
                msg["rf"] = e.recorder.frames
                msg["dr"] = e.recorder.dropped
            lm, ls, corr = e.mixer.loud.read()
            msg["lu"] = [round(lm, 1), round(ls, 1), round(corr, 2)]
            msg["tpx"] = round(20 * math.log10(max(e.mixer.loud.tp_max, 1e-6)), 1)
            tick = getattr(self, "_tick", 0) + 1
            self._tick = tick
            if tick % 10 == 0:
                msg["li"] = round(e.mixer.loud.integrated(), 1)
                msg["lra"] = round(e.mixer.loud.lra(), 1)
            msg["zz"] = e.asleep
            if self.want_spectrum and not e.asleep:
                msg["sp"] = e.mixer.loud.spectrum()
            if e.mixer.focus is not None and not e.asleep:
                msg["csp"] = e.mixer.focus_ring.spectrum(e.sr)
            msg["ds"] = [round(v, 1) for v in m["ds"]]
            a = e.last_auto if e.playing else None
            if a:
                msg["au"] = {"f": a["fader"], "p": a["pan"], "m": a["mute"], "M": a["master"]}
            if e.playing and e.auto_values:
                msg["av"] = dict(e.auto_values)
                e.auto_values.clear()
            if e.export_job and e.export_job.get("running"):
                msg["ex"] = round(e.export_job["progress"], 3)
            await self.broadcast(msg)

    # ------------------------------------------------------------- websocket
    async def ws(self, request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        self.clients.add(ws)
        e = self.engine
        await ws.send_str(json.dumps({"t": "hello", "info": self.info(), "mixer": self.mixer_public(),
                                      "session": e.session.public(), "transport": e.transport(),
                                      "wing": self.wing.values}))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    await self.handle(ws, json.loads(msg.data))
                except Exception as ex:
                    traceback.print_exc()
                    await ws.send_str(json.dumps({"t": "error", "msg": str(ex)}))
        finally:
            self.clients.discard(ws)
        return ws

    async def handle(self, ws, m):
        e = self.engine
        t = m.get("t")
        if t == "set":
            now = time.time()
            if now - self.mix_ck > 1.0:  # one undo step per burst of moves
                self.mix_undo.append(e.mixer.snapshot())
                del self.mix_undo[:-100]
                self.mix_redo.clear()
            self.mix_ck = now
            e.mixer.set(m["path"], m["v"])
            e.dirty = True
            await self.broadcast({"t": "set", "path": m["path"], "v": m["v"]}, skip=ws)
            if e.touch(m["path"], m["v"]) and now - self.auto_push > 0.25:
                self.auto_push = now
                await self.broadcast({"t": "session", "session": e.session.public()})
        elif t in ("mixundo", "mixredo"):
            src, dst = (self.mix_undo, self.mix_redo) if t == "mixundo" else (self.mix_redo, self.mix_undo)
            if not src:
                await ws.send_str(json.dumps({"t": "error", "msg": "Nothing to " + ("undo" if t == "mixundo" else "redo") + " in the mixer"}))
                return
            dst.append(e.mixer.snapshot())
            st = src.pop()
            e.mixer.apply_state(st)
            e.dirty = True
            self.mix_ck = 0
            await self.broadcast({"t": "mixer", "mixer": self.mixer_public()})
            await ws.send_str(json.dumps({"t": "toast", "msg": "Mixer " + ("undo" if t == "mixundo" else "redo")}))
        elif t == "focus":
            e.mixer.focus = m.get("ch") if isinstance(m.get("ch"), int) else None
            e.mixer.focus_target = m.get("target") or None
        elif t == "transport":
            a = m["a"]
            if a == "play":
                e.play()
            elif a == "stop":
                e.stop()
            elif a == "record":
                e.record()
            elif a == "locate":
                e.locate(m["pos"])
            elif a == "toggle":
                e.stop() if (e.playing or e.recording) else e.play()
        elif t == "edit":
            e.session.edit(m["op"], m.get("args", {}))
            e.dirty = True
            if e.playing:
                e.locate(e.playhead)
            await self.broadcast({"t": "session", "session": e.session.public()})
        elif t in ("undo", "redo"):
            getattr(e.session, t)()
            e.dirty = True
            if e.playing:
                e.locate(e.playhead)
            await self.broadcast({"t": "session", "session": e.session.public()})
        elif t == "spectrum":
            self.want_spectrum = bool(m.get("on"))
        elif t == "wing":
            if m.get("a") == "set":
                self.wing.set(m["addr"], m["v"])
                await self.broadcast({"t": "wing", "addr": m["addr"], "v": m["v"]}, skip=ws)
            elif m.get("a") == "query":
                self.wing.query(*m["addrs"])

    # ------------------------------------------------------------- REST
    async def api(self, request):
        name = request.match_info["name"]
        e = self.engine
        body = {}
        if request.method == "POST" and request.content_type == "application/json":
            body = await request.json()
        q = request.query
        try:
            if name == "devices":
                return web.json_response(list_devices())
            if name == "info":
                return web.json_response(self.info())
            if name == "config":
                restart = any(k in body for k in ("input", "output", "sr", "block"))
                restart_cables = any(k in body for k in ("cable_out", "cable_in"))
                if "remote" in body:
                    e.cfg["remote"] = bool(body["remote"])
                    await self.set_remote(e.cfg["remote"])
                for k in ("input", "output", "sr", "block", "main_l", "main_r", "direct_outs",
                          "direct_offset", "monitor_live", "pin", "mon_l", "mon_r", "cable_out", "cable_in", "show_wing"):
                    if k in body:
                        e.cfg[k] = body[k]
                e.save_cfg()
                if restart:
                    await asyncio.get_running_loop().run_in_executor(None, e.start_audio)
                elif restart_cables:
                    await asyncio.get_running_loop().run_in_executor(None, e.start_cables)
                await self.broadcast({"t": "info", "info": self.info()})
                return web.json_response(self.info())
            if name == "loudness-reset":
                e.mixer.loud.reset()
                return web.json_response({"ok": True})
            if name == "audio-restart":
                await asyncio.get_running_loop().run_in_executor(None, e.start_audio)
                return web.json_response(self.info())
            if name == "session-new":
                e.new_session(body.get("name") or time.strftime("Service %Y-%m-%d"))
                await self._push("mixer")
                return web.json_response({"ok": True})
            if name == "export-estimate":
                return web.json_response(e.export_estimate(q.get("start"), q.get("end")))
            if name == "projects":
                from .session import list_sessions
                items = list_sessions(detail=True)
                for it in items:
                    it["current"] = not e.session.scratch and it["name"] == e.session.name
                return web.json_response(items)
            if name == "session-delete":
                from .session import delete_session, list_sessions
                if body["name"] == e.session.name and not e.session.scratch:
                    # deleting the open project: close it first, leaving no project open
                    e.open_scratch()
                    await self._push("session")
                where = delete_session(body["name"])
                return web.json_response({"ok": True, "where": where})
            if name == "session-open":
                e.open_session(body["name"])
                return web.json_response({"ok": True})
            if name == "save":
                e.save()
                return web.json_response({"ok": True})
            if name == "export":
                job = e.export(body.get("kind", "mix"), body.get("fmt", "wav"), body.get("start"), body.get("end"), body.get("target"),
                               body.get("depth", "24"), body.get("kbps"), body.get("channels", 2))
                return web.json_response(job)
            if name == "peaks":
                spp = int(q.get("spp", 1024))
                data = e.session.peaks(q["file"], spp).tobytes()
                return web.Response(body=data, content_type="application/octet-stream",
                                    headers={"Cache-Control": "max-age=3600"})
            if name == "plugins":
                found = []
                for d, pat in plugin_dirs():
                    for p in glob.glob(os.path.join(d, pat), recursive=True):
                        found.append({"path": p, "name": os.path.splitext(os.path.basename(p))[0],
                                      "kind": "AU" if p.endswith(".component") else "VST3"})
                found.sort(key=lambda p: p["name"].lower())
                return web.json_response(found)
            # ---- settings files (channel / whole mix) and projects
            if name == "settings-library":
                return web.json_response(portable.list_library())
            if name == "channel-save":
                c = int(body["ch"])
                path, data = portable.save_channel(e.mixer.state["channels"][c], body.get("name"))
                return web.json_response({"path": path, "data": data})
            if name == "channel-read":
                return web.json_response(portable.read_channel(q["name"]))
            if name == "channel-delete":
                portable.delete_channel(body["name"])
                return web.json_response({"ok": True})
            if name == "mix-save":
                folder, n = portable.save_mix(e.mixer.snapshot(), body.get("name") or (e.session.name + " mix"))
                return web.json_response({"folder": folder, "channels": n})
            if name == "mix-read":
                return web.json_response(portable.read_mix(q["name"]))
            if name == "settings-upload":
                reader = await request.multipart()
                out = []
                async for part in reader:
                    if part.filename:
                        raw = await part.read(decode=False)
                        try:
                            out.append(portable.store_upload(part.filename, raw))
                        except Exception as ex:
                            raise RuntimeError(f"{part.filename}: not a Stobite settings file ({ex})")
                chans = [d for d in out if d.get("kind") == "stobite-channel"]
                glob_ = next((d for d in out if d.get("kind") == "stobite-mix"), None)
                return web.json_response({"channels": chans, "globals": glob_})
            if name == "settings-apply":
                st = e.mixer.snapshot()
                opts = body.get("opts") or {}
                for a in body.get("assign") or []:
                    c = int(a["ch"])
                    if 0 <= c < len(st["channels"]):
                        portable.apply_channel(st["channels"][c], a["data"], opts)
                g = body.get("globals")
                if g:
                    for k in ("buses", "fx", "master", "tempo", "song", "cables"):
                        if g.get(k) is not None:
                            st[k] = g[k]
                e.mixer.apply_state(st)
                e.dirty = True
                await self._push("mixer")
                return web.json_response({"ok": True})
            if name == "project-export":
                if e.export_job and e.export_job.get("running"):
                    raise RuntimeError("An export is already running")
                job = {"running": True, "progress": 0.0, "kind": "project", "file": None, "error": None}
                e.export_job = job

                def run_export():
                    try:
                        job["file"] = portable.export_project(e.session, e.mixer.snapshot(), lambda f: job.__setitem__("progress", f))
                    except Exception as ex:
                        traceback.print_exc()
                        job["error"] = str(ex)
                    job["running"] = False
                    job["progress"] = 1.0
                    e.emit("export")
                threading.Thread(target=run_export, daemon=True).start()
                return web.json_response(job)
            if name == "project-import":
                reader = await request.multipart()
                tmp = None
                async for part in reader:
                    if part.filename:
                        tmp = portable.temp_path(".stobite")
                        with open(tmp, "wb") as f:
                            while chunk := await part.read_chunk(1 << 20):
                                f.write(chunk)
                if not tmp:
                    raise RuntimeError("No project file received")
                try:
                    sname = await asyncio.get_running_loop().run_in_executor(None, portable.import_project, tmp)
                finally:
                    os.remove(tmp)
                e.open_session(sname)
                await self._push("mixer")
                return web.json_response({"name": sname})
            if name == "plugin-params":
                return web.json_response(e.plugin_params(q["mid"]))
            if name == "plugin-param":
                path = body["path"] + ["params", body["key"]]
                e.mixer.set(path, float(body["v"]))
                e.dirty = True
                if e.touch(path, body["v"]):
                    await self.broadcast({"t": "session", "session": e.session.public()})
                return web.json_response({"ok": True})
            if name == "scenes":
                d = os.path.join(home_dir(), "Scenes")
                os.makedirs(d, exist_ok=True)
                return web.json_response(sorted(os.path.splitext(f)[0] for f in os.listdir(d) if f.endswith(".json")))
            if name == "scene-save":
                d = os.path.join(home_dir(), "Scenes")
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, safe_name(body["name"]) + ".json"), "w") as f:
                    json.dump(e.mixer.snapshot(), f)
                return web.json_response({"ok": True})
            if name == "scene-delete":
                path = os.path.join(home_dir(), "Scenes", safe_name(body["name"]) + ".json")
                if os.path.exists(path):
                    os.remove(path)
                return web.json_response({"ok": True})
            if name == "scene-load":
                with open(os.path.join(home_dir(), "Scenes", safe_name(body["name"]) + ".json")) as f:
                    st = json.load(f)
                scope = body.get("scope")  # None = everything
                if scope is None:
                    e.mixer.replace_state(st)
                else:
                    e.mixer.apply_state(merge_scene(e.mixer.snapshot(), st, scope, set(body.get("safe", []))))
                e.dirty = True
                await self._push("mixer")
                return web.json_response({"ok": True})
            if name == "mixer-reset":
                from .mixer import default_state
                e.mixer.replace_state(default_state(e.nch))
                e.dirty = True
                await self._push("mixer")
                return web.json_response({"ok": True})
            if name == "catalog":
                from .catalog import catalog
                return web.json_response(catalog())
            if name == "bus-add":
                bid = e.mixer.add_bus(body.get("name", ""), body.get("out", "broadcast"))
                e.dirty = True
                await self._push("mixer")
                return web.json_response({"id": bid})
            if name == "bus-remove":
                e.mixer.remove_bus(body["id"])
                e.dirty = True
                await self._push("mixer")
                return web.json_response({"ok": True})
            if name == "wing-names":
                # read-only: asks the WING for its channel names/colours, never changes anything on it
                ip = body.get("ip") or e.cfg.get("wing_ip")
                if not ip:
                    found = await asyncio.get_running_loop().run_in_executor(None, wingmod.discover)
                    if not found:
                        raise RuntimeError("No WING found on the network. Check its Ethernet cable, or type its IP address.")
                    ip = found[0]["ip"]
                reader = wingmod.WingBridge()
                reader.connect(ip)
                addrs = [f"/ch/{n}/{k}" for n in range(1, 41) for k in ("name", "col", "icon")]
                addrs += [f"/aux/{n}/{k}" for n in range(1, 9) for k in ("name", "col", "icon")]
                for i in range(0, len(addrs), 24):
                    reader.query(*addrs[i:i + 24])
                    await asyncio.sleep(0.05)
                await asyncio.sleep(1.2)
                vals = dict(reader.values)
                reader.close()
                if not vals:
                    raise RuntimeError(f"The WING at {ip} didn't answer. Is its Ethernet port on the same network?")
                chans = []
                for kind, count in (("ch", 40), ("aux", 8)):
                    for n in range(1, count + 1):
                        chans.append({"name": vals.get(f"/{kind}/{n}/name"), "col": vals.get(f"/{kind}/{n}/col"),
                                      "icon": vals.get(f"/{kind}/{n}/icon")})
                e.cfg["wing_ip"] = ip
                e.save_cfg()
                return web.json_response({"ip": ip, "channels": chans})
            if name == "wing-discover":
                found = await asyncio.get_running_loop().run_in_executor(None, wingmod.discover)
                return web.json_response(found)
            if name == "wing-connect":
                if body.get("ip"):
                    self.wing.connect(body["ip"])
                    e.cfg["wing_ip"] = body["ip"]
                    e.save_cfg()
                else:
                    self.wing.close()
                return web.json_response(self.info()["wing"])
            if name == "import":
                reader = await request.multipart()
                track = int(q.get("track", 0))
                start = int(q.get("start", 0))
                e.promote()   # importing into "no project" makes a real project first
                async for part in reader:
                    if part.filename:
                        suffix = os.path.splitext(part.filename)[1]
                        fd, tmp = tempfile.mkstemp(suffix=suffix)
                        with os.fdopen(fd, "wb") as f:
                            while chunk := await part.read_chunk():
                                f.write(chunk)
                        final = os.path.join(os.path.dirname(tmp), part.filename)
                        os.replace(tmp, final)
                        await asyncio.get_running_loop().run_in_executor(None, e.session.import_file, final, track, start)
                        os.remove(final)
                e.dirty = True
                await self._push("session")
                return web.json_response({"ok": True})
            if name == "download":
                path = os.path.realpath(q["file"])
                if not path.startswith(os.path.realpath(os.path.join(home_dir(), "Exports"))) or not os.path.isfile(path):
                    raise web.HTTPForbidden()
                return web.FileResponse(path, headers={
                    "Content-Disposition": f'attachment; filename="{os.path.basename(path)}"'})
            if name == "reveal":
                what = q.get("what")
                path = (e.export_job["file"] if (what == "export" and e.export_job) else
                        portable.presets_dir() if what == "presets" else
                        os.path.join(portable.presets_dir("Mixes"), q.get("name", "")) if what == "mix" else e.session.dir)
                if request.remote in ("127.0.0.1", "::1") and path:
                    if sys.platform == "darwin":
                        os.system(f'open -R "{path}"')
                    elif sys.platform == "win32":
                        os.startfile(os.path.dirname(path) if os.path.isfile(path) else path)
                return web.json_response({"ok": True})
            raise web.HTTPNotFound()
        except web.HTTPException:
            raise
        except Exception as ex:
            traceback.print_exc()
            return web.json_response({"error": str(ex)}, status=400)

    # ------------------------------------------------------------- auth
    @web.middleware
    async def auth(self, request, handler):
        pin = self.engine.cfg.get("pin") or ""
        local = request.remote in ("127.0.0.1", "::1")
        if not pin or local or request.cookies.get("stobite_pin") == pin:
            return await handler(request)
        if request.path == "/login" and request.method == "POST":
            data = await request.post()
            if data.get("pin") == pin:
                r = web.HTTPFound("/")
                r.set_cookie("stobite_pin", pin, max_age=60 * 60 * 24 * 30)
                raise r
        return web.Response(content_type="text/html", text=LOGIN_HTML)

    async def index(self, request):
        return web.FileResponse(os.path.join(web_dir(), "index.html"), headers={"Cache-Control": "no-cache"})


LOGIN_HTML = """<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Stobite Compact</title><style>body{background:#111214;color:#eee;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:12px;padding:24px;background:#1b1d21;border-radius:12px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #333;background:#0d0e10;color:#eee}
button{background:#f76b15;border:0;color:#000;font-weight:600}</style>
<form method=post action=/login><b>Stobite Compact remote</b><input name=pin type=password inputmode=numeric placeholder="PIN" autofocus><button>Enter</button></form>"""


SCENE_SCOPES = {
    "faders": {"channels": ["fader", "pan"], "buses": ["fader", "balance", "width"], "fx": ["ret"], "master": ["fader"]},
    "mutes": {"channels": ["mute", "solo"], "buses": ["mute"], "fx": ["mute"], "master": ["mute"]},
    "processing": {"channels": ["chain", "trim", "phase"], "buses": ["chain", "duck"], "master": ["chain"]},
    "sends": {"channels": ["sends"], "buses": ["sends"]},
    "fx": {"fx": ["type", "params", "duck", "name"]},
    "routing": {"channels": ["out", "input"], "buses": ["out"], "fx": ["out"]},
}


def merge_scene(cur, scene, scope, safe):
    """Recall only the chosen parts of a scene, leaving everything else (and safe channels) alone."""
    from .mixer import migrate
    scene = migrate(scene, len(cur["channels"]))
    scope = {"processing" if s in ("eq", "dynamics") else s for s in scope}
    out = cur
    for cat in scope:
        for section, keys in SCENE_SCOPES.get(cat, {}).items():
            if section == "master":
                for k in keys:
                    if k in scene.get("master", {}):
                        out["master"][k] = copy.deepcopy(scene["master"][k])
                continue
            src_list, dst_list = scene.get(section, []), out.get(section, [])
            if section == "buses":
                by_id = {b["id"]: b for b in src_list}
                pairs = [(by_id.get(b["id"]), b) for b in dst_list]
            else:
                pairs = list(zip(src_list, dst_list))
            for i, (src, dst) in enumerate(pairs):
                if src is None or (section == "channels" and i in safe):
                    continue
                for k in keys:
                    if k in src:
                        dst[k] = copy.deepcopy(src[k])
    return out


def build_app():
    a = App()
    app = web.Application(middlewares=[a.auth], client_max_size=4 * 1024 ** 3)
    app.router.add_get("/", a.index)
    app.router.add_post("/login", a.index)
    app.router.add_get("/ws", a.ws)
    app.router.add_route("*", "/api/{name}", a.api)
    app.router.add_static("/static", web_dir())

    async def on_start(_):
        a.loop = asyncio.get_running_loop()
        # don't hold the UI hostage to the audio device (macOS may be showing the
        # microphone-permission prompt); the status dot updates once it's running
        a.engine.status = "starting"
        a.loop.run_in_executor(None, a.engine.start_audio)
        if a.engine.cfg.get("wing_ip"):
            a.wing.connect(a.engine.cfg["wing_ip"])
        asyncio.ensure_future(a.meter_loop())

    async def on_stop(_):
        a.engine.stop()
        a.engine.save()
        a.engine.stop_audio()

    async def no_stale_ui(request, response):
        # always revalidate the UI files (cheap 304s) so an update is never hidden by the browser cache
        if request.path.startswith("/static/") or request.path == "/":
            response.headers["Cache-Control"] = "no-cache"

    app.on_response_prepare.append(no_stale_ui)
    app.on_startup.append(on_start)
    app.on_shutdown.append(on_stop)
    app["stobite"] = a
    return app
