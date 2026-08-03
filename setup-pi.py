#!/usr/bin/env python3
"""setup-pi — post-install configuration of the evcc image on a Raspberry Pi.

Sections, in the order they run:

    system     Package upgrade, timezone and pre-flight checks
    pihole     Installs Pi-hole (v6), web port, password and blocklists
    caddy      Reverse proxy (evcc/pi-hole/cockpit) + Cockpit origins
    dns        Local DNS records in Pi-hole (LAN and over Tailscale)
    tailscale  Installs and connects Tailscale (subnet router) for remote access
    wifi       Disables WiFi and Bluetooth permanently
    evcc       Wallbox Pulsar Plus (OCPP) + Huawei EMMA + Peugeot e-208
    hostname   Renames the Pi (may drop the SSH session — hence it goes last)
    summary    Prints the summary and the next steps

Usage (on the Pi, preferably inside tmux/screen):

    sudo python3 setup-pi.py                # everything, in the order above
    sudo python3 setup-pi.py dns            # a single section
    sudo python3 setup-pi.py caddy dns      # several, in the given order
    python3 setup-pi.py --list              # list the sections
    sudo python3 setup-pi.py --dry-run      # show what it would do, do nothing

Installation-specific values (hostname, IPs, VIN, email) come from the .env
next to this file — see .env.example. Nothing here holds personal data.

Standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import shlex
import shutil
import string
import subprocess
import sys
import urllib.request
from datetime import datetime

INFO, OK, ERR = "[i]", "[+]", "[!]"

SECTIONS = ["system", "pihole", "caddy", "dns", "tailscale", "wifi",
            "evcc", "hostname", "summary"]

DEFAULTS = {
    "NEW_HOSTNAME": "raspberrypi",
    "TIMEZONE": "Europe/Lisbon",          # the evcc image ships Europe/Berlin
    "PIHOLE_WEB_PORT_HTTP": "8080",
    "PIHOLE_WEB_PORT_HTTPS": "8443",
    "PIHOLE_DNS_1": "1.1.1.1",
    "PIHOLE_DNS_2": "1.0.0.1",
    "PIHOLE_PASSWORD": "",                # empty = generate a random one
    "CADDY_EMAIL": "admin@example.com",
    "LOCAL_DOMAIN": "home.arpa",          # RFC 8375
    "TS_AUTHKEY": "",
    "EVCC_SPONSOR_TOKEN": "",
    "WALLBOX_STATION_ID": "",
    "EMMA_HOST": "",
    "BATTERY_CAPACITY": "5",
    "EV_USER": "",
    "EV_VIN": "",
    "TARIFF_OFF_PEAK": "0.14",
    "TARIFF_PEAK": "0.22",
    # Measured on a Huawei EMMA: the grid reading swings ~55 W peak-to-peak
    # with the house idle. The 100 W the web UI suggests sits inside that
    # noise band, so part of the corrections would be chasing the meter
    # rather than the house. 150-200 W stays clear of it.
    "RESIDUAL_POWER": "150",
}

GRAVITY_DB = "/etc/pihole/gravity.db"

# Seeded only when there is no list at all — see sec_pihole. Pi-hole's own
# unattended installer already seeds StevenBlack on a first install, so in
# practice this matters for the HaGeZi one.
ADLISTS = [
    ("https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
     "StevenBlack unified hosts"),
    ("https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/pro.txt",
     "HaGeZi Multi PRO"),
]

# How long Caddy's internal CA should make its leaf certificates last. The
# default is 12h, and since a browser exception is pinned to one certificate,
# that means a new warning twice a day. See sec_caddy.
CERT_LIFETIME_HOURS = 8760          # one year
CADDY_CERT_STORE = "/var/lib/caddy/.local/share/caddy/certificates"

# apt without interactive prompts (keeps existing configuration files)
APT_OPTS = ["-o", "Dpkg::Options::=--force-confdef",
            "-o", "Dpkg::Options::=--force-confold"]


class Failed(Exception):
    """Expected error: exit with a message, no traceback."""


# ------------------------------------------------------------------ context
class Ctx:
    """Configuration and helpers shared by the sections."""

    def __init__(self, dry_run: bool):
        self.dry = dry_run
        self.cfg = dict(DEFAULTS)
        self._load_env()
        self.password_generated = False
        self.pihole_password = self.cfg["PIHOLE_PASSWORD"]

        self.ip = self._local_ip()
        self.subnet = self._subnet()

        d = self.cfg["LOCAL_DOMAIN"]
        self.evcc_host = f"evcc.{d}"
        self.pihole_host = f"pi-hole.{d}"
        self.cockpit_host = f"cockpit.{d}"

    # -- configuration ------------------------------------------------------
    def _load_env(self) -> None:
        path = os.environ.get(
            "ENV_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    try:
                        parts = shlex.split(line, comments=True)
                    except ValueError:
                        continue
                    if not parts or "=" not in parts[0]:
                        continue
                    key, _, value = " ".join(parts).partition("=")
                    self.cfg[key.strip()] = value
            info(f"configuration read from {path}")
        # the environment wins over the file (EV_VIN=… sudo -E python3 setup-pi.py)
        for key in self.cfg:
            if os.environ.get(key):
                self.cfg[key] = os.environ[key]

    def __getitem__(self, key: str) -> str:
        return self.cfg.get(key, "")

    # -- network ------------------------------------------------------------
    def _default_route(self) -> str:
        try:
            return self.run(["ip", "-4", "route", "get", "1.1.1.1"],
                            capture=True, always=True).stdout
        except Exception:
            return ""

    def _local_ip(self) -> str:
        m = re.search(r"src (\S+)", self._default_route())
        if m:
            return m.group(1)
        out = self.run(["hostname", "-I"], capture=True, always=True).stdout
        return out.split()[0] if out.split() else ""

    def _subnet(self) -> str:
        """Home subnet, read from the interface — not assumed.

        Assuming /24 when the network is a /22 (a Tapo mesh, for instance)
        leaves half the addresses unreachable over Tailscale.
        """
        m = re.search(r"dev (\S+)", self._default_route())
        iface = m.group(1) if m else "lo"
        out = self.run(["ip", "-4", "route", "show", "dev", iface,
                        "scope", "link", "proto", "kernel"],
                       capture=True, always=True, check=False).stdout
        for line in out.splitlines():
            if line.split():
                return line.split()[0]
        # fallback: the old guess
        return ".".join(self.ip.split(".")[:3]) + ".0/24" if self.ip else ""

    # -- execution ----------------------------------------------------------
    def run(self, cmd: list[str], *, capture: bool = False, check: bool = True,
            stdin: str | None = None, always: bool = False, quiet: bool = False,
            ) -> subprocess.CompletedProcess:
        """Runs a command. Under --dry-run it only prints it (unless `always`).

        Output is streamed to the terminal by default: the apt upgrade and the
        gravity rebuild take minutes on a Pi 3, and silence there is
        indistinguishable from a hang. `capture` keeps it for the caller to
        parse instead, `quiet` throws it away.
        """
        if self.dry and not always:
            print(f"    $ {shlex.join(cmd)}")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        r = subprocess.run(cmd, capture_output=capture or quiet,
                           text=True, input=stdin)
        if check and r.returncode != 0:
            detail = (r.stderr or r.stdout or "").strip()
            raise Failed(f"failed: {shlex.join(cmd)}\n    "
                         + (detail[:400] if detail else "see the output above"))
        return r

    def write(self, path: str, content: str, mode: int = 0o644) -> None:
        if self.dry:
            print(f"    -> would write {path} ({len(content.splitlines())} lines)")
            return
        os.makedirs(os.path.dirname(path) or "/", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(tmp, mode)
        os.replace(tmp, path)

    def download(self, url: str, dest: str) -> None:
        if self.dry:
            print(f"    -> would download {url} to {dest}")
            return
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as fh:
            shutil.copyfileobj(r, fh)


def info(msg: str) -> None:
    print(f"{INFO} {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"{OK} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{ERR} {msg}", file=sys.stderr, flush=True)


def have(program: str) -> bool:
    return shutil.which(program) is not None


# ----------------------------------------------------------------- sections
def sec_system(c: Ctx) -> None:
    info(f"this Pi's IP: {c.ip}")

    info("checking port 53...")
    listening = c.run(["ss", "-tulnp"], capture=True, always=True, check=False).stdout
    busy = [l for l in listening.splitlines() if ":53 " in l]
    text = "\n".join(busy)
    if not busy:
        ok("port 53 free (the installer deals with systemd-resolved, if present)")
    elif any(x in text for x in ("systemd-resolve", "pihole-FTL")):
        ok("port 53 held by the expected service (systemd-resolved or pihole-FTL)")
    elif "users:(" not in text:
        # without root, ss does not show the process — no way to judge
        warn("port 53 is busy, but without root I cannot see by whom.\n"
             "    Check with: sudo ss -tulnp | grep ':53 '")
    else:
        raise Failed("port 53 is held by another service:\n    "
                     + "\n    ".join(busy)
                     + "\n    Free the port before continuing.")

    # Timezone: critical for the tariff zones and charge plans
    current = c.run(["timedatectl", "show", "-p", "Timezone", "--value"],
                    capture=True, always=True, check=False).stdout.strip()
    if current != c["TIMEZONE"]:
        c.run(["timedatectl", "set-timezone", c["TIMEZONE"]])
        ok(f"timezone set: {c['TIMEZONE']}")

    info("upgrading system packages (this can take a few minutes)...")
    c.run(["apt-get", "update", "-qq"])
    c.run(["apt-get", "upgrade", "-y", "-q", *APT_OPTS])
    c.run(["apt-get", "install", "-y", "-qq", "curl", "git"])
    ok("system upgraded")


def sec_pihole(c: Ctx) -> None:
    ports = f"{c['PIHOLE_WEB_PORT_HTTP']}o,{c['PIHOLE_WEB_PORT_HTTPS']}os"

    # With /etc/pihole/pihole.toml in place the installer accepts --unattended
    # and shows no dialogs.
    if not os.path.exists("/etc/pihole/pihole.toml"):
        info("pre-configuring Pi-hole...")
        c.write("/etc/pihole/pihole.toml", f"""[dns]
  upstreams = [ "{c['PIHOLE_DNS_1']}", "{c['PIHOLE_DNS_2']}" ]
  # ALL: also answers on the Tailscale interface (100.x), not just the LAN
  listeningMode = "ALL"

