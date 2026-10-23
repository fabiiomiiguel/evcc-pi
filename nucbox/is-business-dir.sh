# Sourced by claude-wrap and box: true when $1 is a dogchef folder (under DOGCHEF_DIR, or a git repo whose origin is in dogchef-be/).
is_business_dir() {
  local dogchef=${DOGCHEF_DIR:-$HOME/Projects/dogchef}
  [[ $1 == "$dogchef" || $1 == "$dogchef"/* ]] || [[ $(git -C "$1" remote get-url origin 2>/dev/null) == *dogchef-be/* ]]
}
