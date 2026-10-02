#!/bin/sh
# termd for a supervisor (launchd, systemd), whose PATH has no node: launchd's is
# /usr/bin:/bin:/usr/sbin:/sbin, and Homebrew, Volta and nvm all install elsewhere.
#
#   /bin/sh <package>/next/config/termd-launch.sh [termd flags…]     e.g. --port 3101
#
# It puts the usual toolchain directories on PATH — process Runs inherit the daemon's
# environment (G7), so `npm test` must resolve there too — finds node on it (or
# TSM_NODE=/path/to/node), runs this package's daemon (or TSM_DAEMON=/path/to/daemon.js),
# starts in $HOME (sessions opened without a cwd start there as well), keeps every file it
# creates owner-only, and on macOS logs to ~/Library/Logs/termd/termd.log (0600, rotated by
# termd) unless --log-file is given. Under systemd the log stays on stderr, for the journal.
set -eu
umask 077
: "${HOME:?HOME is not set}"
cd "$HOME"

# Prepended in reverse, so a version manager the user chose wins, then Homebrew, then /usr/local.
for d in /usr/local/bin /opt/homebrew/sbin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.nvm/current/bin" "$HOME/.volta/bin"; do
  case ":$PATH:" in
    *":$d:"*) ;;
    *) if [ -d "$d" ]; then PATH="$d:$PATH"; fi ;;
  esac
done
export PATH

here=$(cd "$(dirname "$0")" && pwd)
daemon=${TSM_DAEMON:-"$here/../dist/src/daemon.js"}
node=${TSM_NODE:-$(command -v node || true)}
if [ -z "$node" ]; then
  echo "termd-launch: no node on PATH ($PATH); set TSM_NODE=/path/to/node" >&2
  exit 127
fi
if [ ! -f "$daemon" ]; then
  echo "termd-launch: $daemon not found; set TSM_DAEMON=/path/to/next/dist/src/daemon.js" >&2
  exit 127
fi

case " $* " in
  *" --log-file "* | *" --log-file="*) ;;
  *) if [ "$(uname -s)" = Darwin ]; then set -- "$@" --log-file "$HOME/Library/Logs/termd/termd.log"; fi ;;
esac
exec "$node" "$daemon" "$@"
