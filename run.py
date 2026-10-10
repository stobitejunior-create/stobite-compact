"""Stobite Compact - start the audio engine + UI server and open the app window.

  run.py              native app window (falls back to the browser)
  run.py --browser    open in the default browser instead
  run.py --no-browser headless: engine + remote only (use from a phone)

On a Mac, closing the window only hides it (like Notes): audio, recording and the
phone remote keep running. Click the Dock icon to bring it back; Quit (Cmd+Q) exits.
"""
import asyncio
import os
import sys
import threading
import time
import webbrowser

from aiohttp import web

from stobite.server import build_app, PORT, lan_ips


def serve(ready, holder):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    app = build_app()
    runner = web.AppRunner(app, handle_signals=False)
    loop.run_until_complete(runner.setup())
    a = app["stobite"]
    a.runner = runner
    # the phone remote (network access) is off unless switched on in Setup; headless mode needs it
    remote = bool(a.engine.cfg.get("remote", False)) or "--no-browser" in sys.argv
    loop.run_until_complete(a.set_remote(remote))
    holder["loop"], holder["runner"], holder["app"] = loop, runner, app
    ready.set()
    loop.run_forever()


def shutdown(holder):
    """Finish recording, save, release the audio device, then exit immediately.
    (Waiting for the web server to close every open phone/window connection is
    what used to freeze the app for several seconds on quit.)"""
    app = holder.get("app")
    try:
        e = app["stobite"].engine if app is not None else None
        if e is not None:
            e.stop()          # finalises any recording in progress
            e.save()
            e.cables.stop()
            e.extra.stop()
            if e.stream is not None:
                try:
                    e.stream.abort()   # abort returns at once; stop() waits for buffers to drain
                    e.stream.close()
                except Exception:
                    pass
    except Exception as ex:  # never let a shutdown problem keep the app hanging
        print("shutdown:", ex, flush=True)
    sys.stdout.flush()
    os._exit(0)


def mac_window_behaviour(window, holder):
    """Close = hide; Dock icon = show again; Cmd+Q = really quit."""
    state = {"quitting": False}

    def on_closing():
        if state["quitting"]:
            return True
        window.hide()
        return False  # cancel the close; the app keeps running

    window.events.closing += on_closing
    # pywebview only honours "cancel the close" when the handler runs synchronously
    window.events.closing._should_lock = True
    try:
        import objc
        from webview.platforms.cocoa import BrowserView
        delegate = BrowserView.AppDelegate
    except Exception as ex:
        print("Mac window behaviour unavailable:", ex, flush=True)
        state["quitting"] = True  # fall back to normal close = quit
        return
    def reopen(self, app, has_visible):
        window.show()
        return True

    try:
        original = delegate.applicationShouldTerminate_

        def should_terminate(self, app):
            state["quitting"] = True
            threading.Thread(target=shutdown, args=(holder,), daemon=True).start()
            return original(self, app)

        objc.classAddMethods(delegate, [objc.selector(
            should_terminate, selector=b"applicationShouldTerminate:", signature=original.signature)])
    except Exception as ex:
        # without the quit hook a hidden window could never quit, so keep normal close = quit
        print("Quit hook unavailable:", ex, flush=True)
        state["quitting"] = True
        return
    try:
        objc.classAddMethods(delegate, [objc.selector(
            reopen, selector=b"applicationShouldHandleReopen:hasVisibleWindows:", signature=b"Z@:@Z")])
    except Exception as ex:
        print("Dock reopen unavailable:", ex, flush=True)

# ---- menu bar: each item runs the same command as its keyboard shortcut (web/commands.js).
# (title, command or "#selector" for a built-in macOS action, key, modifiers). None = separator.
MENUS = [
    ("File", [("New Project…", "newProject", "n", "cmd"), ("Open Project…", "openProject", "o", "cmd"), None,
              ("Import Audio…", "importAudio", "i", "cmd+shift"), ("Save", "save", "s", "cmd"), ("Export…", "exportMix", "e", "cmd"), None,
              ("Mix Settings & Templates…", "mixSettings", "m", "cmd+shift"), None, ("Close Window", "#performClose:", "w", "cmd")]),
    ("Edit", [("Undo", "undo", "z", "cmd"), ("Redo", "redo", "z", "cmd+shift"), None,
              ("Cut", "#cut:", "x", "cmd"), ("Copy", "#copy:", "c", "cmd"), ("Paste", "#paste:", "v", "cmd"),
              ("Duplicate", "duplicate", "d", "cmd"), ("Delete", "delete", "", ""), ("Select All", "#selectAll:", "a", "cmd"), None,
              ("Split at Playhead", "split", "t", "cmd"), ("Join Clips", "join", "j", "cmd"), ("Normalize", "normalize", "", ""),
              ("Reverse", "reverse", "", ""), ("Mute / Unmute Clip", "muteClip", "m", "ctrl"), ("Rename Clip…", "renameClip", "", ""), None,
              ("Add Marker", "marker", "", "")]),
    ("Transport", [("Play / Pause    Space", "play", "", ""), ("Record    R", "record", "", ""), ("Stop", "stop", "", ""),
                   ("Go to Start    ↩", "toStart", "", ""), None, ("Cycle    C", "cycle", "", ""), ("Metronome    K", "metronome", "", ""),
                   ("Count-in    ⇧K", "countIn", "", ""), None, ("Tempo & Time Signature…", "tempo", "", "")]),
    ("View", [("Edit", "viewEdit", "1", "cmd"), ("Mixer", "viewMixer", "2", "cmd"), ("Routing", "viewRouting", "3", "cmd"),
              ("Master", "viewMaster", "4", "cmd"), ("Setup", "viewSetup", ",", "cmd"), None,
              ("Zoom In", "zoomIn", "=", "cmd"), ("Zoom Out", "zoomOut", "-", "cmd"), ("Zoom to Fit    Z", "fit", "", ""), None,
              ("Snap to Grid", "snap", "g", "cmd"), ("Bars & Beats Ruler", "beats", "", ""), ("Follow Playhead    F", "follow", "", ""), None,
              ("Enter Full Screen", "#toggleFullScreen:", "f", "cmd+ctrl")]),
    ("Window", [("Minimize", "#performMiniaturize:", "m", "cmd"), ("Zoom", "#performZoom:", "", "")]),
    ("Help", [("Keyboard Shortcuts", "shortcuts", "/", "cmd"), ("Help & Guides", "help", "", "")]),
]
# what the built-in macOS actions do on Windows (where there are none)
WIN_EQUIV = {"#cut:": "cut", "#copy:": "copy", "#paste:": "paste", "#selectAll:": "selectAll"}


