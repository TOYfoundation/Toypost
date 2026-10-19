#!/usr/bin/env bash
# Erzeugt den Ein-Block-Installer ohne GitHub: ein Shell-Block, der Installer, Betriebsdateien und den
# Dokufy-Quellcode als geprüftes Archiv enthält. Ausgabe: dist/dokufy-proxmox-block.sh
# Aufruf im Repository:  deploy/proxmox/block-erstellen.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DATEIEN=(apps/api/Dockerfile apps/api/package.json apps/api/src packages/shared/package.json packages/shared/src deploy/proxmox)
for f in "${DATEIEN[@]}"; do [ -e "$f" ] || { echo "fehlt: $f" >&2; exit 1; }; done

version=$(git describe --always --dirty 2>/dev/null || echo unbekannt)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Feste Zeitstempel und Besitzer: gleicher Stand ergibt dasselbe Paket
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' \
  --exclude='deploy/proxmox/dist' --transform 's,^,dokufy/,' -cf "$tmp/paket.tar" "${DATEIEN[@]}"
gzip -9n < "$tmp/paket.tar" > "$tmp/paket.tar.gz"
summe=$(sha256sum "$tmp/paket.tar.gz" | cut -d' ' -f1)

mkdir -p dist
ziel=dist/dokufy-proxmox-block.sh
{
  cat <<EOF
# Dokufy – Installation auf Proxmox ohne GitHub (Stand $version, erstellt $(date +%F))
# Den GESAMTEN Block in die Shell des Proxmox-Hosts einfügen (als root) und, falls nötig, Enter drücken.
# Er enthält Installer, Betriebsdateien und Dokufy-Quellcode; danach stellt der Installer seine Fragen.
mkdir -p /root/dokufy-install && base64 -d > /root/dokufy-install/dokufy-paket.tar.gz <<'DOKUFY_PAKET'
EOF
  base64 -w 76 "$tmp/paket.tar.gz"
  cat <<EOF
DOKUFY_PAKET
if echo "$summe  /root/dokufy-install/dokufy-paket.tar.gz" | sha256sum -c --quiet 2>/dev/null; then tar xzf /root/dokufy-install/dokufy-paket.tar.gz -O dokufy/deploy/proxmox/proxmox-install.sh > /root/dokufy-install.sh && DOKUFY_QUELLE=/root/dokufy-install/dokufy-paket.tar.gz bash /root/dokufy-install.sh; else echo "Der Block kam beim Einfügen nicht vollständig an (Prüfsumme falsch). Bitte den ganzen Block neu kopieren und einfügen."; fi
EOF
} > "$ziel"
echo "$ziel: $(wc -l < "$ziel") Zeilen, $(du -h "$ziel" | cut -f1), Paket $summe"
