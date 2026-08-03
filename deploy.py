#!/usr/bin/env python3
"""deploy — installs/updates the scripts on the Raspberry Pi, from the Mac.

    ./deploy.py                    install evcc-psa-token and evcc-watch
    ./deploy.py renew              install, then run renew
    ./deploy.py --stelloauth       also install the local OAuth helper (Chromium)
    ./deploy.py --no-stelloauth    remove it and go back to the public stelloauth
    ./deploy.py --setup dns caddy  run setup-pi.py sections on the Pi

The Pi address comes from PI in .env (see .env.example).
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# local file -> command name on the Pi
TOOLS = {
    "evcc-psa-token.py": "evcc-psa-token",
    "evcc-watch.py": "evcc-watch",
}


class Failed(Exception):
    pass


def pi_host() -> str:
    env = os.path.join(HERE, ".env")
    if os.path.exists(env):
        with open(env, encoding="utf-8") as fh:
            for line in fh:
                if line.strip().startswith("PI="):
                    parts = shlex.split(line.strip(), comments=True)
                    host = parts[0].split("=", 1)[1] if parts else ""
                    if host:            # an empty PI= is not an answer
                        return host
    return os.environ.get("PI", "admin@raspberrypi.local")


def run(cmd: list[str]) -> None:
    if subprocess.run(cmd).returncode != 0:
        raise Failed(f"failed: {shlex.join(cmd)}")


def compiles(path: str) -> None:
    """No point copying a script that does not even compile."""
    run([sys.executable, "-m", "py_compile", path])


def send(host: str, local: str, remote: str) -> None:
    run(["scp", "-4", "-q", local, f"{host}:{remote}"])


def ssh(host: str, command: str) -> None:
    run(["ssh", "-4", "-t", host, command])


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="deploy", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", nargs="*", help="command to run on evcc-psa-token")
    p.add_argument("--stelloauth", action="store_true",
                   help="install the local OAuth helper on the Pi")
    p.add_argument("--no-stelloauth", action="store_true",
                   help="remove the local helper and go back to the public service")
    p.add_argument("--setup", nargs="*", metavar="SECTION",
                   help="run setup-pi.py on the Pi (sections optional)")
    args = p.parse_args(argv)

    host = pi_host()
    print(f"-> {host}")

    for filename, name in TOOLS.items():
        local = os.path.join(HERE, filename)
        compiles(local)
        send(host, local, f"/tmp/{name}")
        ssh(host, f"sudo install -m 0755 /tmp/{name} /usr/local/bin/{name} "
                  f"&& rm -f /tmp/{name}")
        print(f"  {name} installed")

    if args.stelloauth or args.no_stelloauth:
        local = os.path.join(HERE, "install-stelloauth.py")
        compiles(local)
        send(host, local, "/tmp/install-stelloauth.py")
        flag = " --uninstall" if args.no_stelloauth else ""
        ssh(host, f"sudo python3 /tmp/install-stelloauth.py{flag}; "
                  "rm -f /tmp/install-stelloauth.py")

    if args.setup is not None:
        local = os.path.join(HERE, "setup-pi.py")
        compiles(local)
        send(host, local, "/tmp/setup-pi.py")
        # .env only stays on the Pi for the duration of the setup run
        send(host, os.path.join(HERE, ".env"), "/tmp/.env")
        sections = " ".join(shlex.quote(s) for s in args.setup)
        ssh(host, f"sudo ENV_FILE=/tmp/.env python3 /tmp/setup-pi.py {sections}; "
                  "rm -f /tmp/setup-pi.py /tmp/.env")

    if args.command:
        ssh(host, "sudo evcc-psa-token " + " ".join(
            shlex.quote(a) for a in args.command))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Failed as exc:
        print(f"x {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
