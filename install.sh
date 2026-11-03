#!/bin/bash
# Install Dynamic Island for the current user. No root needed, nothing outside $HOME.
#   ./install.sh          link this folder into GNOME's extension dir (for development)
#   ./install.sh --copy   copy it instead
set -euo pipefail

UUID="dynamic-island@buildscript-dev.github.io"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
FONTS="$HOME/.local/share/fonts/dynamic-island"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$FONTS"
cp -f "$SRC"/fonts/*.ttf "$FONTS/"
fc-cache -f "$FONTS" >/dev/null

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
if [ "${1:-}" = "--copy" ]; then
  mkdir -p "$DEST"
  cp -r "$SRC"/{metadata.json,extension.js,island.js,dbus.js,prefs.js,stylesheet.css,cava.conf,lib,services,views,schemas,sounds} "$DEST/"
else
  ln -s "$SRC" "$DEST"
fi

echo "Installed to $DEST"
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" && echo "Enabled."
else
  echo "Log out and back in once, then run: gnome-extensions enable $UUID"
fi