[webserver]
  # o = optional port, s = SSL. 80/443 are taken by evcc.
  port = "{ports}"
""")
        ok(f"/etc/pihole/pihole.toml created (web ports: {ports})")
    else:
        ok("/etc/pihole/pihole.toml already exists, keeping it")

    if have("pihole"):
        ok("Pi-hole already installed, skipping the installer")
    else:
        info("downloading and running the Pi-hole installer (no dialogs)...")
        c.download("https://install.pi-hole.net", "/tmp/pihole-install.sh")
        c.run(["bash", "/tmp/pihole-install.sh", "--unattended"])
        if not c.dry:
            os.remove("/tmp/pihole-install.sh")
        ok("Pi-hole installed")

    # Enforce the web ports at runtime; otherwise FTL grabs port 80 and Caddy
    # will not start.
    current = c.run(["pihole-FTL", "--config", "webserver.port"],
                    capture=True, always=True, check=False).stdout.strip()
    if current != ports:
        c.run(["pihole-FTL", "--config", "webserver.port", ports])
        c.run(["systemctl", "restart", "pihole-FTL"])
        ok(f"Pi-hole web ports: {c['PIHOLE_WEB_PORT_HTTP']}/{c['PIHOLE_WEB_PORT_HTTPS']}")

    if not c.pihole_password and os.path.exists("/etc/pihole/.setup-pi-pw"):
        ok("password already set on a previous run, keeping it")
    else:
        if not c.pihole_password:
            alphabet = string.ascii_letters + string.digits
            c.pihole_password = "".join(secrets.choice(alphabet) for _ in range(16))
            c.password_generated = True
        c.run(["pihole", "setpassword", c.pihole_password], quiet=True)
        if not c.dry:
            open("/etc/pihole/.setup-pi-pw", "a").close()
        ok("web interface password set")
        if c.password_generated:
            info(f"Pi-hole password (generated): {c.pihole_password} <- save it now")

    # Blocklists are seeded only when there is none at all, i.e. on a fresh
    # install. Asserting them on every run would silently undo whatever was
    # chosen in the web UI — re-enabling a list disabled there on purpose.
    existing = c.run(["pihole-FTL", "sqlite3", GRAVITY_DB,
                      "select count(*) from adlist;"],
                     capture=True, always=True, check=False).stdout.strip()
    if existing.isdigit() and int(existing) > 0:
        ok(f"{existing} blocklist(s) already configured, leaving them to the web UI")
        return

    for url, comment in ADLISTS:
        c.run(["pihole-FTL", "sqlite3", GRAVITY_DB,
               "INSERT INTO adlist (address, enabled, comment) "
               f"VALUES ('{url}', 1, '{comment}') "
               "ON CONFLICT(address) DO UPDATE SET enabled = 1;"])
        ok(f"blocklist seeded: {comment}")

    # only after seeding: rebuilding gravity takes minutes on a Pi 3, and
    # Pi-hole refreshes it on its own schedule anyway
    info("building the blocking database (gravity)...")
    c.run(["pihole", "-g"])
    ok("gravity updated")


def sec_caddy(c: Ctx) -> None:
    if os.path.exists("/etc/caddy/Caddyfile") and not os.path.exists(
            "/etc/caddy/Caddyfile.backup"):
        if not c.dry:
            shutil.copy2("/etc/caddy/Caddyfile", "/etc/caddy/Caddyfile.backup")
        ok("original Caddyfile saved as /etc/caddy/Caddyfile.backup")

    info("writing /etc/caddy/Caddyfile...")
    c.write("/etc/caddy/Caddyfile", f"""{{
  email {c['CADDY_EMAIL']}
  auto_https disable_redirects
  skip_install_trust
}}

