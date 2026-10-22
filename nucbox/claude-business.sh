#!/usr/bin/env bash
# Claude Code runs as the business account in dogchef repos (the claude-wrap wrapper first on PATH picks it);
# everywhere else it keeps ~/.claude. The business dir shares CLAUDE.md, settings.json, skills and plugins with
# ~/.claude by symlink; login is separate. Also cleans the old direnv setup. Safe to run again; nothing else is
# overwritten or deleted.
set -euo pipefail
say() { echo "==> $*"; }
CLAUDE_HOME=${CLAUDE_HOME:-$HOME/.claude}
BUSINESS_DIR=${BUSINESS_DIR:-$HOME/.claude-business}
DOGCHEF_DIR=${DOGCHEF_DIR:-$HOME/Projects/dogchef}
BASHRC=${BASHRC:-$HOME/.bashrc}
PROFILE=${PROFILE:-$HOME/.profile}
WRAP_DIR=${WRAP_DIR:-$HOME/.local/claude-wrap}
export_line='export CLAUDE_CONFIG_DIR="$HOME/.claude-business"'
hook_line='eval "$(direnv hook bash)"'
path_line='export PATH="$HOME/.local/claude-wrap:$PATH"'

# remove one exact line from a file; true when it was there
drop_line() {
  grep -qxF "$1" "$2" 2>/dev/null || return 1
  local tmp; tmp=$(mktemp)
  grep -vxF "$1" "$2" > "$tmp" || true
  cat "$tmp" > "$2"; rm -f "$tmp"
}

if drop_line "$hook_line" "$BASHRC"; then say "direnv hook removed from $BASHRC"; fi
envrc=$DOGCHEF_DIR/.envrc
if drop_line "$export_line" "$envrc"; then
  if [[ -z $(tr -d '[:space:]' < "$envrc") ]]; then rm -f "$envrc"; say "$envrc removed (nothing else in it)"
  else say "export removed from $envrc, other lines kept"; fi
fi

mkdir -p "$WRAP_DIR"
install -m 755 "$(dirname "$0")/claude-wrap" "$WRAP_DIR/claude"; say "wrapper installed in $WRAP_DIR"
if grep -qxF "$path_line" "$BASHRC"; then say "wrapper PATH already in $BASHRC"; else
  printf '%s\n' "$path_line" >> "$BASHRC"; say "wrapper PATH added to $BASHRC"
fi

# ~/.bashrc is skipped by non-interactive shells and ~/.profile prepends ~/.local/bin after it, so a block at the
# end of ~/.profile puts the wrapper first for login shells too (Orca builds its agents' PATH from one)
profile_mark='# claude-wrap PATH (claude-business.sh)'
if grep -qxF "$profile_mark" "$PROFILE" 2>/dev/null; then say "wrapper PATH already in $PROFILE"; else
  printf '\n%s\ncase ":$PATH:" in ":$HOME/.local/claude-wrap:"*) ;; *) export PATH="$HOME/.local/claude-wrap:$PATH" ;; esac\n' "$profile_mark" >> "$PROFILE"
  say "wrapper PATH added to $PROFILE"
fi

mkdir -p "$BUSINESS_DIR"
for n in CLAUDE.md settings.json skills plugins; do
  if [[ -L $BUSINESS_DIR/$n && $(readlink "$BUSINESS_DIR/$n") == "$CLAUDE_HOME/$n" ]]; then say "$n already linked"
  elif [[ -e $BUSINESS_DIR/$n || -L $BUSINESS_DIR/$n ]]; then say "$BUSINESS_DIR/$n exists, left alone"
  else ln -s "$CLAUDE_HOME/$n" "$BUSINESS_DIR/$n"; say "$n linked"; fi
done

# The guard runs as a UserPromptSubmit hook in the shared settings (~/.claude-business/settings.json is a symlink to it)
settings=$CLAUDE_HOME/settings.json
guard="CLAUDE_WRAP_GUARD=1 $WRAP_DIR/claude"
if ! command -v jq >/dev/null; then say "jq missing, account guard hook not added to $settings"
elif jq -e --arg g "$guard" '[.hooks.UserPromptSubmit[]?.hooks[]?.command] | index($g)' "$settings" >/dev/null 2>&1; then say "account guard already in $settings"
else
  [[ -e $settings.bak-claude-business ]] || cp "$settings" "$settings.bak-claude-business"
  tmp=$(mktemp)
  jq --arg g "$guard" '.hooks.UserPromptSubmit += [{hooks: [{type: "command", command: $g, timeout: 5}]}]' "$settings" > "$tmp" \
    && cat "$tmp" > "$settings" && say "account guard hook added to $settings (backup: $settings.bak-claude-business)"
  rm -f "$tmp"
fi

cat <<MSG

Next: open a new shell (or exec bash), then
  cd ~/Projects/dogchef/dev && claude
  /login   (business account), then /status to confirm
For Orca (its agents do not read ~/.bashrc), re-render the unit and restart it, which ends running agents:
  bash ~/Projects/personal/evcc-pi/nucbox/install-orca.sh && systemctl --user restart orca.service
MSG
if command -v direnv >/dev/null; then echo "direnv is no longer used; optional: sudo apt remove direnv"; fi
