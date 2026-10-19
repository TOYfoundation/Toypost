#!/usr/bin/env bash
# Dokufy: richtet eine frische Debian-VM komplett ein (Docker, Dateien, .env, Dienste, Verknüpfungen).
# Wird von proxmox-install.sh auf dem Proxmox-Host aufgerufen; von Hand:
#   sudo bash vm-setup.sh <dokufy-src.tar.gz> <angaben.env> <benutzer>
# Darf mehrfach laufen: vorhandene Einstellungen (.env) und Daten bleiben erhalten.
set -euo pipefail

TARBALL=$1
ANGABEN=$2
RUNUSER_NAME=${3:-dokufy}
BASE=${DOKUFY_BASE:-/opt/dokufy}

schritt() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fehler()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fehler "Bitte mit sudo starten."
[ -f "$TARBALL" ] || fehler "Quellcode-Archiv $TARBALL fehlt."
[ -f "$ANGABEN" ] || fehler "Angaben-Datei $ANGABEN fehlt."
id "$RUNUSER_NAME" >/dev/null 2>&1 || fehler "Benutzer $RUNUSER_NAME gibt es nicht."

# Angaben lesen (KEY=Wert je Zeile, ohne Shell-Auswertung)
declare -A A
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  A[${line%%=*}]=${line#*=}
done < "$ANGABEN"
for k in DOMAIN ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD AI_PROVIDER; do
  [ -n "${A[$k]:-}" ] || fehler "In den Angaben fehlt $k."
done

# ---------- 1. System und Docker ----------
schritt "System vorbereiten"
command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1 || true
export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-yq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt-get update -q >/dev/null
apt-get "${APT_OPTS[@]}" full-upgrade >/dev/null
apt-get "${APT_OPTS[@]}" install ca-certificates curl git jq unzip openssl nano qemu-guest-agent >/dev/null
systemctl start qemu-guest-agent 2>/dev/null || true
ok "Pakete aktuell, QEMU-Agent läuft"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -q >/dev/null
  apt-get "${APT_OPTS[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
usermod -aG docker "$RUNUSER_NAME"
ok "Docker $(docker compose version --short 2>/dev/null || echo bereit)"

# ---------- 2. Dateien ----------
schritt "Dokufy-Dateien nach $BASE"
mkdir -p "$BASE"
rm -rf "$BASE/src.neu"
mkdir -p "$BASE/src.neu"
tar xzf "$TARBALL" -C "$BASE/src.neu" --strip-components=1
[ -f "$BASE/src.neu/deploy/proxmox/compose.yml" ] || fehler "Das Archiv enthält kein deploy/proxmox/compose.yml."
rm -rf "$BASE/src.alt"
[ -d "$BASE/src" ] && mv "$BASE/src" "$BASE/src.alt"
mv "$BASE/src.neu" "$BASE/src"
rm -rf "$BASE/src.alt"
cp -r "$BASE/src/deploy/proxmox/." "$BASE/"
chmod +x "$BASE/einrichten.sh"
mkdir -p "$BASE/data/eingang" "$BASE/data/export"
chown -R 33:33 "$BASE/data"
ok "Quellcode in $BASE/src, Betriebsdateien in $BASE"

# ---------- 3. Einstellungen ----------
schritt "Einstellungen (.env)"
zufall() { openssl rand -hex "$1"; }
sauber() { printf '%s' "$1" | tr -d '"$`\\\r\n'; }
if [ -f "$BASE/.env" ]; then
  ok ".env ist schon vorhanden und bleibt unverändert"
else
  profile=""
  [ "${A[AI_PROVIDER]}" = ollama ] && profile=ollama
  umask 077
  cat > "$BASE/.env" <<EOF
# Erzeugt von vm-setup.sh am $(date +%F)
# --- deine Angaben ---
DOMAIN=$(sauber "${A[DOMAIN]}")
ADMIN_USER=admin
ADMIN_NAME="$(sauber "${A[ADMIN_NAME]}")"
ADMIN_EMAIL=$(sauber "${A[ADMIN_EMAIL]}")
ADMIN_PASSWORD=$(sauber "${A[ADMIN_PASSWORD]}")
# leer = Heimnetz mit eigenen Zertifikaten; sonst Let's Encrypt mit dieser Adresse
ACME_EMAIL=$(sauber "${A[ACME_EMAIL]:-}")

# --- KI: mock (nur Regeln), anthropic (Claude) oder ollama (lokal) ---
AI_PROVIDER=$(sauber "${A[AI_PROVIDER]}")
ANTHROPIC_API_KEY=$(sauber "${A[ANTHROPIC_API_KEY]:-}")
OLLAMA_MODEL=$(sauber "${A[OLLAMA_MODEL]:-qwen3:8b}")
COMPOSE_PROFILES=$profile

# --- Geheimnisse, automatisch erzeugt; nicht weitergeben ---
DOKUFY_SECRET=$(zufall 32)
PAPERLESS_SECRET_KEY=$(zufall 32)
PAPERLESS_DB_PASSWORD=$(zufall 16)
NEXTCLOUD_DB_PASSWORD=$(zufall 16)
N8N_ENCRYPTION_KEY=$(zufall 32)
EOF
  umask 022
  ok ".env mit neuen Geheimnissen angelegt"
fi
chmod 600 "$BASE/.env"
env_wert() { grep -m1 "^$1=" "$BASE/.env" | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/'; }

# Öffentliche Domain: Let's Encrypt statt eigener Zertifikate
acme=$(env_wert ACME_EMAIL || true)
if [ -n "$acme" ]; then
  sed -i "s/^\tlocal_certs$/\temail $acme/" "$BASE/Caddyfile"
  ok "Caddy holt Zertifikate von Let's Encrypt für $(env_wert DOMAIN)"
fi
chown -R "$RUNUSER_NAME:$RUNUSER_NAME" "$BASE/src" "$BASE/.env" "$BASE/compose.yml" "$BASE/Caddyfile" "$BASE/einrichten.sh" "$BASE/n8n"
[ -d "$BASE/.einrichtung" ] && chown -R "$RUNUSER_NAME:$RUNUSER_NAME" "$BASE/.einrichtung"
chown "$RUNUSER_NAME:$RUNUSER_NAME" "$BASE"

# ---------- 4. Dienste ----------
schritt "Dienste starten (beim ersten Mal 5 bis 15 Minuten)"
cd "$BASE"
docker compose up -d --build --remove-orphans
ok "Alle Container gestartet"
if [ "$(env_wert AI_PROVIDER)" = ollama ]; then
  modell=$(env_wert OLLAMA_MODEL)
  docker compose exec -T ollama ollama pull "${modell:-qwen3:8b}" >/dev/null
  ok "Lokales KI-Modell ${modell:-qwen3:8b} geladen"
fi

# Wöchentlicher Paperless-Export als lesbare Zweitsicherung
cat > /etc/cron.d/dokufy-export <<EOF
0 3 * * 0 $RUNUSER_NAME cd $BASE && docker compose exec -T paperless document_exporter ../export -d >/dev/null 2>&1
EOF
ok "Wöchentlicher Paperless-Export nach $BASE/data/export eingeplant"

# ---------- 5. Verknüpfungen ----------
runuser -u "$RUNUSER_NAME" -- ./einrichten.sh

rm -f "$ANGABEN" "$TARBALL"
[ "$0" = /tmp/vm-setup.sh ] && rm -f "$0"
true