# Redirect every HTTP request to HTTPS
http:// {{
  redir https://{{host}}{{uri}} permanent
}}

(common) {{
  # Caddy issues 12h leaf certificates by default, and a browser exception is
  # pinned to one certificate — so every rotation brings the warning back.
  # sign_with_root is required: without it the leaf is capped by the
  # intermediate's lifetime (measured: 7 days, whatever is asked for here).
  tls {{
    issuer internal {{
      lifetime {CERT_LIFETIME_HOURS}h
      sign_with_root
    }}
  }}
  encode zstd gzip
  log
}}

# evcc
{c.evcc_host} {{
  import common
  reverse_proxy 127.0.0.1:7070 {{
    header_up Host {{host}}
    header_up X-Real-IP {{remote}}
    header_up X-Forwarded-For {{remote}}
    header_up X-Forwarded-Proto {{scheme}}
  }}
}}

# Pi-hole
{c.pihole_host} {{
  import common
  redir / /admin/ permanent
  reverse_proxy 127.0.0.1:{c['PIHOLE_WEB_PORT_HTTP']}
}}

# Cockpit
{c.cockpit_host} {{
  import common
  reverse_proxy https://127.0.0.1:9090 {{
    transport http {{
      tls_insecure_skip_verify
    }}
  }}
}}

