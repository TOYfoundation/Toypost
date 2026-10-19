# Dokufy auf Proxmox (ohne App)

Paperless-ngx, Nextcloud, n8n und die Dokufy-Engine in einer Debian-VM, verknüpft durch `einrichten.sh`.
Die vollständige Schritt-für-Schritt-Anleitung steht im Claude-Doc „Dokufy auf Proxmox – Installationsanleitung“.

| Datei | Zweck |
| --- | --- |
| `compose.yml` | alle Dienste; Ports nur auf 127.0.0.1, von außen erreichbar über Caddy |
| `Caddyfile` | HTTPS für paperless., cloud., n8n. und dokufy.<DOMAIN> |
| `einrichten.sh` | legt Konto, Token, Tags, Workflows, Kalender, Ordner und den n8n-Workflow an; mehrfach ausführbar |
| `n8n/dokufy-nextcloud.json` | Vorlage: n8n schreibt Dokufys Fristen, Aufgaben und Entwürfe in Nextcloud |

Kurzfassung auf der VM:

```bash
sudo mkdir -p /opt/dokufy && sudo chown "$USER" /opt/dokufy
git clone https://github.com/Safehaigit/dokufy.git /opt/dokufy/src   # oder dokufy.zip entpacken
cp -r /opt/dokufy/src/deploy/proxmox/. /opt/dokufy/
cd /opt/dokufy && nano .env                                         # siehe Anleitung, Schritt 3
mkdir -p data/eingang data/export && sudo chown -R 33:33 data
docker compose up -d --build
./einrichten.sh
```

Bedienung ohne App: Post in Nextcloud in „Paperless-Eingang“ legen oder scannen; Fristen und Aufgaben erscheinen im Kalender „Dokufy“.
In Paperless den Tag `dokufy-antwort` setzen → Entwurf in `Dokufy/Entwürfe`; Tag `dokufy-erledigt` → Aufgabe abgehakt.
