# ToyPost auf Proxmox (ohne App)

Paperless-ngx, Nextcloud, n8n und die ToyPost-Engine in einer Debian-VM, verknüpft durch `einrichten.sh`.
Die vollständige Anleitung steht im Claude-Doc „ToyPost auf Proxmox – Installationsanleitung“.

## Mit einem Befehl (Shell des Proxmox-Hosts, als root)

```bash
read -rsp "GitHub-Token (Enter, wenn das Repository öffentlich ist): " GITHUB_TOKEN; echo; export GITHUB_TOKEN
curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} -H "Accept: application/vnd.github.raw+json" \
  -o /root/toypost-install.sh "https://api.github.com/repos/Safehaigit/toypost/contents/deploy/proxmox/proxmox-install.sh?ref=main" \
  && bash /root/toypost-install.sh
```

`proxmox-install.sh` fragt die nötigen Angaben ab, holt den Quellcode von GitHub, legt eine Debian-13-VM an
und ruft darin `vm-setup.sh` auf (Docker, `.env`, Dienste, `einrichten.sh`). Mehrfach ausführbar; Antworten
liegen in `/root/toypost-install/angaben`, die Zugänge in `/root/toypost-install/zugaenge.txt`.

| Datei | Zweck |
| --- | --- |
| `proxmox-install.sh` | läuft auf dem Proxmox-Host: Angaben, Quellcode, VM, Backup-Job |
| `vm-setup.sh` | läuft in der VM: Pakete, Docker, Dateien nach `/opt/toypost`, `.env`, Container, `einrichten.sh` |
| `compose.yml` | alle Dienste; Ports nur auf 127.0.0.1, von außen erreichbar über Caddy |
| `Caddyfile` | HTTPS für paperless., cloud., n8n. und toypost.<DOMAIN> |
| `einrichten.sh` | legt Konto, Token, Tags, Workflows, Kalender, Ordner und den n8n-Workflow an; mehrfach ausführbar |
| `n8n/toypost-nextcloud.json` | Vorlage: n8n schreibt ToyPosts Fristen, Aufgaben und Entwürfe in Nextcloud |

## Von Hand auf der VM

```bash
sudo mkdir -p /opt/toypost && sudo chown "$USER" /opt/toypost
git clone https://github.com/Safehaigit/toypost.git /opt/toypost/src   # oder toypost.zip entpacken
cp -r /opt/toypost/src/deploy/proxmox/. /opt/toypost/
cd /opt/toypost && nano .env                                         # siehe Anleitung, Schritt 3
mkdir -p data/eingang data/export && sudo chown -R 33:33 data
docker compose up -d --build
./einrichten.sh
```

Bedienung ohne App: Post in Nextcloud in „Paperless-Eingang“ legen oder scannen; Fristen und Aufgaben erscheinen im Kalender „ToyPost“.
In Paperless den Tag `toypost-antwort` setzen → Entwurf in `ToyPost/Entwürfe`; Tag `toypost-erledigt` → Aufgabe abgehakt.
