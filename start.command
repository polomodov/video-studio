#!/bin/bash
set -euo pipefail
SHORTS_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SHORTS_MISE="$(command -v mise || true)"
if [[ -z "$SHORTS_MISE" ]]; then
  for SHORTS_CANDIDATE in "$HOME/.local/bin/mise" /opt/homebrew/bin/mise /usr/local/bin/mise; do
    if [[ -x "$SHORTS_CANDIDATE" ]]; then
      SHORTS_MISE="$SHORTS_CANDIDATE"
      break
    fi
  done
fi

if [[ -n "$SHORTS_MISE" && "$(uname -s)" == Darwin ]]; then
  # Resolve the managed tools before adding the Shorts cache to PATH.
  exec "$SHORTS_MISE" --cd "$SHORTS_SCRIPT_DIR" exec -- /bin/bash -c '
    set -euo pipefail
    node="$(command -v node)"
    SHORTS_FFMPEG="${SHORTS_FFMPEG:-$(command -v ffmpeg)}"
    SHORTS_FFPROBE="${SHORTS_FFPROBE:-$(command -v ffprobe)}"
    export SHORTS_FFMPEG SHORTS_FFPROBE
    export PATH="$(dirname "$node"):$HOME/.cache/shorts-studio/bin:$PATH"
    cd -- "$1"
    shift
    exec "$node" "$@"
  ' bash "$PWD" "$SHORTS_SCRIPT_DIR/src/cli.mjs" serve "$@"
fi

if [[ -n "$SHORTS_MISE" ]]; then
  echo 'Закреплённая сборка mise поддерживает macOS. Используются локальные Node.js и FFmpeg из PATH.' >&2
else
  echo 'mise не найден. Используются локальные Node.js и FFmpeg.' >&2
fi
SHORTS_NODE="$(command -v node || true)"
if [[ -z "$SHORTS_NODE" ]]; then
  for SHORTS_CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$SHORTS_CANDIDATE" ]]; then SHORTS_NODE="$SHORTS_CANDIDATE"; break; fi
  done
fi
if [[ -z "$SHORTS_NODE" ]]; then
  echo 'Нужен Node.js 24 или новее.' >&2
  exit 1
fi
export PATH="$HOME/.cache/shorts-studio/bin:$(dirname "$SHORTS_NODE"):$PATH"
exec "$SHORTS_NODE" "$SHORTS_SCRIPT_DIR/src/cli.mjs" serve "$@"
