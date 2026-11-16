#!/usr/bin/env python3
"""Set the house battery's max discharge power on the SUN2000 inverter (register 47077).

Usage: ha-inverter-discharge-limit.py <serial> <watts> [deadband W, default 150: evcc's residual power]
       ha-inverter-discharge-limit.py <serial> backup <percent>
Runs in Home Assistant (shell_command inverter_discharge_limit, copied to
/config/scripts/inverter_discharge_limit.py), every minute from the automation
house_battery_discharge_limit: while the car charges, the limit is the house's consumption
less the solar (home power minus PV power, never below 0; an unreadable PV counts as 0 W), so
the solar covers the house first, the battery only what is left and never the wallbox;
otherwise the inverter's rated max.

The EMMA accepts a single Modbus client (evcc), so this goes through evcc's
modbusproxy (port 5020, readonly: false). The EMMA assigns the inverter's unit id
itself, so the inverter is found by serial number (register 30015) and the id is
cached next to this script. Writes only when the register is off by more than the
deadband (evcc's residual power; the register may be stored in flash) and reads it back. Prints
"unit <id> limit <W> (was <W>)"; exit 0 = register holds the target, 1 = failure.

"backup <percent>" sets the backup power SOC instead (register 47102, shell_command
inverter_backup_soc, automation house_battery_backup_only): the battery never discharges
below it while the grid is up, and the EMMA charges it from the grid up to it. 100 keeps
the whole battery for outages, 0 gives it back to the house. Prints "unit <id> backup SOC
<%> (was <%>)".

"--grid" reports whether the grid is up (command_line binary_sensor grid_outage, every minute): it reads
the grid voltage of the EMMA's built-in energy sensor (unit 0, register 31639, 0.01 V) and prints "up"
or "outage" (below 100 V). Any failure prints nothing on stdout and exits 1, so the sensor goes unknown,
never "outage". Needs no serial number.
Stdlib only.
"""
import os
import socket
import struct
import sys

PROXY = ("127.0.0.1", 5020)
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".inverter_unit")
DEADBAND = 150  # W, overridden by the third argument
GRID_VOLTAGE = (0, 31639)  # EMMA unit, built-in energy sensor phase A voltage (0.01 V)
GRID_DOWN_BELOW = 10000  # 100 V


