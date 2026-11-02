#!/bin/bash
# Installs Emoji Panel for the current user.
set -euo pipefail

UUID=emoji-panel@joab
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
glib-compile-schemas "$DEST/schemas"

# Add to enabled-extensions without touching the others.
python3 - "$UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True)
enabled = ast.literal_eval(raw.replace('@as ', ''))
if uuid not in enabled:
    enabled.append(uuid)
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(enabled)])
EOF

echo "Instalado em $DEST"
echo "Saia da sessão e entre de novo para o GNOME carregar a extensão. Depois é só apertar Ctrl + ."
