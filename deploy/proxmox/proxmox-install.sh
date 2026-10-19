#!/usr/bin/env bash
# ToyPost: Installation mit einem Befehl auf einem Proxmox-Host.
# Holt ToyPost von GitHub, legt eine Debian-13-VM an, installiert darin Docker und alle Dienste
# und verknüpft Paperless-ngx, Nextcloud, n8n und die ToyPost-Engine.
#
# Aufruf als root in der Shell des Proxmox-Hosts:  bash proxmox-install.sh
# Darf mehrfach laufen: Antworten werden gemerkt, eine vorhandene VM wird weiterverwendet.
# Ohne Rückfragen: alle Angaben als Umgebungsvariablen setzen (siehe "Angaben") und TOYPOST_JA=1.
set -euo pipefail

REPO=${TOYPOST_REPO:-Safehaigit/toypost}
REF=${TOYPOST_REF:-main}
GITHUB_API=${TOYPOST_GITHUB_API:-https://api.github.com}
WORK=${TOYPOST_WORK:-/root/toypost-install}
IMAGE_URL=${TOYPOST_IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2}
IMAGE_DIR=${TOYPOST_IMAGE_DIR:-/var/lib/vz/template}
VM_USER=toypost

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
AUTO=${TOYPOST_JA:-0}
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
GEMERKT=(TOYPOST_VMID TOYPOST_STORAGE TOYPOST_BRIDGE TOYPOST_IP TOYPOST_GATEWAY TOYPOST_DNS TOYPOST_CORES TOYPOST_RAM TOYPOST_DISK
  TOYPOST_DOMAIN TOYPOST_ACME_EMAIL TOYPOST_NAME TOYPOST_EMAIL TOYPOST_PASSWORT TOYPOST_KI TOYPOST_SSHKEY TOYPOST_BACKUP)
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
frage TOYPOST_BRIDGE "Netzwerkbrücke" vmbr0
host_net=$(ip -4 -o addr show dev "$TOYPOST_BRIDGE" 2>/dev/null | awk '{print $4; exit}')
[ -n "$host_net" ] || fehler "Die Brücke $TOYPOST_BRIDGE hat keine IPv4-Adresse. Andere Brücke angeben: TOYPOST_BRIDGE=vmbrX"
vorschlag_ip="$(echo "${host_net%/*}" | cut -d. -f1-3).50/${host_net#*/}"
frage TOYPOST_IP "Feste IP der VM mit Netzmaske" "$vorschlag_ip"
[[ "$TOYPOST_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || fehler "IP bitte in der Form 192.168.1.50/24 angeben."
VM_IP=${TOYPOST_IP%/*}
frage TOYPOST_GATEWAY "Gateway (Router)" "$(ip -4 route show default | awk '{print $3; exit}')"
frage TOYPOST_DNS "DNS-Server" "$TOYPOST_GATEWAY"
frage TOYPOST_DOMAIN "Domain für die Dienste" toypost.lan
if [[ "$TOYPOST_DOMAIN" != *.lan && "$TOYPOST_DOMAIN" != *.local && "$TOYPOST_DOMAIN" != *.home.arpa && "$TOYPOST_DOMAIN" != *.internal ]]; then
  frage TOYPOST_ACME_EMAIL "E-Mail für Let's-Encrypt-Zertifikate (leer = eigene Zertifikate im Heimnetz)" ""
fi
frage TOYPOST_NAME "Dein Name" ""
[ -n "$TOYPOST_NAME" ] || fehler "Bitte einen Namen angeben (TOYPOST_NAME)."
frage TOYPOST_EMAIL "Deine E-Mail-Adresse" ""
[[ "$TOYPOST_EMAIL" == ?*@?*.?* ]] || fehler "Bitte eine gültige E-Mail-Adresse angeben (TOYPOST_EMAIL)."
if [ -z "${TOYPOST_KI:-}" ] && [ "$AUTO" != 1 ]; then
  echo "  KI für die Auswertung:  1) ohne KI, nur Regeln   2) Claude (API-Schlüssel nötig)   3) lokal mit Ollama (16 GB RAM)"
  frage ki_wahl "Auswahl" 1
  case "$ki_wahl" in 2) TOYPOST_KI=anthropic ;; 3) TOYPOST_KI=ollama ;; *) TOYPOST_KI=mock ;; esac
fi
TOYPOST_KI=${TOYPOST_KI:-mock}
[[ "$TOYPOST_KI" =~ ^(mock|anthropic|ollama)$ ]] || fehler "TOYPOST_KI muss mock, anthropic oder ollama sein."
if [ "$TOYPOST_KI" = anthropic ]; then
  geheim ANTHROPIC_API_KEY "Claude-API-Schlüssel (Enter = später eintragen)"
fi
frage TOYPOST_SSHKEY "Dein öffentlicher SSH-Schlüssel für die VM (Enter = nur vom Proxmox-Host aus)" ""
frage TOYPOST_VMID "VM-Nummer" "$(pvesh get /cluster/nextid)"
storage_vorschlag=$(pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -x local-lvm || pvesm status --content images | awk 'NR>1 && $3=="active" {print $1; exit}')
frage TOYPOST_STORAGE "Speicher für die VM-Platte" "$storage_vorschlag"
frage TOYPOST_CORES "CPU-Kerne" 4
[ "$TOYPOST_KI" = ollama ] && ram_vorschlag=16384 || ram_vorschlag=8192
frage TOYPOST_RAM "Arbeitsspeicher in MB" "$ram_vorschlag"
frage TOYPOST_DISK "Plattengröße in GB" 100
frage TOYPOST_BACKUP "Tägliches Backup der VM um 02:30 einrichten? (ja/nein)" ja
TOYPOST_PASSWORT=${TOYPOST_PASSWORT:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}

umask 077
: > "$ANGABEN_DATEI"
for key in "${GEMERKT[@]}"; do printf '%s=%s\n' "$key" "${!key:-}" >> "$ANGABEN_DATEI"; done
umask 022
ok "Angaben gespeichert"

# ---------- Quellcode: mitgeliefertes Paket oder GitHub ----------
TARBALL=$WORK/toypost-src.tar.gz
if [ -n "${TOYPOST_QUELLE:-}" ]; then
  schritt "ToyPost-Paket aus dem Block verwenden"
  [ -f "$TOYPOST_QUELLE" ] || fehler "Paket $TOYPOST_QUELLE fehlt."
  [ "$TOYPOST_QUELLE" -ef "$TARBALL" ] || cp "$TOYPOST_QUELLE" "$TARBALL"
else
  schritt "ToyPost von GitHub holen ($REPO, $REF)"
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
fi
tar xzf "$TARBALL" -O --wildcards '*/deploy/proxmox/vm-setup.sh' > "$WORK/vm-setup.sh" 2>/dev/null || true
[ -s "$WORK/vm-setup.sh" ] || fehler "Im Archiv fehlt deploy/proxmox/vm-setup.sh. Ist das Paket vollständig bzw. $REF der richtige Zweig?"
ok "Quellcode geladen ($(du -h "$TARBALL" | cut -f1))"

# ---------- SSH-Schlüssel des Hosts für die VM ----------
[ -f "$WORK/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "proxmox-toypost-install" -f "$WORK/id_ed25519"
{ cat "$WORK/id_ed25519.pub"; [ -n "$TOYPOST_SSHKEY" ] && echo "$TOYPOST_SSHKEY"; } > "$WORK/ssh-keys.pub"
SSH_OPTS=(-i "$WORK/id_ed25519" -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=30
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$WORK/known_hosts")
vm_ssh() { ssh -n "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }

# ---------- VM ----------
VMID=$TOYPOST_VMID
if qm status "$VMID" >/dev/null 2>&1; then
  schritt "VM $VMID ist schon vorhanden"
  name=$(qm config "$VMID" | awk '/^name:/ {print $2}')
  [ "$name" = toypost ] || fehler "VM $VMID heißt \"$name\", nicht \"toypost\". Andere Nummer wählen: TOYPOST_VMID=..."
  qm status "$VMID" | grep -q running || qm start "$VMID"
  ok "VM läuft"
else
  schritt "VM $VMID anlegen"
  if ping -c1 -W1 "$VM_IP" >/dev/null 2>&1; then
    fehler "Die Adresse $VM_IP ist schon belegt. Andere IP wählen: TOYPOST_IP=... oder Zeile in $ANGABEN_DATEI ändern."
  fi
  mkdir -p "$IMAGE_DIR"
  image="$IMAGE_DIR/$(basename "$IMAGE_URL")"
  wget -q --show-progress -N -P "$IMAGE_DIR" "$IMAGE_URL"
  ok "Debian-13-Cloud-Image bereit"
  qm create "$VMID" --name toypost --memory "$TOYPOST_RAM" --cores "$TOYPOST_CORES" --cpu host \
    --net0 "virtio,bridge=$TOYPOST_BRIDGE" --ostype l26 --scsihw virtio-scsi-single \
    --agent enabled=1 --serial0 socket --vga serial0 \
    --description "ToyPost: Paperless-ngx, Nextcloud, n8n. Angelegt am $(date +%F) mit proxmox-install.sh"
  qm disk import "$VMID" "$image" "$TOYPOST_STORAGE" >/dev/null
  disk=$(qm config "$VMID" | awk '/^unused0:/ {print $2}')
  [ -n "$disk" ] || fehler "Die importierte Platte wurde nicht gefunden (qm config $VMID)."
  qm set "$VMID" --scsi0 "$disk,discard=on,iothread=1,ssd=1" >/dev/null
  qm resize "$VMID" scsi0 "${TOYPOST_DISK}G" >/dev/null
  qm set "$VMID" --ide2 "$TOYPOST_STORAGE:cloudinit" --boot order=scsi0 >/dev/null
  qm set "$VMID" --ciuser "$VM_USER" --sshkeys "$WORK/ssh-keys.pub" \
    --ipconfig0 "ip=$TOYPOST_IP,gw=$TOYPOST_GATEWAY" --nameserver "$TOYPOST_DNS" >/dev/null
  qm set "$VMID" --onboot 1 >/dev/null
  qm start "$VMID"
  ok "VM $VMID gestartet: $TOYPOST_CORES Kerne, $TOYPOST_RAM MB RAM, $TOYPOST_DISK GB auf $TOYPOST_STORAGE, IP $VM_IP"
fi

schritt "Warte auf die VM ($VM_IP)"
for _ in $(seq 1 60); do
  vm_ssh true 2>/dev/null && break
  sleep 5
done
vm_ssh true || fehler "Keine SSH-Verbindung zu $VM_IP. Stimmen IP, Gateway und Brücke? Konsole: qm terminal $VMID"
ok "VM erreichbar"

# ---------- Einrichtung in der VM ----------
schritt "ToyPost in der VM einrichten"
umask 077
cat > "$WORK/vm-angaben.env" <<EOF
DOMAIN=$TOYPOST_DOMAIN
ADMIN_NAME=$TOYPOST_NAME
ADMIN_EMAIL=$TOYPOST_EMAIL
ADMIN_PASSWORD=$TOYPOST_PASSWORT
ACME_EMAIL=${TOYPOST_ACME_EMAIL:-}
AI_PROVIDER=$TOYPOST_KI
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OLLAMA_MODEL=${OLLAMA_MODEL:-qwen3:8b}
SENTRY_DSN=${SENTRY_DSN:-}
EOF
umask 022
scp -q "${SSH_OPTS[@]}" "$TARBALL" "$WORK/vm-setup.sh" "$WORK/vm-angaben.env" "$VM_USER@$VM_IP:/tmp/"
rm -f "$WORK/vm-angaben.env"
vm_ssh "sudo bash /tmp/vm-setup.sh /tmp/toypost-src.tar.gz /tmp/vm-angaben.env $VM_USER" \
  || fehler "Die Einrichtung in der VM ist abgebrochen (Meldung oben). Nach dem Beheben dieses Skript einfach erneut starten."

# ---------- Backup ----------
if [[ "$TOYPOST_BACKUP" =~ ^[jJyY] ]]; then
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
passwort=$(vm_ssh "grep -m1 '^ADMIN_PASSWORD=' /opt/toypost/.env | cut -d= -f2-")
umask 077
cat > "$WORK/zugaenge.txt" <<EOF
ToyPost auf Proxmox, VM $VMID ($VM_IP), eingerichtet am $(date '+%F %H:%M')

Paperless   https://paperless.$TOYPOST_DOMAIN
Nextcloud   https://cloud.$TOYPOST_DOMAIN
n8n         https://n8n.$TOYPOST_DOMAIN   (Inhaber beim ersten Aufruf anlegen)
ToyPost-API  https://toypost.$TOYPOST_DOMAIN

Benutzer    admin   (ToyPost-Konto: $TOYPOST_EMAIL)
Passwort    $passwort

Eintrag für Router-DNS oder hosts-Datei:
$VM_IP  paperless.$TOYPOST_DOMAIN cloud.$TOYPOST_DOMAIN n8n.$TOYPOST_DOMAIN toypost.$TOYPOST_DOMAIN

Anmelden an der VM vom Proxmox-Host:  ssh -i $WORK/id_ed25519 $VM_USER@$VM_IP
EOF
[ -n "$TOYPOST_SSHKEY" ] && echo "Anmelden an der VM von deinem Rechner:  ssh $VM_USER@$VM_IP" >> "$WORK/zugaenge.txt"
umask 022
schritt "Fertig"
cat "$WORK/zugaenge.txt"
echo
echo "Diese Übersicht liegt auch in $WORK/zugaenge.txt (nur für root lesbar)."