class Modbus:
    def __init__(self):
        # opening a connection through the proxy takes seconds, a request ~1 s: reuse one
        self.sock = socket.create_connection(PROXY, timeout=15)
        self.tid = 0

    def request(self, uid, pdu):
        self.tid = (self.tid + 1) & 0xFFFF
        try:
            self.sock.sendall(struct.pack(">HHHB", self.tid, 0, len(pdu) + 1, uid) + pdu)
            tid, _, length, _ = struct.unpack(">HHHB", self.recv(7))
            body = self.recv(length - 1)
        except socket.timeout:
            # a late answer would desync every later request: start a fresh connection
            self.sock.close()
            self.sock = socket.create_connection(PROXY, timeout=15)
            return None
        if tid != self.tid or body[0] & 0x80:
            return None
        return body

    def recv(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("closed")
            data += chunk
        return data

    def read(self, uid, addr, count):
        body = self.request(uid, struct.pack(">BHH", 3, addr, count))
        return body and body[2:]

    def read_u32(self, uid, addr):
        data = self.read(uid, addr, 2)
        return data and struct.unpack(">I", data)[0]

    def read_u16(self, uid, addr):
        data = self.read(uid, addr, 1)
        return data and struct.unpack(">H", data)[0]

    def write_u16(self, uid, addr, value):
        return self.request(uid, struct.pack(">BHH", 6, addr, value)) is not None

    def write_u32(self, uid, addr, value):
        body = self.request(uid, struct.pack(">BHHBI", 16, addr, 2, 4, value))
        return body is not None

    def serial(self, uid):
        data = self.read(uid, 30015, 10)
        return data and data.split(b"\0")[0].decode(errors="replace").strip()


def find_unit(bus, serial):
    try:
        cached = int(open(CACHE).read())
    except (OSError, ValueError):
        cached = 5
    for uid in [cached] + [u for u in range(1, 31) if u != cached]:
        if bus.serial(uid) == serial:
            if uid != cached:
                open(CACHE, "w").write(str(uid))
            return uid
    return None


def target_for(watts, rated):
    return max(0, min(int(watts), rated))


def needs_write(current, target, rated, deadband=DEADBAND):
    # always write the end points exactly (0 = hold, rated = free); otherwise only big changes
    if current is None:
        return True
    if target in (0, rated):
        return current != target
    return abs(current - target) > deadband


def backup_target(percent):
    return max(0, min(int(float(percent)), 100)) * 10  # register 47102 is in 0.1 %


def set_backup_soc(bus, uid, percent):
    target = backup_target(percent)
    current = bus.read_u16(uid, 47102)
    if current != target:
        if not bus.write_u16(uid, 47102, target):
            print(f"unit {uid} backup SOC write {target // 10} rejected (was {current})")
            return 1
        after = bus.read_u16(uid, 47102)
        if after != target:
            print(f"unit {uid} wrote backup SOC {target // 10}, reads {after}")
            return 1
    print(f"unit {uid} backup SOC {target // 10} (was {current if current is None else current // 10})")
    return 0


def grid_state(raw):
    return None if raw is None else "up" if raw >= GRID_DOWN_BELOW else "outage"


def grid_status():
    try:
        raw = Modbus().read_u32(*GRID_VOLTAGE)
    except (OSError, ConnectionError) as e:
        print(f"proxy unreachable: {e}", file=sys.stderr)
        return 1
    state = grid_state(raw)
    if state is None:
        print("grid voltage unreadable", file=sys.stderr)
        return 1
    print(f"grid voltage {raw / 100} V", file=sys.stderr)
    print(state)
    return 0


def main():
    serial = sys.argv[1]
    try:
        bus = Modbus()
    except OSError as e:
        print(f"proxy unreachable: {e}")
        return 1
    uid = find_unit(bus, serial)
    if uid is None:
        print(f"inverter {serial} not found")
        return 1
    if sys.argv[2] == "backup":
        return set_backup_soc(bus, uid, sys.argv[3])
    watts = float(sys.argv[2])
    deadband = int(sys.argv[3]) if len(sys.argv) > 3 else DEADBAND
    rated = bus.read_u32(uid, 37048)  # [ESS] maximum discharge power (RO); 47077 rejects more
    if not rated:
        print(f"unit {uid} rated discharge power unreadable")
        return 1
    target = target_for(watts, rated)
    current = bus.read_u32(uid, 47077)
    if needs_write(current, target, rated, deadband):
        if not bus.write_u32(uid, 47077, target):
            print(f"unit {uid} write {target} rejected (was {current})")
            return 1
        after = bus.read_u32(uid, 47077)
        if after != target:
            print(f"unit {uid} wrote {target}, reads {after}")
            return 1
        print(f"unit {uid} limit {target} (was {current})")
        return 0
    print(f"unit {uid} limit {current} (target {target}, within deadband)")
    return 0


def selftest():
    assert target_for(-50, 2500) == 0 and target_for(9000, 2500) == 2500
    assert needs_write(None, 800, 2500)
    assert needs_write(0, 2500, 2500) and not needs_write(2500, 2500, 2500)
    assert needs_write(100, 0, 2500)
    assert not needs_write(800, 900, 2500) and needs_write(800, 1000, 2500)
    assert needs_write(800, 900, 2500, 50) and not needs_write(800, 1000, 2500, 300)
    assert backup_target(100) == 1000 and backup_target(0) == 0
    assert backup_target(150) == 1000 and backup_target(-5) == 0 and backup_target("20.0") == 200
    assert grid_state(None) is None and grid_state(22080) == "up"
    assert grid_state(0) == "outage" and grid_state(9999) == "outage" and grid_state(10000) == "up"
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
    elif sys.argv[1:] == ["--grid"]:
        sys.exit(grid_status())
    else:
        sys.exit(main())
