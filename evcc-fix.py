#!/usr/bin/env python3
"""evcc-fix — shortcut from the Mac to evcc-psa-token on the Raspberry Pi.

    ./evcc-fix.py                 token status (changes nothing)
    ./evcc-fix.py renew           renew now
    ./evcc-fix.py check           renew only if it is actually broken
    ./evcc-fix.py renew --country FR
    ./evcc-fix.py --watch         latest evcc-watch messages

The Pi address comes from PI in .env (see .env.example).
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


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


def main(argv: list[str]) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0

    if argv and argv[0] == "--watch":
        remote = "sudo journalctl -t evcc-watch -o cat --no-pager -n 40"
    else:
        args = argv or ["status"]
        remote = "sudo evcc-psa-token " + " ".join(shlex.quote(a) for a in args)

    return subprocess.run(["ssh", "-4", "-t", pi_host(), remote]).returncode


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
