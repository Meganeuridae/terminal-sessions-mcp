#!/bin/sh
# termd for a supervisor (launchd, systemd), whose PATH has no node: launchd's is
# /usr/bin:/bin:/usr/sbin:/sbin, and Homebrew, Volta and nvm all install elsewhere.
#
#   /bin/sh <package>/next/config/termd-launch.sh [termd flags…]
#
# It puts the usual toolchain directories on PATH (the sessions' shells inherit the daemon's
# environment before their startup files run), finds node on it (or TSM_NODE_BIN=/path/to/node),
# runs this package's daemon (or TSM_DAEMON=/path/to/daemon.js) and starts in $HOME. termd logs to
# stderr, which the supervisor keeps. The umask is left as the supervisor set it: the sessions'
# shells inherit it, so files a session creates get the usual permissions.
set -eu
: "${HOME:?HOME is not set}"
# Resolved before leaving the caller's directory, so a relative path to this script works as
# an absolute one does (the house's read of 59f660b, #22).
here=$(cd "$(dirname "$0")" && pwd)
cd "$HOME"

# Version $1 is newer than $2 (vX.Y.Z, compared number by number: v24.22 is newer than v24.9).
newer() {
  a=${1#v} b=${2#v}
  while [ -n "$a" ] || [ -n "$b" ]; do
    x=${a%%.*} y=${b%%.*}
    [ "${x:-0}" -gt "${y:-0}" ] 2>/dev/null && return 0
    [ "${x:-0}" -lt "${y:-0}" ] 2>/dev/null && return 1
    case $a in *.*) a=${a#*.} ;; *) a= ;; esac
    case $b in *.*) b=${b#*.} ;; *) b= ;; esac
  done
  return 1
}

# The bin directory of the newest node nvm has installed whose version begins with $1 (empty: any).
nvm_newest() {
  best=
  for v in "$dir"/versions/node/v*; do
    [ -x "$v/bin/node" ] || continue
    ver=${v##*/}
    if [ -n "$1" ]; then case "$ver." in "$1."*) ;; *) continue ;; esac; fi
    if [ -z "$best" ] || newer "$ver" "${best##*/}"; then best=$v; fi
  done
  [ -n "$best" ] && echo "$best/bin"
}

# nvm keeps each version under $NVM_DIR/versions/node/vX.Y.Z and names the one `nvm use`
# picks by default in alias/default: a version, the start of one (24, 24.22), `node`, or
# another alias (lts/* -> lts/jod -> v22.11.0). Its `current` link exists only when the user
# asked nvm for it, so the alias is followed as nvm follows it, with the shell's builtins
# alone (the house's read of 59f660b, #22). An alias nothing installed answers to falls back
# to the newest installed version.
nvm_bin() {
  dir=${NVM_DIR:-$HOME/.nvm}
  if [ -d "$dir/current/bin" ]; then echo "$dir/current/bin"; return 0; fi
  [ -d "$dir/versions/node" ] || return 1
  want=default hops=0
  while [ -f "$dir/alias/$want" ] && [ "$hops" -lt 8 ]; do
    read -r want < "$dir/alias/$want" || :
    hops=$((hops + 1))
  done
  case $want in
    system) return 1 ;;
    ''|node|stable|latest) pre= ;;
    v[0-9]*) pre=$want ;;
    *) pre=v$want ;;
  esac
  nvm_newest "$pre" || nvm_newest ''
}

# Prepended in reverse, so a version manager the user chose wins, then Homebrew, then /usr/local.
prepend() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) if [ -d "$1" ]; then PATH="$1:$PATH"; fi ;;
  esac
}
prepend /usr/local/bin
prepend /opt/homebrew/sbin
prepend /opt/homebrew/bin
prepend "$HOME/.local/bin"
if nvm=$(nvm_bin); then prepend "$nvm"; fi
prepend "$HOME/.volta/bin"
export PATH

daemon=${TSM_DAEMON:-"$here/../dist/src/daemon.js"}
node=${TSM_NODE_BIN:-$(command -v node || true)}
if [ -z "$node" ]; then
  echo "termd-launch: no node on PATH ($PATH); set TSM_NODE_BIN=/path/to/node" >&2
  exit 127
fi
if [ ! -f "$daemon" ]; then
  echo "termd-launch: $daemon not found; set TSM_DAEMON=/path/to/next/dist/src/daemon.js" >&2
  exit 127
fi
# The launcher's own settings go no further: termd reads neither, and the sessions inherit
# the daemon's environment.
unset TSM_NODE_BIN TSM_DAEMON

exec "$node" "$daemon" "$@"