# OCPP: no proxy; the wallbox dials evcc directly (ws://<ip>:8887)
""")

    # Cockpit behind a proxy: once "Origins" is set it REJECTS any origin
    # outside the list — so it has to include direct access by IP and by mDNS
    # too, otherwise login fails on those addresses.
    host = c["NEW_HOSTNAME"]
    origins = " ".join([
        f"https://{c.cockpit_host}", f"wss://{c.cockpit_host}",
        "https://localhost:9090",
        f"https://{host}.local:9090", f"wss://{host}.local:9090",
        f"https://{c.ip}:9090", f"wss://{c.ip}:9090",
    ])
    conf = "/etc/cockpit/cockpit.conf"
    lines = []
    if os.path.exists(conf):
        with open(conf, encoding="utf-8") as fh:
            lines = [l.rstrip("\n") for l in fh if not l.startswith("Origins = ")]
    if not any(l.strip() == "[WebService]" for l in lines):
        lines.insert(0, "[WebService]")
    out = []
    for line in lines:
        out.append(line)
        if line.strip() == "[WebService]":
            out.append(f"Origins = {origins}")
    out = [re.sub(r"^LoginTitle = .*", f"LoginTitle = {host}", l) for l in out]
    c.write(conf, "\n".join(out) + "\n")
    c.run(["systemctl", "try-restart", "cockpit.service"], check=False)
    ok("Cockpit: origins allowed (proxy, IP and mDNS)")

    info("validating and reloading Caddy...")
    c.run(["caddy", "validate", "--config", "/etc/caddy/Caddyfile"])

    # The image's WiFi portal (comitup-web) sits on port 80, which Caddy needs
    # for the HTTP->HTTPS redirect. It is useless once the network is set up.
    c.run(["systemctl", "disable", "--now",
           "comitup-web.service", "comitup.service"], check=False)

    conflicts = [l for l in c.run(["ss", "-tlnp"], capture=True, always=True,
                                  check=False).stdout.splitlines()
                 if re.search(r":(80|443)\s", l) and "caddy" not in l]
    if conflicts:
        raise Failed("ports 80/443 are held by another process:\n    "
                     + "\n    ".join(conflicts))

    if c.run(["systemctl", "restart", "caddy"], check=False).returncode != 0:
        journal = c.run(["journalctl", "-u", "caddy", "--no-pager", "-n", "20"],
                        capture=True, always=True, check=False).stdout
        raise Failed("Caddy did not start; last lines of the log:\n" + journal)
    refresh_stale_certs(c)
    ok("Caddy configured")


def leaf_validity_days(c: Ctx, path: str) -> float | None:
    """Total validity span of a certificate, in days."""
    out = c.run(["openssl", "x509", "-in", path, "-noout", "-dates"],
                capture=True, always=True, check=False).stdout
    dates = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if key in ("notBefore", "notAfter"):
            try:
                dates[key] = datetime.strptime(value.strip(), "%b %d %H:%M:%S %Y %Z")
            except ValueError:
                return None
    if len(dates) != 2:
        return None
    return (dates["notAfter"] - dates["notBefore"]).total_seconds() / 86400


def refresh_stale_certs(c: Ctx) -> None:
    """Reissue certificates that predate the current lifetime policy.

    Writing the Caddyfile is not enough: Caddy keeps serving whatever is
    already in its storage, so a freshly configured year-long lifetime does
    nothing until the old 12h certificates are gone.

    Only the stale ones are touched. Wiping the store on every run would mint
    new certificates each time — and a new browser warning with them, which is
    the very thing the long lifetime is meant to stop.
    """
    wanted = CERT_LIFETIME_HOURS / 24.0
    if not os.path.isdir(CADDY_CERT_STORE):
        return

    stale = []
    for root, _, files in os.walk(CADDY_CERT_STORE):
        for name in files:
            if not name.endswith(".crt"):
                continue
            span = leaf_validity_days(c, os.path.join(root, name))
            # 10% of slack: Caddy's own rounding, not a policy change
            if span is not None and span < wanted * 0.9:
                stale.append((name, span))

    if not stale:
        ok(f"certificates already issued for ~{wanted:.0f} days, leaving them alone")
        return

    for name, span in stale:
        info(f"{name} is only valid for {span:.1f} days, policy asks for {wanted:.0f}")

    backup = f"/var/backups/caddy-certs/{datetime.now():%Y%m%d-%H%M%S}"
    if c.dry:
        print(f"    -> would back up {CADDY_CERT_STORE} to {backup} and remove it")
        print("    $ systemctl restart caddy")
        return
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    shutil.copytree(CADDY_CERT_STORE, backup)
    shutil.rmtree(CADDY_CERT_STORE)
    c.run(["systemctl", "restart", "caddy"], check=False)
    ok(f"certificates cleared and reissued (old ones kept in {backup})")


def sec_dns(c: Ctx) -> None:
    # The .home.arpa names are resolved by Pi-hole itself, both on the LAN
    # (via the router's DHCP) and remotely (via Tailscale split DNS).
    info(f"creating local DNS records (pointing at {c.ip})...")
    records = ", ".join(f'"{c.ip} {name}"' for name in (
        c.evcc_host, c.pihole_host, c.cockpit_host,
        f"{c['NEW_HOSTNAME']}.{c['LOCAL_DOMAIN']}"))
    c.run(["pihole-FTL", "--config", "dns.hosts", f"[{records}]"])
    c.run(["pihole", "reloaddns"], check=False)
    ok(f"DNS records created: {c.evcc_host}, {c.pihole_host}, {c.cockpit_host}")


def sec_tailscale(c: Ctx) -> None:
    if not have("tailscale"):
        info("installing Tailscale...")
        c.download("https://tailscale.com/install.sh", "/tmp/tailscale-install.sh")
        c.run(["sh", "/tmp/tailscale-install.sh"])
        if not c.dry:
            os.remove("/tmp/tailscale-install.sh")
    c.run(["systemctl", "enable", "--now", "tailscaled"], check=False)

    # Packet forwarding (needed to advertise the home network)
    c.write("/etc/sysctl.d/99-tailscale.conf",
            "net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n")
    c.run(["sysctl", "-p", "/etc/sysctl.d/99-tailscale.conf"], check=False)

    # --accept-dns=false: the Pi IS the DNS server; MagicDNS would loop
    # --advertise-routes: makes the LAN reachable from the tailnet
    authenticated = c.run(["tailscale", "status"], capture=True, always=True,
                          check=False).returncode == 0
    if authenticated:
        c.run(["tailscale", "set", "--accept-dns=false",
               f"--advertise-routes={c.subnet}"])
        ok(f"Tailscale already authenticated; advertising {c.subnet}")
    else:
        info("connecting to Tailscale (follow the login URL, if one shows up)...")
        cmd = ["tailscale", "up", "--accept-dns=false",
               f"--advertise-routes={c.subnet}"]
        if c["TS_AUTHKEY"]:
            cmd += ["--authkey", c["TS_AUTHKEY"]]
        c.run(cmd)
    ip = tailscale_ip(c)
    ok("Tailscale up" + (f" (IP: {ip})" if ip else ""))


def tailscale_ip(c: Ctx) -> str:
    out = c.run(["tailscale", "ip", "-4"], capture=True, always=True,
                check=False).stdout.splitlines()
    return out[0].strip() if out else ""


def sec_wifi(c: Ctx) -> None:
    # Safety: if the current link is WiFi, skip entirely — otherwise this
    # would cut access to the Pi (right away via rfkill, and after a reboot
    # via the overlay).
    if "dev wl" in c._default_route():
        warn("the current link is WiFi; skipping the WiFi/BT shutdown.")
        warn("    Plug the Pi into ethernet and run the script again.")
        return

    info("disabling WiFi and Bluetooth...")
    boot = "/boot/firmware/config.txt"
    if os.path.exists(boot):
        if c.dry:
            print(f"    -> would append dtoverlay=disable-wifi/bt to {boot}")
        else:
            with open(boot, encoding="utf-8") as fh:
                text = fh.read()
            with open(boot, "a", encoding="utf-8") as fh:
                for overlay in ("disable-wifi", "disable-bt"):
                    if f"dtoverlay={overlay}" not in text:
                        fh.write(f"dtoverlay={overlay}\n")
    for rf in ("wifi", "bluetooth"):
        c.run(["rfkill", "block", rf], check=False)
    # bluetooth, the BT UART, the image's WiFi setup hotspot and
    # unblock-rfkill (from comitup, which would unblock WiFi at boot)
    for svc in ("bluetooth", "hciuart", "comitup", "comitup-web",
                "evcc-wifi-setup", "unblock-rfkill"):
        c.run(["systemctl", "disable", "--now", f"{svc}.service"], check=False)
    c.run(["systemctl", "mask", "comitup.service", "unblock-rfkill.service"],
          check=False)
    # the Cockpit "WiFi manager" menu is useless without WiFi and only errors
    c.run(["apt-get", "purge", "-y", "-qq", "cockpit-wifimanager"], check=False)
    ok("WiFi and Bluetooth disabled (hardware goes away on the next boot)")


def evcc_yaml(c: Ctx, access: str, refresh: str) -> str:
    sponsor = (f"sponsortoken: {c['EVCC_SPONSOR_TOKEN']}"
               if c["EVCC_SPONSOR_TOKEN"] else "# sponsortoken: FILL-IN-SPONSOR-TOKEN")
    emma = c["EMMA_HOST"] or "FILL-IN-EMMA-IP"
    return f"""network:
  # mDNS name (.local): used in the zeroconf announcement the app discovers.
  # Do NOT put the .home.arpa name here: evcc appends ".local" to the
  # announcement and would build the invalid hybrid "evcc.home.arpa.local".
  host: {c['NEW_HOSTNAME']}.local
  port: 7070
  # address for other devices and for the app (via Caddy/Pi-hole/Tailscale)
  externalUrl: https://{c.evcc_host}

