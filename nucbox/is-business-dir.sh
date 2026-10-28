# Sourced by claude-wrap and box: true when $1 is a dogchef folder (under DOGCHEF_DIR, or a git repo whose origin is in dogchef-be/).
PROJECTS_DIR=${PROJECTS_DIR:-$HOME/projects}
is_business_dir() {
  local dogchef=${DOGCHEF_DIR:-$PROJECTS_DIR/dogchef}
  [[ $1 == "$dogchef" || $1 == "$dogchef"/* ]] || [[ $(git -C "$1" remote get-url origin 2>/dev/null) == *dogchef-be/* ]]
}
# true when an Orca workspace dir ($1) holds a dogchef worktree (an empty workspace is not)
business_workspace() {
  local c
  for c in "$1"/*/; do [[ -d $c ]] && is_business_dir "${c%/}" && return 0; done
  return 1
}
