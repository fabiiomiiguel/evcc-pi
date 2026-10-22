#!/usr/bin/env bash
# Claude Code runs as the business account inside DOGCHEF_DIR (via direnv's CLAUDE_CONFIG_DIR); everywhere else it
# keeps ~/.claude. The business dir shares CLAUDE.md, settings.json, skills and plugins with ~/.claude by symlink;
# login is separate. Safe to run again; nothing existing is overwritten or deleted.
set -euo pipefail
say() { echo "==> $*"; }
CLAUDE_HOME=${CLAUDE_HOME:-$HOME/.claude}
BUSINESS_DIR=${BUSINESS_DIR:-$HOME/.claude-business}
DOGCHEF_DIR=${DOGCHEF_DIR:-$HOME/Projects/dogchef}
BASHRC=${BASHRC:-$HOME/.bashrc}
export_line='export CLAUDE_CONFIG_DIR="$HOME/.claude-business"'
hook_line='eval "$(direnv hook bash)"'

if command -v direnv >/dev/null; then say "direnv already installed"; else say "installing direnv"; sudo apt install -y direnv; fi

if grep -qsF 'direnv hook bash' "$BASHRC"; then say "direnv hook already in $BASHRC"; else
  printf '%s\n' "$hook_line" >> "$BASHRC"; say "direnv hook added to $BASHRC"
fi

mkdir -p "$BUSINESS_DIR"
for n in CLAUDE.md settings.json skills plugins; do
  if [[ -L $BUSINESS_DIR/$n && $(readlink "$BUSINESS_DIR/$n") == "$CLAUDE_HOME/$n" ]]; then say "$n already linked"
  elif [[ -e $BUSINESS_DIR/$n || -L $BUSINESS_DIR/$n ]]; then say "$BUSINESS_DIR/$n exists, left alone"
  else ln -s "$CLAUDE_HOME/$n" "$BUSINESS_DIR/$n"; say "$n linked"; fi
done

mkdir -p "$DOGCHEF_DIR"
if grep -qxF "$export_line" "$DOGCHEF_DIR/.envrc" 2>/dev/null; then say ".envrc already exports CLAUDE_CONFIG_DIR"; else
  [[ ! -s $DOGCHEF_DIR/.envrc || -z $(tail -c1 "$DOGCHEF_DIR/.envrc") ]] || echo >> "$DOGCHEF_DIR/.envrc"
  printf '%s\n' "$export_line" >> "$DOGCHEF_DIR/.envrc"; say ".envrc updated"
fi
direnv allow "$DOGCHEF_DIR"

cat <<MSG

Next: open a new shell (or exec bash), then
  cd ~/Projects/dogchef/dev && claude
  /login   (business account), then /status to confirm
Claude started by Orca or systemd does not pass through direnv: it keeps the personal account.
MSG