def build_menu(holder):
    from webview.menu import Menu, MenuAction, MenuSeparator
    mac = sys.platform == "darwin"

    def action(cmd):
        def run_command():
            w = holder.get("window")
            if w is not None:   # never block the menu (main) thread on the page
                threading.Thread(target=lambda: w.evaluate_js(f"window.runCmd && runCmd({cmd!r})"), daemon=True).start()
        return run_command

    out = []
    for title, items in MENUS:
        entries = []
        for it in items:
            if it is None:
                entries.append(MenuSeparator())
                continue
            label, cmd, key, mods = it
            if not mac:
                label = label.split("    ")[0]
                if cmd.startswith("#"):
                    if cmd not in WIN_EQUIV:
                        continue
                    cmd = WIN_EQUIV[cmd]
            a = MenuAction(label, action(cmd))
            a.meta = (cmd[1:] if cmd.startswith("#") else None, key, mods)
            entries.append(a)
        if entries:
            out.append(Menu(title, entries))
    return out


def mac_menu_shortcuts():
    """pywebview can't show shortcuts in menus yet: add the key equivalents (and the built-in
    cut/copy/paste/full-screen actions) as the menus are built."""
    try:
        import AppKit
        from webview.platforms.cocoa import BrowserView
    except Exception as ex:
        print("Menu shortcuts unavailable:", ex, flush=True)
        return
    original = BrowserView._process_menu_items
    flags = {"cmd": AppKit.NSEventModifierFlagCommand, "shift": AppKit.NSEventModifierFlagShift,
             "ctrl": AppKit.NSEventModifierFlagControl, "alt": AppKit.NSEventModifierFlagOption}

    def process(self, menu_items, parent_menu):
        original(self, menu_items, parent_menu)
        try:
            for item, ns in zip(menu_items, parent_menu.itemArray()):
                meta = getattr(item, "meta", None)
                if not meta:
                    continue
                selector, key, mods = meta
                if selector:   # a built-in action: goes to whatever has focus (text boxes keep working)
                    ns.setAction_(selector)
                    ns.setTarget_(None)
                if key:
                    ns.setKeyEquivalent_(key)
                    mask = 0
                    for m in mods.split("+"):
                        mask |= flags.get(m, 0)
                    ns.setKeyEquivalentModifierMask_(mask)
        except Exception as ex:
            print("Menu shortcut:", ex, flush=True)
    BrowserView._process_menu_items = process


def main():
    url = f"http://localhost:{PORT}"
    print("\n  Stobite Compact running", flush=True)
    print(f"  This computer:  {url}", flush=True)
    for ip in lan_ips():
        print(f"  Remote (Wi-Fi, when switched on in Setup): http://{ip}:{PORT}", flush=True)
    print(flush=True)

    holder, ready = {}, threading.Event()
    threading.Thread(target=serve, args=(ready, holder), daemon=True).start()
    ready.wait(60)

    if "--no-browser" in sys.argv or "--browser" in sys.argv:
        if "--browser" in sys.argv:
            webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    else:
        try:
            import webview
            webview.settings["SHOW_DEFAULT_MENUS"] = False   # ours include Edit (copy/paste) and View
            if sys.platform == "darwin":
                mac_menu_shortcuts()
            window = webview.create_window("Stobite Compact", url, width=1440, height=900, min_size=(900, 600),
                                           background_color="#0e0f11", text_select=False)
            holder["window"] = window
            if sys.platform == "darwin":
                mac_window_behaviour(window, holder)
            webview.start(menu=build_menu(holder))
        except Exception as ex:  # no native webview available -> browser
            print("Native window unavailable, using browser:", ex, flush=True)
            webbrowser.open(url)
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                pass
    shutdown(holder)


if __name__ == "__main__":
    main()
