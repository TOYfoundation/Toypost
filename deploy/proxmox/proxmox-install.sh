#!/usr/bin/env bash
# Dokufy: Installation mit einem Befehl auf einem Proxmox-Host.
# Holt Dokufy von GitHub, legt eine Debian-13-VM an, installiert darin Docker und alle Dienste
# und verknüpft Paperless-ngx, Nextcloud, n8n und die Dokufy-Engine.
#
# Aufruf als root in der Shell des Proxmox-Hosts:  bash proxmox-install.sh
# Darf mehrfach laufen: Antworten werden gemerkt, eine vorhandene VM wird weiterverwendet.
# Ohne Rückfragen: alle Angaben als Umgebungsvariablen setzen (siehe "Angaben") und DOKUFY_JA=1.
set -euo pipefail

REPO=${DOKUFY_REPO:-Safehaigit/dokufy}
REF=${DOKUFY_REF:-main}
GITHUB_API=${DOKUFY_GITHUB_API:-https://api.github.com}
WORK=${DOKUFY_WORK:-/root/dokufy-install}
IMAGE_URL=${DOKUFY_IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2}
IMAGE_DIR=${DOKUFY_IMAGE_DIR:-/var/lib/vz/template}
VM_USER=dokufy

schritt() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$*"; }
hinweis() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fehler()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fehler "Bitte als root in der Shell des Proxmox-Hosts starten."
for t in qm pvesm pvesh curl wget tar ssh scp ssh-keygen openssl ip ping awk; do
  command -v "$t" >/dev/null || fehler "$t fehlt. Läuft das Skript wirklich auf einem Proxmox-Host?"
done
mkdir -p "$WORK"
chmod 700 "$WORK"
exec > >(tee -a "$WORK/install.log") 2>&1

# Rückfragen kommen vom Terminal, auch wenn das Skript per Pipe gestartet wurde
AUTO=${DOKUFY_JA:-0}
if [ "$AUTO" != 1 ] && { exec 3</dev/tty; } 2>/dev/null; then :; else AUTO=1; exec 3</dev/null; fi

frage() { # Variable, Frage, Vorgabe
  local var=$1 text=$2 vorgabe=${3:-} antwort=""
  [ -n "${!var:-}" ] && return 0
  if [ "$AUTO" != 1 ]; then read -r -p "  $text${vorgabe:+ [$vorgabe]}: " antwort <&3 || true; fi
  printf -v "$var" '%s' "${antwort:-$vorgabe}"
}
geheim() { # Variable, Frage
  local var=$1 text=$2 antwort=""
  [ -n "${!var:-}" ] && return 0
  if [ "$AUTO" != 1 ]; then read -r -s -p "  $text: " antwort <&3 || true; echo; fi
  printf -v "$var" '%s' "$antwort"
}

# ---------- Gemerkte Antworten eines früheren Laufs ----------
ANGABEN_DATEI=$WORK/angaben
GEMERKT=(DOKUFY_VMID DOKUFY_STORAGE DOKUFY_BRIDGE DOKUFY_IP DOKUFY_GATEWAY DOKUFY_DNS DOKUFY_CORES DOKUFY_RAM DOKUFY_DISK
  DOKUFY_DOMAIN DOKUFY_ACME_EMAIL DOKUFY_NAME DOKUFY_EMAIL DOKUFY_PASSWORT DOKUFY_KI DOKUFY_SSHKEY DOKUFY_BACKUP)
if [ -f "$ANGABEN_DATEI" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    [[ " ${GEMERKT[*]} " == *" $key "* ]] || continue
    [ -n "${!key:-}" ] || printf -v "$key" '%s' "${line#*=}"
  done < "$ANGABEN_DATEI"
  hinweis "Antworten vom letzten Lauf übernommen ($ANGABEN_DATEI)"
fi

# ---------- Angaben ----------
schritt "Angaben (Enter übernimmt den Vorschlag in Klammern)"
frage DOKUFY_BRIDGE "Netzwerkbrücke" vmbr0
host_net=$(ip -4 -o addr show dev "$DOKUFY_BRIDGE" 2>/dev/null | awk '{print $4; exit}')
[ -n "$host_net" ] || fehler "Die Brücke $DOKUFY_BRIDGE hat keine IPv4-Adresse. Andere Brücke angeben: DOKUFY_BRIDGE=vmbrX"
vorschlag_ip="$(echo "${host_net%/*}" | cut -d. -f1-3).50/${host_net#*/}"
frage DOKUFY_IP "Feste IP der VM mit Netzmaske" "$vorschlag_ip"
[[ "$DOKUFY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || fehler "IP bitte in der Form 192.168.1.50/24 angeben."
VM_IP=${DOKUFY_IP%/*}
frage DOKUFY_GATEWAY "Gateway (Router)" "$(ip -4 route show default | awk '{print $3; exit}')"
frage DOKUFY_DNS "DNS-Server" "$DOKUFY_GATEWAY"
frage DOKUFY_DOMAIN "Domain für die Dienste" dokufy.lan
if [[ "$DOKUFY_DOMAIN" != *.lan && "$DOKUFY_DOMAIN" != *.local && "$DOKUFY_DOMAIN" != *.home.arpa && "$DOKUFY_DOMAIN" != *.internal ]]; then
  frage DOKUFY_ACME_EMAIL "E-Mail für Let's-Encrypt-Zertifikate (leer = eigene Zertifikate im Heimnetz)" ""
fi
frage DOKUFY_NAME "Dein Name" ""
[ -n "$DOKUFY_NAME" ] || fehler "Bitte einen Namen angeben (DOKUFY_NAME)."
frage DOKUFY_EMAIL "Deine E-Mail-Adresse" ""
[[ "$DOKUFY_EMAIL" == ?*@?*.?* ]] || fehler "Bitte eine gültige E-Mail-Adresse angeben (DOKUFY_EMAIL)."
if [ -z "${DOKUFY_KI:-}" ] && [ "$AUTO" != 1 ]; then
  echo "  KI für die Auswertung:  1) ohne KI, nur Regeln   2) Claude (API-Schlüssel nötig)   3) lokal mit Ollama (16 GB RAM)"
  frage ki_wahl "Auswahl" 1
  case "$ki_wahl" in 2) DOKUFY_KI=anthropic ;; 3) DOKUFY_KI=ollama ;; *) DOKUFY_KI=mock ;; esac
fi
DOKUFY_KI=${DOKUFY_KI:-mock}
[[ "$DOKUFY_KI" =~ ^(mock|anthropic|ollama)$ ]] || fehler "DOKUFY_KI muss mock, anthropic oder ollama sein."
if [ "$DOKUFY_KI" = anthropic ]; then
  geheim ANTHROPIC_API_KEY "Claude-API-Schlüssel (Enter = später eintragen)"
fi
frage DOKUFY_SSHKEY "Dein öffentlicher SSH-Schlüssel für die VM (Enter = nur vom Proxmox-Host aus)" ""
frage DOKUFY_VMID "VM-Nummer" "$(pvesh get /cluster/nextid)"
storage_vorschlag=$(pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -x local-lvm || pvesm status --content images | awk 'NR>1 && $3=="active" {print $1; exit}')
frage DOKUFY_STORAGE "Speicher für die VM-Platte" "$storage_vorschlag"
frage DOKUFY_CORES "CPU-Kerne" 4
[ "$DOKUFY_KI" = ollama ] && ram_vorschlag=16384 || ram_vorschlag=8192
frage DOKUFY_RAM "Arbeitsspeicher in MB" "$ram_vorschlag"
frage DOKUFY_DISK "Plattengröße in GB" 100
frage DOKUFY_BACKUP "Tägliches Backup der VM um 02:30 einrichten? (ja/nein)" ja
DOKUFY_PASSWORT=${DOKUFY_PASSWORT:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}

umask 077
: > "$ANGABEN_DATEI"
for key in "${GEMERKT[@]}"; do printf '%s=%s\n' "$key" "${!key:-}" >> "$ANGABEN_DATEI"; done
umask 022
ok "Angaben gespeichert"

# ---------- Dokufy von GitHub holen ----------
schritt "Dokufy von GitHub holen ($REPO, $REF)"
TARBALL=$WORK/dokufy-src.tar.gz
hole_quellcode() {
  local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -sS -L "${auth[@]}" -H 'Accept: application/vnd.github+json' -o "$TARBALL" -w '%{http_code}' \
    "$GITHUB_API/repos/$REPO/tarball/$REF" || echo 000
}
code=$(hole_quellcode)
if [[ "$code" =~ ^(401|403|404)$ ]] && [ -z "${GITHUB_TOKEN:-}" ]; then
  hinweis "Das Repository ist privat oder nicht erreichbar."
  geheim GITHUB_TOKEN "GitHub-Token mit Lesezugriff auf $REPO"
  [ -n "${GITHUB_TOKEN:-}" ] && code=$(hole_quellcode)
fi
[ "$code" = 200 ] || fehler "GitHub antwortet mit $code für $REPO@$REF. Stimmen Repository, Zweig und Token?"
tar xzf "$TARBALL" -O --wildcards '*/deploy/proxmox/vm-setup.sh' > "$WORK/vm-setup.sh" 2>/dev/null || true
[ -s "$WORK/vm-setup.sh" ] || fehler "Im Archiv fehlt deploy/proxmox/vm-setup.sh. Ist $REF der richtige Zweig?"
ok "Quellcode geladen ($(du -h "$TARBALL" | cut -f1))"

# ---------- SSH-Schlüssel des Hosts für die VM ----------
[ -f "$WORK/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "proxmox-dokufy-install" -f "$WORK/id_ed25519"
{ cat "$WORK/id_ed25519.pub"; [ -n "$DOKUFY_SSHKEY" ] && echo "$DOKUFY_SSHKEY"; } > "$WORK/ssh-keys.pub"
SSH_OPTS=(-i "$WORK/id_ed25519" -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=30
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$WORK/known_hosts")
vm_ssh() { ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }

# ---------- VM ----------
VMID=$DOKUFY_VMID
if qm status "$VMID" >/dev/null 2>&1; then
  schritt "VM $VMID ist schon vorhanden"
  name=$(qm config "$VMID" | awk '/^name:/ {print $2}')
  [ "$name" = dokufy ] || fehler "VM $VMID heißt \"$name\", nicht \"dokufy\". Andere Nummer wählen: DOKUFY_VMID=..."
  qm status "$VMID" | grep -q running || qm start "$VMID"
  ok "VM läuft"
else
  schritt "VM $VMID anlegen"
  if ping -c1 -W1 "$VM_IP" >/dev/null 2>&1; then
    fehler "Die Adresse $VM_IP ist schon belegt. Andere IP wählen: DOKUFY_IP=... oder Zeile in $ANGABEN_DATEI ändern."
  fi
  mkdir -p "$IMAGE_DIR"
  image="$IMAGE_DIR/$(basename "$IMAGE_URL")"
  wget -q --show-progress -N -P "$IMAGE_DIR" "$IMAGE_URL"
  ok "Debian-13-Cloud-Image bereit"
  qm create "$VMID" --name dokufy --memory "$DOKUFY_RAM" --cores "$DOKUFY_CORES" --cpu host \
    --net0 "virtio,bridge=$DOKUFY_BRIDGE" --ostype l26 --scsihw virtio-scsi-single \
    --agent enabled=1 --serial0 socket --vga serial0 \
    --description "Dokufy: Paperless-ngx, Nextcloud, n8n. Angelegt am $(date +%F) mit proxmox-install.sh"
  qm disk import "$VMID" "$image" "$DOKUFY_STORAGE" >/dev/null
  disk=$(qm config "$VMID" | awk '/^unused0:/ {print $2}')
  [ -n "$disk" ] || fehler "Die importierte Platte wurde nicht gefunden (qm config $VMID)."
  qm set "$VMID" --scsi0 "$disk,discard=on,iothread=1,ssd=1" >/dev/null
  qm resize "$VMID" scsi0 "${DOKUFY_DISK}G" >/dev/null
  qm set "$VMID" --ide2 "$DOKUFY_STORAGE:cloudinit" --boot order=scsi0 >/dev/null
  qm set "$VMID" --ciuser "$VM_USER" --sshkeys "$WORK/ssh-keys.pub" \
    --ipconfig0 "ip=$DOKUFY_IP,gw=$DOKUFY_GATEWAY" --nameserver "$DOKUFY_DNS" >/dev/null
  qm set "$VMID" --onboot 1 >/dev/null
  qm start "$VMID"
  ok "VM $VMID gestartet: $DOKUFY_CORES Kerne, $DOKUFY_RAM MB RAM, $DOKUFY_DISK GB auf $DOKUFY_STORAGE, IP $VM_IP"
fi

schritt "Warte auf die VM ($VM_IP)"
for _ in $(seq 1 60); do
  vm_ssh true 2>/dev/null && break
  sleep 5
done
vm_ssh true || fehler "Keine SSH-Verbindung zu $VM_IP. Stimmen IP, Gateway und Brücke? Konsole: qm terminal $VMID"
ok "VM erreichbar"

# ---------- Einrichtung in der VM ----------
schritt "Dokufy in der VM einrichten"
umask 077
cat > "$WORK/vm-angaben.env" <<EOF
DOMAIN=$DOKUFY_DOMAIN
ADMIN_NAME=$DOKUFY_NAME
ADMIN_EMAIL=$DOKUFY_EMAIL
ADMIN_PASSWORD=$DOKUFY_PASSWORT
ACME_EMAIL=${DOKUFY_ACME_EMAIL:-}
AI_PROVIDER=$DOKUFY_KI
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OLLAMA_MODEL=${OLLAMA_MODEL:-qwen3:8b}
EOF
umask 022
scp -q "${SSH_OPTS[@]}" "$TARBALL" "$WORK/vm-setup.sh" "$WORK/vm-angaben.env" "$VM_USER@$VM_IP:/tmp/"
rm -f "$WORK/vm-angaben.env"
vm_ssh "sudo bash /tmp/vm-setup.sh /tmp/dokufy-src.tar.gz /tmp/vm-angaben.env $VM_USER" \
  || fehler "Die Einrichtung in der VM ist abgebrochen (Meldung oben). Nach dem Beheben dieses Skript einfach erneut starten."

# ---------- Backup ----------
if [[ "$DOKUFY_BACKUP" =~ ^[jJyY] ]]; then
  schritt "Backup"
  if pvesh get /cluster/backup --output-format json 2>/dev/null | tr -d ' ' | grep -q "\"vmid\":\"$VMID\""; then
    ok "Backup-Job für VM $VMID ist schon vorhanden"
  else
    backup_storage=$(pvesm status --content backup 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')
    if [ -n "$backup_storage" ]; then
      pvesh create /cluster/backup --schedule "02:30" --vmid "$VMID" --storage "$backup_storage" \
        --mode snapshot --compress zstd --prune-backups keep-daily=7,keep-weekly=4 --enabled 1 >/dev/null
      ok "Täglich 02:30 auf $backup_storage, 7 tägliche und 4 wöchentliche Stände"
    else
      hinweis "Kein Speicher für Backups gefunden. In der Weboberfläche unter Rechenzentrum → Backup einrichten."
    fi
  fi
fi

# ---------- Zusammenfassung ----------
passwort=$(vm_ssh "grep -m1 '^ADMIN_PASSWORD=' /opt/dokufy/.env | cut -d= -f2-")
umask 077
cat > "$WORK/zugaenge.txt" <<EOF
Dokufy auf Proxmox, VM $VMID ($VM_IP), eingerichtet am $(date '+%F %H:%M')

Paperless   https://paperless.$DOKUFY_DOMAIN
Nextcloud   https://cloud.$DOKUFY_DOMAIN
n8n         https://n8n.$DOKUFY_DOMAIN   (Inhaber beim ersten Aufruf anlegen)
Dokufy-API  https://dokufy.$DOKUFY_DOMAIN

Benutzer    admin   (Dokufy-Konto: $DOKUFY_EMAIL)
Passwort    $passwort

Eintrag für Router-DNS oder hosts-Datei:
$VM_IP  paperless.$DOKUFY_DOMAIN cloud.$DOKUFY_DOMAIN n8n.$DOKUFY_DOMAIN dokufy.$DOKUFY_DOMAIN

Anmelden an der VM vom Proxmox-Host:  ssh -i $WORK/id_ed25519 $VM_USER@$VM_IP
EOF
[ -n "$DOKUFY_SSHKEY" ] && echo "Anmelden an der VM von deinem Rechner:  ssh $VM_USER@$VM_IP" >> "$WORK/zugaenge.txt"
umask 022
schritt "Fertig"
cat "$WORK/zugaenge.txt"
echo
echo "Diese Übersicht liegt auch in $WORK/zugaenge.txt (nur für root lesbar)."
