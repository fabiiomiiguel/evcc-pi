#!/usr/bin/env python3
"""install-stelloauth — installs the Stellantis OAuth helper on the Pi itself,
so the MyPeugeot account password never has to go through a third-party site.

    github.com/tamcore/stelloauth  (Go + headless Chromium)

It listens on 127.0.0.1 only, and evcc-psa-token is pointed at it.

    sudo python3 install-stelloauth.py              install
    sudo python3 install-stelloauth.py --uninstall  remove, back to the public one

Cost, measured on a Pi 3B+ (903 MB RAM): ~280 MB of disk for chromium,
~60 s per login, ~630 MB RAM peak while it runs.

Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPO = "tamcore/stelloauth"
FALLBACK_VERSION = "v0.2.1"
BIN = "/usr/local/bin/stelloauth"
UNIT = "/etc/systemd/system/stelloauth.service"
ADDR, PORT = "127.0.0.1", 8099
CONF = "/etc/evcc-psa-token.conf"
PUBLIC_URL = "https://stelloauth.tollet.me"


class Failed(Exception):
    pass


def ok(msg: str) -> None:
    print(f"ok  {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"!   {msg}", file=sys.stderr, flush=True)


def run(cmd: list[str], check: bool = True, capture: bool = False):
    r = subprocess.run(cmd, text=True, capture_output=capture)
    if check and r.returncode != 0:
        raise Failed(f"failed: {' '.join(cmd)}")
    return r


def chrome() -> str | None:
    for c in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        if shutil.which(c):
            return shutil.which(c)
    return None


def point_at(url: str) -> None:
    """Point evcc-psa-token's STELLO_URL at `url`."""
    if not os.path.exists(CONF):
        warn(f"{CONF} does not exist — run 'sudo evcc-psa-token init' and add")
        warn(f'  STELLO_URL="{url}"')
        return
    with open(CONF, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith("STELLO_URL="):
            lines[i] = f'STELLO_URL="{url}"'
            found = True
    if not found:
        lines.append(f'STELLO_URL="{url}"')
    with open(CONF, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(CONF, 0o600)
    ok(f"{CONF} now points at {url}")


def uninstall() -> int:
    print("1/3  stopping the service...")
    run(["systemctl", "disable", "--now", "stelloauth.service"], check=False)
    for f in (UNIT, BIN):
        if os.path.exists(f):
            os.remove(f)
    run(["systemctl", "daemon-reload"], check=False)
    ok("service and binary removed")

    print("2/3  removing chromium...")
    if shutil.which("chromium"):
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        subprocess.run(["apt-get", "purge", "-y", "-qq", "chromium"], env=env)
        subprocess.run(["apt-get", "autoremove", "--purge", "-y", "-qq"], env=env)
        free = shutil.disk_usage("/").free // (1024 ** 3)
        ok(f"chromium removed ({free} GB free)")
    else:
        ok("chromium was not installed")

    print("3/3  switching back to the public stelloauth...")
    point_at(PUBLIC_URL)
    print()
    ok("done. To reinstall: sudo python3 install-stelloauth.py")
    return 0


def latest_version() -> str:
    try:
        with urllib.request.urlopen(
                f"https://api.github.com/repos/{REPO}/releases/latest", timeout=20) as r:
            return json.load(r)["tag_name"]
    except (urllib.error.URLError, ValueError, KeyError, OSError):
        warn(f"GitHub API unavailable, using {FALLBACK_VERSION}")
        return FALLBACK_VERSION


def install() -> int:
    # ---- 1. chromium
    exe = chrome()
    if not exe:
        print("1/4  installing chromium (~75 MB download, ~280 MB on disk)...")
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        if subprocess.run(["apt-get", "install", "-y", "--no-install-recommends",
                           "chromium"], env=env).returncode != 0:
            raise Failed("chromium install failed")
        exe = chrome()
    ok(f"chromium: {exe}")

    # ---- 2. binary
    arch = {"aarch64": "arm64", "arm64": "arm64",
            "x86_64": "amd64", "amd64": "amd64"}.get(os.uname().machine)
    if not arch:
        raise Failed(f"no stelloauth binary for {os.uname().machine} — "
                     f"see github.com/{REPO}/releases")

    version = os.environ.get("STELLO_VERSION") or latest_version()
    name = f"stelloauth_{version.lstrip('v')}_linux_{arch}.tar.gz"
    base = f"https://github.com/{REPO}/releases/download/{version}"
    print(f"2/4  downloading stelloauth {version} ({arch})...")

    with tempfile.TemporaryDirectory() as tmp:
        tgz = os.path.join(tmp, name)
        try:
            with urllib.request.urlopen(f"{base}/{name}", timeout=180) as r, \
                    open(tgz, "wb") as fh:
                shutil.copyfileobj(r, fh)
        except (urllib.error.URLError, OSError) as e:
            raise Failed(f"could not download {name}: {e}") from None

        try:
            with urllib.request.urlopen(f"{base}/checksums.txt", timeout=30) as r:
                sums = r.read().decode()
            expected = next((l.split()[0] for l in sums.splitlines()
                             if l.strip().endswith(name)), None)
            if not expected:
                warn("checksums.txt does not list the file — installing unverified")
            else:
                digest = hashlib.sha256(open(tgz, "rb").read()).hexdigest()
                if digest != expected:
                    raise Failed(f"checksum mismatch for {name}\n"
                                 f"    expected {expected}\n    got      {digest}")
                ok("checksum verified")
        except (urllib.error.URLError, OSError):
            warn("no checksums.txt — installing unverified")

        with tarfile.open(tgz) as tar:
            tar.extract(tar.getmember("stelloauth"), tmp, filter="data")
        shutil.copy2(os.path.join(tmp, "stelloauth"), BIN)
        os.chmod(BIN, 0o755)
    ok(f"installed {BIN}")

    # ---- 3. service
    print("3/4  creating the systemd service...")
    with open(UNIT, "w", encoding="utf-8") as fh:
        fh.write(f"""[Unit]
Description=stelloauth — Stellantis OAuth helper (local, {ADDR} only)
Documentation=https://github.com/{REPO}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={BIN}
Environment=HTTP_ADDRESS={ADDR}
Environment=PORT={PORT}
# chromedp needs a HOME and a writable /tmp
Environment=HOME=/tmp
Environment=XDG_CONFIG_HOME=/tmp
Environment=XDG_CACHE_HOME=/tmp
DynamicUser=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
# on a Pi with little RAM: tell the kernel to reclaim before it kills
MemoryHigh=500M
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
""")
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "stelloauth.service"])
    time.sleep(2)
    if run(["systemctl", "is-active", "--quiet", "stelloauth.service"],
           check=False).returncode != 0:
        run(["journalctl", "-u", "stelloauth", "-n", "20", "--no-pager"], check=False)
        raise Failed("the stelloauth service did not start")
    ok(f"stelloauth running on http://{ADDR}:{PORT} (local only)")

    # ---- 4. wiring
    print("4/4  verifying...")
    url = f"http://{ADDR}:{PORT}"
    brands = None
    for _ in range(10):
        try:
            with urllib.request.urlopen(f"{url}/configs", timeout=5) as r:
                brands = ", ".join(json.load(r))
            break
        except (urllib.error.URLError, ValueError, OSError):
            time.sleep(1)
    if brands is None:
        raise Failed("/configs does not answer")
    ok(f"/configs answers: {brands}")

    point_at(url)
    print()
    ok("done. The MyPeugeot password no longer leaves the Pi.")
    print("   try it:  sudo evcc-psa-token renew")
    print("   logs:    journalctl -u stelloauth -f")
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="install-stelloauth",
                                description=__doc__.split("\n\n")[0])
    p.add_argument("--uninstall", action="store_true",
                   help="remove the helper and go back to the public stelloauth")
    args = p.parse_args(argv)

    if os.geteuid() != 0:
        raise Failed("run with sudo")
    return uninstall() if args.uninstall else install()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Failed as exc:
        print(f"x {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
