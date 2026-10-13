#!/usr/bin/env bash
# Puts ORCA_HOST (tailnet + LAN only) in front of Orca's runtime on 127.0.0.1:$ORCA_PORT.
# Edits only the `@orca` matcher and its handle in the live Caddyfile, before the catch-all
# `handle {`; safe to run again. `--print` renders the block and touches nothing.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${ORCA_HOST:?set ORCA_HOST in .env}"
: "${LAN_CIDR:?set LAN_CIDR in .env}"

LIVE=/etc/caddy/Caddyfile
ENVF=/etc/caddy/cloudflare.env   # the service's environment (DNS token); validate must load it
say() { echo "==> $*"; }
die() { echo "!! $*" >&2; exit 1; }

# $1 = current Caddyfile, $2 = where to write the result
render() {
  HOST=$ORCA_HOST PORT=$ORCA_PORT NETS="$TAILNET_CIDR $LAN_CIDR" python3 - "$1" "$2" <<'PY'
import os, re, sys
src = open(sys.argv[1]).read(); e = os.environ
site = f"""	@orca host {e['HOST']}
	handle @orca {{
		@outsiders not remote_ip {e['NETS']}
		respond @outsiders 403
		reverse_proxy 127.0.0.1:{e['PORT']}
	}}
"""
def block_end(text, start):
    depth = 0
    for i in range(text.index('{', start), len(text)):
        if text[i] == '{': depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0: return text.index('\n', i) + 1
    sys.exit('unbalanced braces')
m = re.search(r'^\t@orca host [^\n]*\n', src, re.M)
if m:
    h = re.search(r'^\thandle @orca \{', src[m.end():], re.M)
    src = src[:m.start()] + site + src[block_end(src, m.end() + h.start()):]
else:
    c = re.search(r'^\thandle \{', src, re.M)
    if not c: sys.exit('no catch-all handle to put orca before')
    src = src[:c.start()] + site + '\n' + src[c.start():]
open(sys.argv[2], 'w').write(src)
PY
}

if [[ ${1:-} == --print ]]; then
  old=$(mktemp); new=$(mktemp)
  printf '%s\n' '{' '	email admin@example.com' '}' 'example.com {' '	handle {' '		respond "ok"' '	}' '}' >"$old"
  render "$old" "$new"; cat "$new"; rm -f "$old" "$new"; exit 0
fi

sudo -v
old=$(mktemp); new=$(mktemp)
sudo cat "$LIVE" >"$old"
render "$old" "$new"
caddy fmt --overwrite "$new" >/dev/null 2>&1 || true
if diff -q "$old" "$new" >/dev/null; then say "the Caddyfile is already like this; nothing to change."; else echo "--- changes:"; diff "$old" "$new" || true; echo "---"; fi

say "validating as the caddy user, with the service's environment..."
sudo install -m 644 "$new" /etc/caddy/Caddyfile.candidate
if ! sudo bash -c "set -a; . '$ENVF'; HOME=/var/lib/caddy exec setpriv --reuid=caddy --regid=caddy --init-groups caddy validate --config /etc/caddy/Caddyfile.candidate" >/tmp/caddy-validate.log 2>&1; then
  tail -5 /tmp/caddy-validate.log; sudo rm -f /etc/caddy/Caddyfile.candidate; die "invalid: nothing was changed"
fi
BAK="$LIVE.bak.$(date +%Y%m%d-%H%M%S)"
sudo cp "$LIVE" "$BAK"; sudo mv /etc/caddy/Caddyfile.candidate "$LIVE"; rm -f "$new" "$old"
sudo systemctl restart caddy; sleep 2
if ! systemctl is-active --quiet caddy; then sudo cp "$BAK" "$LIVE"; sudo systemctl restart caddy; die "caddy did not start; restored $BAK"; fi
say "done: https://$ORCA_HOST -> 127.0.0.1:$ORCA_PORT   undo: sudo cp $BAK $LIVE && sudo systemctl restart caddy"
