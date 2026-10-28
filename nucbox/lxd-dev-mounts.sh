#!/usr/bin/env bash
# Gives the LXD container `dev` one disk per dogchef folder, same path inside: $PROJECTS_DIR/dogchef and every
# ~/orca/workspaces/* whose worktrees are dogchef (is-business-dir.sh, the rule lxd-personal.sh inverts). The old
# whole-tree `projects`/`orca` disks and stale m-* ones are removed. Safe to run again; lxc only, no sudo; never
# touches `personal` or devices other than those. Changing disks works on a stopped container too.
set -euo pipefail
INST=${DEV_INSTANCE:-dev}
USER_NAME=${DEV_USER:-fabio}
. "$(dirname "$0")/is-business-dir.sh"

[[ -d $PROJECTS_DIR/dogchef ]] || { echo "missing $PROJECTS_DIR/dogchef (mounted into $INST)" >&2; exit 1; }
shopt -s nullglob
declare -A WANT=([m-p-dogchef]=$PROJECTS_DIR/dogchef)
for w in "$HOME"/orca/workspaces/*/; do
  w=${w%/}
  ! business_workspace "$w" || WANT["m-o-${w##*/}"]=$w
done

for dev in $(lxc config device list "$INST" | grep -x 'projects\|orca\|m-.*'); do
  [[ -v WANT[$dev] ]] || lxc config device remove "$INST" "$dev"
done
have=$(lxc config device list "$INST")
for dev in "${!WANT[@]}"; do
  grep -qx "$dev" <<<"$have" || lxc config device add "$INST" "$dev" disk source="${WANT[$dev]}" path="${WANT[$dev]}" shift=true
done

# LXD creates the parents of the mounts as root with mode 000, which locks the user out of the mounts.
parents=("$PROJECTS_DIR" "$HOME/orca" "$HOME/orca/workspaces")
if lxc list "^${INST}$" -f csv -c s | grep -qx RUNNING; then
  lxc exec "$INST" -- install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 "${parents[@]}"
else
  echo "$INST is stopped: after lxc start $INST run: lxc exec $INST -- install -d -o $USER_NAME -g $USER_NAME -m 755 ${parents[*]}"
fi
