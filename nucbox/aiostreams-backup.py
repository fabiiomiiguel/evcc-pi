#!/usr/bin/env python3
"""Daily copy of AIOStreams' config db and env into ~/backups/aiostreams (tv/README.md), keeping the latest.
Run by aiostreams-backup.timer; safe while AIOStreams runs (sqlite backup API)."""
import datetime
import os
import shutil
import sqlite3
from pathlib import Path

SRC = Path.home() / ".aiostreams"
DST = Path.home() / "backups" / "aiostreams"
KEEP = 1

os.umask(0o077)
DST.mkdir(parents=True, exist_ok=True)
out = DST / f"db-{datetime.date.today()}.sqlite"
src, dst = sqlite3.connect(SRC / "data" / "db.sqlite"), sqlite3.connect(out)
src.backup(dst)
assert dst.execute("pragma integrity_check").fetchone()[0] == "ok", out
dst.close()
shutil.copyfile(SRC / "env", DST / "env")
for old in sorted(DST.glob("db-*.sqlite"))[:-KEEP]:
    old.unlink()
print(out)
