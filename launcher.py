"""ASound.exe: start the local server and open ASound in its own window.

The window is Microsoft Edge in app mode (no address bar) with its own profile, so it behaves like a desktop
app and closing it quits ASound. Without Edge, the default browser is used and ASound keeps running until
its small control window is closed.
"""

import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

import server

URL = f"http://127.0.0.1:{server.PORT}/"


def find_edge():
    candidates = [
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
    ]
    return next((p for p in candidates if p and os.path.exists(p)), None)


def already_running():
    try:
        with urllib.request.urlopen(URL + "api/health", timeout=1):
            return True
    except Exception:
        return False


def open_window():
    edge = find_edge()
    if not edge:
        webbrowser.open(URL)
        return None
    profile = os.path.join(os.environ.get("LOCALAPPDATA", server.ROOT), "ASound", "window")
    os.makedirs(profile, exist_ok=True)
    return subprocess.Popen([
        edge, f"--app={URL}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
        "--window-size=1180,860", "--disable-features=Translate",
    ])


def wait_without_edge():
    # Keep the server alive behind a small Windows message box; OK quits (no GUI toolkit needed in the exe).
    import ctypes
    ctypes.windll.user32.MessageBoxW(None, "ASound is running in your browser.\n\nClick OK to quit ASound.", "ASound", 0x40)


def main():
    # Test hooks: ASound.exe --port 8780 --no-window  serves on another port without opening a window.
    if "--port" in sys.argv:
        server.PORT = int(sys.argv[sys.argv.index("--port") + 1])
    if "--no-window" in sys.argv:
        server.make_server().serve_forever()
        return
    if already_running():
        open_window()
        return
    httpd = server.make_server()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.3)
    window = open_window()
    try:
        if window is not None:
            window.wait()
        else:
            wait_without_edge()
    finally:
        server.NATURAL.stop()
        httpd.shutdown()
    sys.exit(0)


if __name__ == "__main__":
    main()
