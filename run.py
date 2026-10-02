"""Stobite Compact - start the audio engine + UI server and open the app window.

  run.py              native app window (falls back to the browser)
  run.py --browser    open in the default browser instead
  run.py --no-browser headless: engine + remote only (use from a phone)
"""
import asyncio
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
    loop.run_until_complete(web.TCPSite(runner, "0.0.0.0", PORT).start())
    holder["loop"], holder["runner"] = loop, runner
    ready.set()
    loop.run_forever()


def shutdown(holder):
    loop, runner = holder.get("loop"), holder.get("runner")
    if loop and runner:
        fut = asyncio.run_coroutine_threadsafe(runner.cleanup(), loop)  # saves the session, stops audio
        try:
            fut.result(timeout=10)
        except Exception:
            pass
        loop.call_soon_threadsafe(loop.stop)


def main():
    url = f"http://localhost:{PORT}"
    print("\n  Stobite Compact running", flush=True)
    print(f"  This computer:  {url}", flush=True)
    for ip in lan_ips():
        print(f"  Remote (Wi-Fi): http://{ip}:{PORT}", flush=True)
    print(flush=True)

    holder, ready = {}, threading.Event()
    threading.Thread(target=serve, args=(ready, holder), daemon=True).start()
    ready.wait(60)

    if "--no-browser" in sys.argv:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    elif "--browser" in sys.argv:
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    else:
        try:
            import webview
            webview.create_window("Stobite Compact", url, width=1440, height=900, min_size=(900, 600),
                                  background_color="#0e0f11", text_select=False)
            webview.start()
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
