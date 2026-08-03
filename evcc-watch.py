#!/usr/bin/env python3
"""evcc-watch — watches the devices evcc depends on.

Two targets, each with the check that actually means something:

  meter    ICMP plus a TCP connect to the Modbus port. A meter on Wi-Fi can
           drop off the LAN for hours at a time. While it is gone evcc blocks
           on the dial, the device /status endpoint goes from ~0.04 s to
           several seconds, and the web UI reports "Network Error" because the
           browser gives up before the answer arrives.

  wallbox  presence of an established OCPP session. The wallbox is the one
           dialling evcc, so pinging it proves nothing — what counts is
           whether the socket is there. Wallboxes drop it on their own
           ("cannot write to closed connection") and usually, but not always,
           come back without help.

Logs only what matters to the journal: state changes and how long each
outage lasted. While everything is fine it stays quiet.

    journalctl -t evcc-watch -o cat             # everything
    journalctl -t evcc-watch -p warning -o cat  # outages only

Optional safety net (off unless OCPP_RESTART_AFTER is set): restart evcc when
the OCPP session has been missing for that long. evcc-io/evcc#27203 documents
that the connection sometimes only recovers after a restart. Two guards keep
it from doing harm:

  * it only fires while the wallbox still answers ICMP. No ping means the box
    is off or off-network, restarting evcc would not bring it back, and we
    would just be restarting a working service in a loop.
  * at most OCPP_MAX_RESTARTS per outage, then it goes quiet and keeps warning.

Standard library only. No log files to rotate — journald handles that.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time

EMMA_HOST = os.environ.get("EMMA_HOST", "")      # unset: the meter is not watched
EMMA_PORT = int(os.environ.get("EMMA_PORT", "502"))
OCPP_PORT = int(os.environ.get("OCPP_PORT", "8887"))
STATE = os.environ.get("EVCC_WATCH_STATE", "/var/lib/evcc-watch/state.json")

# safety net: 0 disables it (the default)
RESTART_AFTER = int(os.environ.get("OCPP_RESTART_AFTER", "0"))
MAX_RESTARTS = int(os.environ.get("OCPP_MAX_RESTARTS", "3"))
EVCC_SERVICE = os.environ.get("EVCC_SERVICE", "evcc")
OCPP_TARGET = "OCPP wallbox"

# syslog priority prefixes systemd understands on stdout
INFO, NOTICE, WARN = "<6>", "<5>", "<4>"
REMINDER = 900          # repeat the warning every 15 min while it lasts


def ping(host: str) -> float | None:
    """Average round-trip time in ms, or None if there is no answer.

    Taken from the ping summary — timing the process would also count the
    interval between packets.
    """
    r = subprocess.run(["ping", "-c", "2", "-i", "0.3", "-W", "2", "-q", host],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    m = re.search(r"=\s*[\d.]+/([\d.]+)/", r.stdout)   # min/avg/max/mdev
    return float(m.group(1)) if m else 0.0


def tcp(host: str, port: int) -> float | None:
    """Connect time in ms, or None if the connection fails."""
    t0 = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=3):
            return (time.monotonic() - t0) * 1000
    except OSError:
        return None


def ocpp_peer(port: int) -> str | None:
    """IP on the other end of the OCPP session, or None if there is none.

    Raises FileNotFoundError where `ss` does not exist (macOS, say) — that is
    not the same as the wallbox being down, so the caller has to tell them apart.
    """
    r = subprocess.run(
        ["ss", "-Htn", "state", "established", "( sport = :%d )" % port],
        capture_output=True, text=True)
    for line in r.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 2:
            # the peer shows up as [::ffff:192.0.2.52]:42446 (mapped IPv4)
            # or as 192.0.2.52:42446 — the ']' has to be optional
            m = re.search(r"(\d+\.\d+\.\d+\.\d+)\]?:\d+$", fields[-1])
            if m:
                return m.group(1)
    return None


def check_emma() -> tuple[bool | None, str]:
    icmp = ping(EMMA_HOST)
    port = tcp(EMMA_HOST, EMMA_PORT) if icmp is not None else None
    if port is not None:
        return True, "icmp %.0fms, tcp/%d %.0fms" % (icmp, EMMA_PORT, port)
    return False, "icmp %s, tcp/%d refused" % (
        "answers" if icmp is not None else "no answer", EMMA_PORT)


LAST_PEER = None        # set by check_ocpp, used by the safety net


def check_ocpp() -> tuple[bool | None, str]:
    """None means "cannot tell" — never report a drop we did not observe."""
    global LAST_PEER
    try:
        peer = ocpp_peer(OCPP_PORT)
    except FileNotFoundError:
        return None, "'ss' not available, cannot inspect sockets"
    if peer:
        LAST_PEER = peer
        return True, "session from %s" % peer
    return False, "no established session on %d" % OCPP_PORT


def safety_net(entry: dict, now: float, dry_run: bool) -> dict:
    """Restart evcc when the OCPP session has been gone long enough.

    Returns the fields to merge into the target's state. Deliberately timid:
    see the guards described at the top of the file.
    """
    down_for = now - entry["since"]
    restarts = entry.get("restarts", 0)
    last_restart = entry.get("last_restart", 0)

    if not RESTART_AFTER or entry["up"] or down_for < RESTART_AFTER:
        return {}
    if now - last_restart < RESTART_AFTER:      # give the last one time to work
        return {}
    if restarts >= MAX_RESTARTS:
        if now - last_restart >= REMINDER:
            print("%s%s: still down after %s and already restarted %s %d times "
                  "— not restarting again, this needs a look"
                  % (WARN, OCPP_TARGET, human(down_for), EVCC_SERVICE, restarts),
                  flush=True)
            return {"last_restart": now}
        return {}

    host = entry.get("peer") or LAST_PEER
    if not host:
        return {}                                # never saw it, nothing to ping
    if ping(host) is None:
        # the box is off or off the network: restarting evcc would not help
        print("%s%s: down for %s but %s does not answer ICMP — the wallbox is "
              "away, not evcc. Not restarting."
              % (INFO, OCPP_TARGET, human(down_for), host), flush=True)
        return {}

    print("%s%s: down for %s while %s still answers ICMP — restarting %s "
          "(attempt %d/%d)%s"
          % (WARN, OCPP_TARGET, human(down_for), host, EVCC_SERVICE,
             restarts + 1, MAX_RESTARTS, " [dry-run]" if dry_run else ""),
          flush=True)
    if dry_run:
        return {}
    rc = subprocess.run(["systemctl", "restart", EVCC_SERVICE],
                        check=False).returncode
    if rc != 0:
        print("%s%s: 'systemctl restart %s' exited %d"
              % (WARN, OCPP_TARGET, EVCC_SERVICE, rc), flush=True)
    return {"restarts": restarts + 1, "last_restart": now}


TARGETS = {OCPP_TARGET: check_ocpp}
if EMMA_HOST:
    TARGETS["EMMA (%s)" % EMMA_HOST] = check_emma


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE)


def human(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return "%dh%02dm" % (h, m)
    if m:
        return "%dm%02ds" % (m, s)
    return "%ds" % s


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv
    if not EMMA_HOST:
        print("%sEMMA_HOST is not set — only the OCPP session is watched" % INFO,
              flush=True)
    previous = load_state()
    now = time.time()
    current = {}

    for name, check in TARGETS.items():
        up, detail = check()
        was = previous.get(name, {})
        if up is None:
            # Unknown: carry the whole previous entry forward, only marking it
            # unknown. Rebuilding it from scratch would drop `peer` and the
            # restart budget, so one unreadable run mid-outage would let the
            # safety net start over and exceed OCPP_MAX_RESTARTS.
            if was.get("up") is not None or name not in previous:
                print("%s%s: %s" % (INFO, name, detail), flush=True)
            entry = dict(was)
            entry.update(up=None, detail=detail, since=was.get("since", now),
                         last_warning=was.get("last_warning", 0))
            current[name] = entry
            continue
        before = was.get("up")
        since = was.get("since", now)
        last_warning = was.get("last_warning", 0)
        msg = None

        if before is None:                              # first run
            msg = "%s%s: now watching — %s (%s)" % (
                INFO, name, "up" if up else "DOWN", detail)
            since = now
        elif up != before:                              # state change
            lasted = human(now - since)
            if up:
                msg = "%s%s: BACK after %s down (%s)" % (NOTICE, name, lasted, detail)
            else:
                msg = "%s%s: DOWN (was up for %s) — %s" % (WARN, name, lasted, detail)
            since = now
        elif not up and now - last_warning >= REMINDER:  # still down
            msg = "%s%s: still down after %s — %s" % (
                WARN, name, human(now - since), detail)

        if msg:
            print(msg, flush=True)
            last_warning = now

        entry = {"up": up, "since": since,
                 "last_warning": last_warning, "detail": detail}
        if name == OCPP_TARGET:
            # a successful session resets the restart budget
            entry["peer"] = LAST_PEER or was.get("peer")
            entry["restarts"] = 0 if up else was.get("restarts", 0)
            entry["last_restart"] = 0 if up else was.get("last_restart", 0)
            entry.update(safety_net(entry, now, dry_run))
        current[name] = entry

    if not dry_run:          # a dry run must not mutate anything, state included
        save_state(current)
    # always exit 0: a device going down is not a failure of this service
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
