# PyInstaller build for macOS (.app) and Windows (.exe folder).
# macOS:   .venv/bin/pyinstaller "Stobite Compact.spec"
# Windows: .venv\Scripts\pyinstaller "Stobite Compact.spec"
import sys
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [("web", "web"), ("stobite/headphones.json", "stobite")], [], []
for pkg in ("sounddevice", "_sounddevice_data", "soundfile", "_soundfile_data", "pedalboard", "webview"):
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hiddenimports += h
    except Exception:
        pass

a = Analysis(["run.py"], datas=datas, binaries=binaries, hiddenimports=hiddenimports + ["scipy.signal"], excludes=["tkinter", "matplotlib"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Stobite Compact", console=False,
          icon="assets/icon.icns" if sys.platform == "darwin" else "assets/icon.ico")
coll = COLLECT(exe, a.binaries, a.datas, name="Stobite Compact")
if sys.platform == "darwin":
    app = BUNDLE(coll, name="Stobite Compact.app", icon="assets/icon.icns", bundle_identifier="com.stobite.compact",
                 info_plist={
                     "NSMicrophoneUsageDescription": "Stobite Compact records the audio channels coming from your Behringer WING.",
                     "NSLocalNetworkUsageDescription": "Lets phones on your Wi-Fi use the remote, and talks to the WING console.",
                     "LSMinimumSystemVersion": "11.0",
                     "NSHighResolutionCapable": True,
                 })
