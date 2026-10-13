#!/usr/bin/env bash
# Mirrors ~/Projects from this machine to the NucBox and rewrites the worktree links for its home.
# Run from the Mac. Needs NUCBOX (ssh target) in .env.
set -euo pipefail
. "$(dirname "$0")/env.sh"
: "${NUCBOX:?set NUCBOX in .env}"
src=${PROJECTS_DIR:-$HOME/Projects}

rsync -a --exclude node_modules --exclude .nuxt --exclude .output --exclude .next \
  --exclude .turbo --exclude .cache --exclude .DS_Store "$src/" "$NUCBOX:Projects/"

# worktrees record absolute paths: the Mac's home becomes the NucBox's
ssh "$NUCBOX" "mac_home='$HOME'"' bash -s' <<'REMOTE'
set -euo pipefail
find "$HOME/Projects" -name node_modules -prune -o \( -path '*/.git/worktrees/*/gitdir' -o -path '*/.git' -type f \) -print |
  while read -r f; do sed -i "s|^\(gitdir: \)\{0,1\}$mac_home/|\1$HOME/|" "$f"; done
git config --global core.filemode false
REMOTE

if [[ -f $HOME/.config/git/ignore ]]; then
  ssh "$NUCBOX" 'mkdir -p ~/.config/git'
  scp -q "$HOME/.config/git/ignore" "$NUCBOX:.config/git/ignore"
fi
