#!/usr/bin/env bash
# Keeps the Orca server-only tarball current: ~/.local/opt/orca/<version>/ plus a `current` symlink (and
# `previous`, kept for rollback). Run daily by orca-update.timer; node --test nucbox/tests/orca-update.test.mjs checks it.
#   ./orca-update.sh            # newest release that is >= ORCA_UPDATE_DELAY_DAYS (3) old and newer than `current`
#   ./orca-update.sh --install  # first install: no `current` yet, newest release, no delay, no restart; a no-op otherwise
# Steps: sha256 from the same release's sums file, extract to <version>.tmp, `--version` must print the version, rename, flip
# `current`, restart orca.service, wait for it to be active and listening on ORCA_PORT. On failure: flip back and restart
# unless the previous build cannot attach a live terminal daemon's protocol (its terminals would be stranded): then the new
# build stays, exit 1. A build that failed is never picked again (bad-versions). Prune keeps current, previous and any
# version dir a running process executes from (the terminal daemon keeps running from the dir it started in).
set -euo pipefail
. "$(dirname "$0")/env.sh"
OPT=${ORCA_OPT:-$HOME/.local/opt/orca}
API=${ORCA_UPDATE_API:-https://api.github.com/repos/stablyai/orca/releases?per_page=30}
DELAY=${ORCA_UPDATE_DELAY_DAYS:-3}
HEALTH_TIMEOUT=${ORCA_UPDATE_HEALTH_TIMEOUT:-120}
DATA=${ORCA_USER_DATA_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/orca}
ASSET=orca-server-linux-x64.tar.gz
SUMS=orca-server-sha256sums.txt

log() { echo "orca-update: $*"; }
die() { echo "orca-update: $*" >&2; exit 1; }

mode=update
case ${1:-} in
  "") ;;
  --install) mode=install; DELAY=0 ;;
  *) echo "usage: orca-update.sh [--install]" >&2; exit 2 ;;
esac

# Newest release for `$1` days ago or older: tag, tarball url, sums url (tab separated); nothing when none qualifies.
pick() {
  local cutoff
  cutoff=$(date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ)
  curl -fsS --retry 3 -H 'Accept: application/vnd.github+json' "$API" |
    jq -r --arg cutoff "$cutoff" --arg a "$ASSET" --arg s "$SUMS" --arg bad "$(cat "$OPT/bad-versions" 2>/dev/null || true)" '
      [.[] | select(.draft == false and .prerelease == false
          and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
          and .published_at <= $cutoff
          and (.tag_name[1:] as $v | ($bad | split("\n") | index($v)) == null)
          and ([.assets[].name] | index($a) != null and index($s) != null))]
      | sort_by(.published_at) | last // empty
      | [.tag_name, (.assets[] | select(.name == $a) | .browser_download_url), (.assets[] | select(.name == $s) | .browser_download_url)] | @tsv'
}

# Every protocol the build in dir `$1` can attach: its own and the previous ones, read from the bundle by public export name.
protocols_of() {
  local js=$1/orcad/orcad-server.js cur prev
  cur=$(grep -oP '[{,]PROTOCOL_VERSION:\(\)=>\K[\w$]+' "$js" | head -1) || return 0
  prev=$(grep -oP '[{,]PREVIOUS_DAEMON_PROTOCOL_VERSIONS:\(\)=>\K[\w$]+' "$js" | head -1) || return 0
  { grep -oP "[{,;]${cur//\$/\\$}=\K[0-9]+" "$js" | head -1
    grep -oP "[{,;]${prev//\$/\\$}=\[\K[0-9,]*" "$js" | head -1 | tr ',' '\n'; } || true
}