interval: 30s

# Required for the Wallbox Pulsar Plus (free trial: https://sponsor.evcc.io)
# Note: the line stays commented out when empty; an invalid value stops evcc
# from starting.
{sponsor}

chargers:
  - name: pulsar_plus
    type: template
    template: ocpp-wallbox
    stationid: {c['WALLBOX_STATION_ID'] or 'FILL-IN-STATION-ID'}
    # the Pulsar Plus does not start transactions locally (no RFID/autostart);
    # evcc starts them remotely when the car is plugged in (needed for the e-208)
    remotestart: true
    # Without this: "charger out of sync: expected disabled, got enabled" every
    # 90 s. With the car unplugged (state A) evcc cannot decide from the status
    # and falls through to the Current.Offered measurand; the Pulsar reports a
    # non-zero value there even with the charging profile at 0 A, so evcc reads
    # "enabled". With both "offered" measurands removed, Enabled() uses the
    # profile's schedule limit, which is what evcc itself set.
    # This is exactly what the wallbox-fw5 template does.
    metervalues: -Current.Offered,Power.Offered

# The EMMA accepts a SINGLE Modbus TCP client at a time: a second one is reset
# with "connection reset by peer" while the first keeps working. Do not point
# Home Assistant or any other integration at port 502 as well — one of them
# will simply lose, intermittently and without an obvious cause.
meters:
  - name: grid
    type: template
    template: huawei-emma
    usage: grid
    modbus: tcpip
    host: {emma}
    port: 502
  - name: pv
    type: template
    template: huawei-emma
    usage: pv
    modbus: tcpip
    host: {emma}
    port: 502
  - name: battery
    type: template
    template: huawei-emma
    usage: battery
    modbus: tcpip
    host: {emma}
    port: 502
    capacity: {c['BATTERY_CAPACITY']} # kWh

