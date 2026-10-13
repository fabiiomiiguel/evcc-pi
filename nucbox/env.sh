# sourced by the nucbox scripts: fills variables not already in the environment from .env (next to
# them, or in the repo root), then defaults.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for f in "$here/.env" "$here/../.env"; do
  [[ -f $f ]] || continue
  for n in NUCBOX ORCA_HOST ORCA_PORT LAN_CIDR TAILNET_CIDR PROJECTS_DIR; do
    [[ -n ${!n:-} ]] || export "$n=$(set +u; . "$f"; printf %s "${!n:-}")"
  done
  break
done
: "${ORCA_PORT:=6768}"
: "${TAILNET_CIDR:=100.64.0.0/10}"