# Protocols of the live terminal daemons: daemon-vNN.pid files (JSON with a "pid" key, written by the daemon's daemon-entry.js)
# whose pid is still running. A file without a readable pid counts as live: better to refuse a rollback than to strand terminals.
live_protocols() {
  local f pid
  for f in "$DATA"/daemon/daemon-v*.pid; do
    [[ -f $f ]] || continue
    if pid=$(jq -er '.pid' "$f" 2>/dev/null) && ! kill -0 "$pid" 2>/dev/null; then continue; fi
    f=${f##*/daemon-v}; echo "${f%.pid}"
  done
}

# Prints why the build in dir `$1` cannot take over the live daemons, and returns 0; returns 1 when it can.
blocker() {
  local have p
  have=" $(protocols_of "$1" | tr '\n' ' ')"
  for p in $(live_protocols); do
    [[ $have == *" $p "* ]] || { echo "a live terminal daemon speaks protocol $p, which $(basename "$1") cannot attach"; return 0; }
  done
  return 1
}

in_use() { grep -qaF -f <(printf '%s/' "$1") /proc/[0-9]*/cmdline 2>/dev/null; }

prune() {
  local d v keep=" $(readlink "$OPT/current") $(readlink "$OPT/previous" 2>/dev/null || true) "
  for d in "$OPT"/*/; do
    d=${d%/}; v=${d##*/}
    [[ -L $d || $v == *.tmp || $keep == *" $v "* ]] && continue
    if in_use "$real/$v"; then log "keeping $v: a running process uses it"; else rm -rf "$d"; log "pruned $v"; fi
  done
}

flip() { ln -sfn "$1" "$OPT/.link.$2" && mv -T "$OPT/.link.$2" "$OPT/$2"; }

healthy() {
  local i
  for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
    if systemctl --user is-active --quiet orca.service && (exec 3<>"/dev/tcp/127.0.0.1/$ORCA_PORT") 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# Restarts onto the current link; on failure rolls back to $prev. Returns 1 whenever the update did not stick.
restart_and_check() {
  systemctl --user restart orca.service || true
  healthy && { log "orca.service is active on $ver"; return 0; }
  log "orca.service did not come up on $ver"
  [[ -n $prev ]] || { log "no previous version to roll back to"; return 1; }
  if reason=$(blocker "$OPT/$prev"); then log "refusing to roll back to $prev: $reason; leaving $ver in place"; return 1; fi
  echo "$ver" >>"$OPT/bad-versions"
  flip "$prev" current
  systemctl --user restart orca.service || true
  if healthy; then log "rolled back to $prev"; else log "rollback to $prev failed too"; fi
  return 1
}

mkdir -p "$OPT"
real=$(cd "$OPT" && pwd -P)
exec 9>"$OPT/.lock"
flock -n 9 || { log "another run holds the lock"; exit 0; }
rm -rf "$OPT"/*.tmp "$OPT"/.dl.* "$OPT"/.link.*

cur=$(readlink "$OPT/current" 2>/dev/null || true)
if [[ $mode == install && -n $cur ]]; then log "already installed: $cur"; exit 0; fi

rel=$(pick "$DELAY")
[[ -n $rel ]] || { log "no release with $ASSET that is $DELAY days old"; exit 0; }
IFS=$'\t' read -r tag tarball_url sums_url <<<"$rel"
ver=${tag#v}
if [[ -n $cur && $(printf '%s\n%s\n' "$cur" "$ver" | sort -V | tail -1) == "$cur" ]]; then log "$cur is current (newest eligible: $ver)"; exit 0; fi

if [[ ! -d $OPT/$ver ]]; then
  tmp=$(mktemp -d "$OPT/.dl.XXXXXX")
  trap 'rm -rf "$tmp" "$OPT/$ver.tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/$ASSET" "$tarball_url"
  curl -fsSL --retry 3 -o "$tmp/$SUMS" "$sums_url"
  want=$(awk -v n="$ASSET" '$2 == n { print $1 }' "$tmp/$SUMS")
  got=$(sha256sum "$tmp/$ASSET" | cut -d' ' -f1)
  [[ -n $want && $want == "$got" ]] || die "sha256 mismatch for $ver (sums file says '$want', download is $got); nothing installed"
  mkdir "$OPT/$ver.tmp"
  tar -xzf "$tmp/$ASSET" -C "$OPT/$ver.tmp" --strip-components=1
  shown=$(timeout 60 "$OPT/$ver.tmp/bin/orca-ide" --version) || die "$ver: bin/orca-ide --version failed; nothing installed"
  [[ $shown == "$ver" ]] || die "$ver: bin/orca-ide --version prints '$shown'; nothing installed"
  mv "$OPT/$ver.tmp" "$OPT/$ver"
fi

prev=$cur
flip "$ver" current
[[ -z $prev ]] || flip "$prev" previous
log "current -> $ver (was ${prev:-none})"
[[ $mode == install ]] && exit 0

status=0
restart_and_check || status=1
prune
exit $status