vehicles:
  - name: e208
    type: template
    template: peugeot
    title: Peugeot e-208
    capacity: 46 # usable kWh (adjust for the 51 kWh version)
    user: {c['EV_USER'] or 'FILL-IN-MYPEUGEOT-EMAIL'}
    vin: {c['EV_VIN'] or 'FILL-IN-VIN'}
    # Automatic renewal: sudo evcc-psa-token renew
    accessToken: {access or 'FILL-IN-ACCESS-TOKEN'}
    refreshToken: {refresh or 'FILL-IN-REFRESH-TOKEN'}

loadpoints:
  - title: Garage
    charger: pulsar_plus
    vehicle: e208 # default vehicle when something is plugged into the wallbox
    mode: pv

# Two-rate tariff, daily cycle. Indexed to OMIE: these are indicative averages,
# to be refreshed from the bill every now and then.
tariffs:
  currency: EUR
  grid:
    type: fixed
    price: {c['TARIFF_PEAK']} # peak (incl. VAT and levies)
    zones:
      - hours: 0-8,22-0
        price: {c['TARIFF_OFF_PEAK']} # off-peak, daily cycle 22:00-08:00 (Lisbon)

site:
  title: Home
  meters:
    grid: grid
    pv:
      - pv
    battery:
      - battery
  # Shifts the operating point towards slight grid export, giving the battery
  # regulation room to see surplus and absorbing meter noise (measured: ~55 W
  # peak-to-peak on a Huawei EMMA, which is why the 100 W suggested in the
  # web UI is too low there).
  # NOTE: whatever is set in the web UI is stored in evcc's database and
  # OVERRIDES this line. Check with:
  #   sqlite3 /var/lib/evcc/evcc.db "select value from settings where key='residualPower'"
  residualPower: {c['RESIDUAL_POWER']}
