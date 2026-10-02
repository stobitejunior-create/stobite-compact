"""Remote control of the Behringer WING / WING Compact console over the network.

The WING speaks OSC on UDP port 2223 and answers discovery ("WING?") on
UDP port 2222. Changing the console itself has no latency, unlike sending
the audio through the computer, so use this to adjust the room mix from
outside the room.
"""
import socket
import struct
import threading
import time

OSC_PORT = 2223
DISCOVERY_PORT = 2222


def _pad(b):
    return b + b"\0" * (4 - len(b) % 4)


def osc_encode(addr, *args):
    tags = ","
    payload = b""
    for a in args:
        if isinstance(a, bool) or isinstance(a, int):
            tags += "i"
            payload += struct.pack(">i", int(a))
        elif isinstance(a, float):
            tags += "f"
            payload += struct.pack(">f", a)
        else:
            tags += "s"
            payload += _pad(str(a).encode())
    msg = _pad(addr.encode())
    if args:
        msg += _pad(tags.encode()) + payload
    return msg


def _read_str(data, i):
    end = data.index(b"\0", i)
    s = data[i:end].decode(errors="replace")
    return s, (end + 4) & ~3


def osc_decode(data):
    addr, i = _read_str(data, 0)
    if i >= len(data):
        return addr, []
    tags, i = _read_str(data, i)
    args = []
    for t in tags[1:]:
        if t == "i":
            args.append(struct.unpack(">i", data[i:i + 4])[0]); i += 4
        elif t == "f":
            args.append(struct.unpack(">f", data[i:i + 4])[0]); i += 4
        elif t == "s":
            s, i = _read_str(data, i); args.append(s)
    return addr, args


def discover(timeout=1.5):
    found = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.3)
    try:
        s.sendto(b"WING?", ("255.255.255.255", DISCOVERY_PORT))
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(1024)
            except socket.timeout:
                continue
            parts = data.decode(errors="replace").strip("\0").split(",")
            if parts and parts[0] == "WING":
                found.append({"ip": ip, "name": parts[2] if len(parts) > 2 else "WING",
                              "model": parts[3] if len(parts) > 3 else "", "firmware": parts[5] if len(parts) > 5 else ""})
    finally:
        s.close()
    return found


class WingBridge:
    def __init__(self, on_update=None):
        self.ip = None
        self.sock = None
        self.values = {}
        self.on_update = on_update
        self.last_rx = 0.0

    @property
    def connected(self):
        return self.ip is not None and time.time() - self.last_rx < 15

    def connect(self, ip):
        self.close()
        self.ip = ip
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.settimeout(0.5)
        threading.Thread(target=self._rx, args=(self.sock,), daemon=True).start()
        self.query("/main/1/fdr")

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock, self.ip = None, None

    def send(self, addr, *args):
        if self.sock and self.ip:
            self.sock.sendto(osc_encode(addr, *args), (self.ip, OSC_PORT))

    def set(self, addr, value):
        if isinstance(value, bool):
            value = int(value)
        self.send(addr, value)
        self.values[addr] = value

    def query(self, *addrs):
        for a in addrs:
            self.send(a)

    def _rx(self, sock):
        while self.sock is sock:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                addr, args = osc_decode(data)
            except Exception:
                continue
            self.last_rx = time.time()
            # WING answers queries with ",sff": text, normalised value, real value
            val = None
            if len(args) >= 3 and isinstance(args[2], float):
                val = args[2]
            elif args:
                val = args[0]
            if addr.endswith("/mute") and isinstance(val, float):
                val = int(val)
            self.values[addr] = val
            if self.on_update:
                self.on_update(addr, val)