# Battery notes (runtime settings, NOT valid in this file):
# - Battery priority (25%): set it in the web UI, Configuration > Battery
# - With no "buffer" set, the house battery never charges the car
# - Physical limits 25%-95%: set in FusionSolar
"""


def sec_evcc(c: Ctx) -> None:
    if os.path.exists("/etc/evcc.yaml") and not os.path.exists("/etc/evcc.yaml.backup"):
        if not c.dry:
            shutil.copy2("/etc/evcc.yaml", "/etc/evcc.yaml.backup")

    # On a re-run, keep the Peugeot tokens already in the file
    access = refresh = ""
    try:
        with open("/etc/evcc.yaml", encoding="utf-8") as fh:
            current = fh.read()
        access = (re.search(r"accessToken:\s*(\S+)", current) or [None, ""])[1]
        refresh = (re.search(r"refreshToken:\s*(\S+)", current) or [None, ""])[1]
        if access.startswith("FILL-IN"):
            access = ""
        if refresh.startswith("FILL-IN"):
            refresh = ""
    except OSError:
        pass

    info("writing /etc/evcc.yaml...")
    c.write("/etc/evcc.yaml", evcc_yaml(c, access, refresh))

    # Align the host the service announces with the new hostname
    override = "/etc/systemd/system/evcc.service.d/override.conf"
    if os.path.exists(override) and not c.dry:
        with open(override, encoding="utf-8") as fh:
            text = fh.read()
        patched = re.sub(r'EVCC_NETWORK_HOST=[^"]*"',
                         f'EVCC_NETWORK_HOST={c["NEW_HOSTNAME"]}.local"', text)
        if patched != text:
            c.write(override, patched)
            c.run(["systemctl", "daemon-reload"])

    c.run(["systemctl", "restart", "evcc"], check=False)
    if not c.dry and "FILL-IN" in open("/etc/evcc.yaml", encoding="utf-8").read():
        warn("/etc/evcc.yaml still has placeholders (search for FILL-IN).")
        warn("    evcc starts, but the missing devices will error in the web UI.")
        warn("    e-208 tokens: sudo evcc-psa-token renew")
    else:
        ok("evcc configured (Pulsar Plus + Huawei EMMA + e-208)")


def sec_hostname(c: Ctx) -> None:
    # Deliberately last: the change can drop the SSH session and the old name
    # stops resolving. By now everything else is configured.
    old = c.run(["hostname"], capture=True, always=True).stdout.strip()
    new = c["NEW_HOSTNAME"]
    if old == new:
        ok(f"hostname is already {new}")
        return
    info(f"renaming hostname: {old} -> {new}")
    info("if the SSH session drops now, reconnect with:")
    info(f"    ssh admin@{c.ip}   or   ssh admin@{new}.local")
    c.run(["hostnamectl", "set-hostname", new])
    if not c.dry:
        with open("/etc/hosts", encoding="utf-8") as fh:
            hosts = fh.read()
        c.write("/etc/hosts", re.sub(rf"\b{re.escape(old)}\b", new, hosts))
    c.run(["systemctl", "restart", "avahi-daemon"], check=False)
    ok(f"hostname changed (mDNS: {new}.local)")


def sec_summary(c: Ctx) -> None:
    ts = tailscale_ip(c) or "not authenticated (sudo tailscale up --accept-dns=false)"
    host, domain = c["NEW_HOSTNAME"], c["LOCAL_DOMAIN"]
    print(f"""
================================================================
{OK} Configuration complete

  Hostname:      {host}
  Current IP:    {c.ip}
  Tailscale:     {ts}

  evcc:          https://{c.evcc_host}/
  Pi-hole:       https://{c.pihole_host}/
  Cockpit:       https://{c.cockpit_host}/
  OCPP:          ws://{c.ip}:8887/<stationid>  (straight to evcc, no proxy)

  Direct access (no proxy):
  evcc http://{host}.local:7070/ | Pi-hole http://{host}.local:{c['PIHOLE_WEB_PORT_HTTP']}/admin | Cockpit https://{host}.local:9090/""")
    if c.password_generated:
        print(f"  Pi-hole password (generated): {c.pihole_password}")
        print("  Save it now; you can change it with: sudo pihole setpassword")
    print(f"""
  Next steps:
  1. Reserve a fixed IP for this Pi on the router (DHCP reservation)
  2. Point the router's DHCP DNS at {c.ip}
     (.{domain} names only resolve for clients using Pi-hole)
  3. In the Tailscale console (https://login.tailscale.com/admin):
     a) Machines -> {host} -> Edit route settings
        -> approve the {c.subnet} route (subnet router)
     b) DNS -> Add nameserver -> Custom -> {tailscale_ip(c) or "<the Pi's Tailscale IP>"}
        - Split DNS (restrict to domain: {domain}), or
        - Global, for ad blocking across the whole tailnet
  4. evcc:
     - In the myWallbox app: enable OCPP with URL ws://{c.ip}:8887/
       and a Charge Point Identity matching stationid in evcc.yaml
       (use the IP, not the name: the Pi is what resolves names)
     - On the EMMA: confirm Modbus TCP is enabled
     - In FusionSolar: battery limits (charge end 95%, discharge end 25%)
     - In the evcc UI (Configuration > Battery): priority 25%
     - On the "Garage" loadpoint: 6-20 A, and a smart cost limit
       >= {c['TARIFF_OFF_PEAK']} EUR/kWh (so it only draws from the grid off-peak)
     - e-208 tokens: sudo evcc-psa-token init && sudo evcc-psa-token renew
  5. Reboot the Pi so the new hostname propagates: sudo reboot
================================================================""")


HANDLERS = {
    "system": sec_system, "pihole": sec_pihole, "caddy": sec_caddy,
    "dns": sec_dns, "tailscale": sec_tailscale, "wifi": sec_wifi,
    "evcc": sec_evcc, "hostname": sec_hostname, "summary": sec_summary,
}


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        prog="setup-pi", description=__doc__.split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Sections: " + " ".join(SECTIONS))
    p.add_argument("sections", nargs="*", metavar="SECTION",
                   help="sections to run (none = all of them, in order)")
    p.add_argument("--list", action="store_true", help="list the sections and exit")
    p.add_argument("--dry-run", action="store_true",
                   help="show what it would do, without running or writing anything")
    args = p.parse_args(argv)

    if args.list:
        print("Sections, in the order they run:")
        for s in SECTIONS:
            print(f"  {s}")
        return 0

    targets = args.sections or SECTIONS
    unknown = [s for s in targets if s not in HANDLERS]
    if unknown:
        raise Failed(f"unknown section: {', '.join(unknown)}\n"
                     f"    Available: {' '.join(SECTIONS)}")

    if os.geteuid() != 0 and not args.dry_run:
        raise Failed(f"run with sudo: sudo python3 {sys.argv[0]}")

    # apt without interactive prompts
    os.environ["DEBIAN_FRONTEND"] = "noninteractive"

    c = Ctx(dry_run=args.dry_run)
    if args.dry_run:
        info("--dry-run: nothing is executed or written")

    for s in targets:
        print(f"\n{'-' * 20} {s} {'-' * 20}")
        HANDLERS[s](c)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Failed as exc:
        warn(str(exc))
        sys.exit(1)
    except KeyboardInterrupt:
        print()
        sys.exit(130)
