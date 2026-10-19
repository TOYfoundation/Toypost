#!/usr/bin/env bash
# ToyPost: verknüpft Paperless-ngx, Nextcloud, n8n und die ToyPost-Engine.
# Aufruf in /opt/toypost:  ./einrichten.sh
# Darf mehrfach laufen: Vorhandenes wird erkannt, Workflows werden ersetzt, nichts wird doppelt angelegt.
set -euo pipefail
cd "$(dirname "$0")"

# ---------- Grundlagen ----------
[ -f .env ] || { echo "Die Datei .env fehlt. Lege sie zuerst an (Schritt 3 der Anleitung)."; exit 1; }
# .env so lesen, wie Docker Compose es tut: KEY=Wert, Anführungszeichen außen werden entfernt, Kommentare ignoriert
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  key=${line%%=*}; value=${line#*=}
  [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]] && value=${BASH_REMATCH[1]}
  export "$key=$value"
done < .env
for tool in curl jq docker openssl base64; do
  command -v "$tool" >/dev/null || { echo "Bitte zuerst installieren: $tool  (apt install -y $tool)"; exit 1; }
done

TOYPOST=http://localhost:8787
PAPERLESS=http://localhost:8000
NEXTCLOUD=http://localhost:8080
N8N=http://localhost:5678
STATE=.einrichtung
mkdir -p "$STATE"

schritt() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()      { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fehler()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

# Wartet, bis eine Adresse mit einem der erwarteten HTTP-Codes antwortet (max. 10 Minuten)
warte_auf() {
  local name=$1 url=$2 codes=${3:-200}
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    if [[ " $codes " == *" $code "* ]]; then ok "$name ist bereit"; return 0; fi
    sleep 5
  done
  fehler "$name antwortet nicht unter $url. Prüfe: docker compose logs $name"
}

occ() { docker compose exec -T -u www-data nextcloud php occ "$@"; }

schritt "Warte auf die Dienste"
warte_auf toypost   "$TOYPOST/v1/health"
warte_auf paperless "$PAPERLESS/api/" "200 401 403"
warte_auf nextcloud "$NEXTCLOUD/status.php"
warte_auf n8n       "$N8N/healthz"
for _ in $(seq 1 60); do
  if occ status --output=json 2>/dev/null | jq -e '.installed == true' >/dev/null; then break; fi
  sleep 5
done
occ status --output=json | jq -e '.installed == true' >/dev/null || fehler "Nextcloud ist noch nicht installiert. Prüfe: docker compose logs nextcloud"
ok "Nextcloud ist installiert"

# ---------- 1. ToyPost-Konto ----------
schritt "ToyPost-Konto"
login=$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')
resp=$(curl -s -X POST "$TOYPOST/v1/auth/login" -H 'content-type: application/json' -d "$login")
if ! echo "$resp" | jq -e .token >/dev/null; then
  reg=$(jq -n --arg n "$ADMIN_NAME" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{name:$n,email:$e,password:$p}')
  resp=$(curl -s -X POST "$TOYPOST/v1/auth/register" -H 'content-type: application/json' -d "$reg")
  echo "$resp" | jq -e .token >/dev/null || fehler "Konto konnte nicht angelegt werden: $(echo "$resp" | jq -r '.error.message // .')"
  ok "Konto angelegt für $ADMIN_EMAIL"
else
  ok "Konto vorhanden, angemeldet"
fi
TOKEN=$(echo "$resp" | jq -r .token)
ACCOUNT_ID=$(echo "$resp" | jq -r .account.id)
SECRET=$(curl -fsS "$TOYPOST/v1/integrations/webhook-secret" -H "authorization: Bearer $TOKEN" | jq -r .secret)
toypost_put() { # $1 = Art, $2 = JSON
  local r; r=$(curl -s -X PUT "$TOYPOST/v1/integrations/$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2")
  echo "$r" | jq -e ".$1.connected == true" >/dev/null || fehler "ToyPost konnte $1 nicht verbinden: $(echo "$r" | jq -r '.error.message // .')"
  ok "ToyPost ist mit $1 verbunden"
}

# ---------- 2. Paperless ----------
schritt "Paperless-ngx"
PL_TOKEN=$(curl -fsS -X POST "$PAPERLESS/api/token/" --data-urlencode "username=$ADMIN_USER" --data-urlencode "password=$ADMIN_PASSWORD" | jq -r .token)
[ -n "$PL_TOKEN" ] && [ "$PL_TOKEN" != null ] || fehler "Kein API-Token von Paperless erhalten (Benutzer/Passwort in .env prüfen)."
ok "API-Token erhalten"
pl() { curl -fsS -H "Authorization: Token $PL_TOKEN" -H 'Content-Type: application/json' "$@"; }

tag_id() { # legt einen Tag an, falls er fehlt, und gibt seine ID aus
  local name=$1 color=$2 id
  id=$(pl "$PAPERLESS/api/tags/?page_size=1000" | jq -r --arg n "$name" '.results[] | select(.name==$n) | .id' | head -n1)
  if [ -z "$id" ]; then
    id=$(pl -X POST "$PAPERLESS/api/tags/" -d "$(jq -n --arg n "$name" --arg c "$color" '{name:$n,color:$c,matching_algorithm:0}')" | jq -r .id)
  fi
  echo "$id"
}
TAG_ANTWORT=$(tag_id toypost-antwort '#2f5bea')
TAG_ERLEDIGT=$(tag_id toypost-erledigt '#1e7a55')
ok "Tags: toypost-antwort ($TAG_ANTWORT), toypost-erledigt ($TAG_ERLEDIGT)"

FIELD_ID=$(pl "$PAPERLESS/api/custom_fields/?page_size=1000" | jq -r '.results[] | select(.name=="Vorgang") | .id' | head -n1)
if [ -z "$FIELD_ID" ]; then
  FIELD_ID=$(pl -X POST "$PAPERLESS/api/custom_fields/" -d '{"name":"Vorgang","data_type":"string"}' | jq -r .id)
fi
ok "Benutzerdefiniertes Feld \"Vorgang\" ($FIELD_ID)"

HOOK_URL="http://toypost:8787/v1/hooks/paperless/$ACCOUNT_ID"
workflow() { # $1 Name, $2 Reihenfolge, $3 Auslöser (JSON), $4 Aktion (added|draft|done), $5 zusätzliche Aktionen (JSON-Liste)
  local name=$1 order=$2 trigger=$3 action=$4 extra=${5:-[]} old body
  for old in $(pl "$PAPERLESS/api/workflows/?page_size=1000" | jq -r --arg n "$name" '.results[] | select(.name==$n) | .id'); do
    pl -X DELETE "$PAPERLESS/api/workflows/$old/" >/dev/null
  done
  body=$(jq -n --arg name "$name" --argjson order "$order" --argjson trigger "$trigger" --arg url "$HOOK_URL" \
    --arg secret "$SECRET" --arg action "$action" --argjson extra "$extra" '{
      name: $name, order: $order, enabled: true,
      triggers: [$trigger],
      actions: ([{
        type: 4,
        webhook: {
          url: $url, use_params: true, as_json: true, include_document: false,
          params: { documentId: "{{ doc_id }}", action: $action },
          headers: { "x-toypost-token": $secret }
        }
      }] + $extra)
    }')
  pl -X POST "$PAPERLESS/api/workflows/" -d "$body" >/dev/null || fehler "Workflow \"$name\" konnte nicht angelegt werden."
  ok "Workflow \"$name\""
}
workflow "ToyPost: neue Post melden" 10 '{"type":2,"sources":[1,2,3,4]}' added
workflow "ToyPost: Antwort entwerfen" 20 "{\"type\":3,\"filter_has_tags\":[$TAG_ANTWORT]}" draft "[{\"type\":2,\"remove_tags\":[$TAG_ANTWORT]}]"
workflow "ToyPost: erledigt" 30 "{\"type\":3,\"filter_has_tags\":[$TAG_ERLEDIGT]}" done

toypost_put paperless "$(jq -n --arg t "$PL_TOKEN" --argjson f "$FIELD_ID" --arg pub "https://paperless.$DOMAIN" \
  '{url:"http://paperless:8000", token:$t, caseFieldId:$f, publicUrl:$pub}')"

# ---------- 3. Nextcloud ----------
schritt "Nextcloud"
for app in calendar tasks; do
  occ app:install "$app" >/dev/null 2>&1 || occ app:enable "$app" >/dev/null 2>&1 || true
  ok "App $app aktiv"
done
occ app:enable files_external >/dev/null
if ! occ files_external:list --output=json | jq -e '.[] | select(.mount_point=="/Paperless-Eingang")' >/dev/null; then
  occ files_external:create /Paperless-Eingang local null::null -c datadir=/mnt/eingang >/dev/null
fi
ok "Ordner \"Paperless-Eingang\" eingebunden (alles darin liest Paperless ein)"

if [ -s "$STATE/nextcloud-app-passwort" ]; then
  APP_PW=$(cat "$STATE/nextcloud-app-passwort")
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN_USER:$APP_PW" -X PROPFIND -H 'Depth: 0' "$NEXTCLOUD/remote.php/dav/files/$ADMIN_USER/")
  [ "$code" = 207 ] || APP_PW=""
fi
if [ -z "${APP_PW:-}" ]; then
  APP_PW=$(docker compose exec -T -u www-data -e NC_PASS="$ADMIN_PASSWORD" -e OC_PASS="$ADMIN_PASSWORD" nextcloud \
    php occ user:auth-tokens:add --password-from-env --name toypost "$ADMIN_USER" | awk -F': ' '/app password/ {print $2}' | tr -d '\r')
  [ -n "$APP_PW" ] || fehler "Kein App-Passwort von Nextcloud erhalten."
  umask 077; printf '%s' "$APP_PW" > "$STATE/nextcloud-app-passwort"
fi
ok "App-Passwort für ToyPost und n8n"

dav() { curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN_USER:$APP_PW" "$@"; }
code=$(dav -X MKCALENDAR "$NEXTCLOUD/remote.php/dav/calendars/$ADMIN_USER/toypost/" -H 'Content-Type: application/xml' --data-binary \
  '<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>ToyPost</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>')
[[ "$code" == 201 || "$code" == 405 ]] || fehler "Kalender \"ToyPost\" konnte nicht angelegt werden (HTTP $code)."
ok "Kalender \"ToyPost\" für Fristen und Aufgaben"
for folder in ToyPost "ToyPost/Entw%C3%BCrfe"; do
  code=$(dav -X MKCOL "$NEXTCLOUD/remote.php/dav/files/$ADMIN_USER/$folder")
  [[ "$code" == 201 || "$code" == 405 ]] || fehler "Ordner $folder konnte nicht angelegt werden (HTTP $code)."
done
ok "Ordner ToyPost/Entwürfe"

toypost_put nextcloud "$(jq -n --arg u "$ADMIN_USER" --arg p "$APP_PW" '{url:"http://nextcloud", user:$u, appPassword:$p, calendar:"toypost", folder:"ToyPost"}')"

# ---------- 4. n8n ----------
schritt "n8n"
if [ -s "$STATE/n8n-webhook-pfad" ]; then WEBHOOK_PATH=$(cat "$STATE/n8n-webhook-pfad"); else
  WEBHOOK_PATH="toypost-$(openssl rand -hex 16)"; printf '%s' "$WEBHOOK_PATH" > "$STATE/n8n-webhook-pfad"
fi
BASIC=$(printf '%s:%s' "$ADMIN_USER" "$APP_PW" | base64 -w0)
WEBHOOK_ID=$(cat /proc/sys/kernel/random/uuid)
sed -e "s|__WEBHOOK_PATH__|$WEBHOOK_PATH|g" -e "s|__WEBHOOK_ID__|$WEBHOOK_ID|g" \
    -e "s|__NEXTCLOUD_URL__|http://nextcloud|g" -e "s|__NEXTCLOUD_BASIC__|$BASIC|g" \
    n8n/toypost-nextcloud.json > "$STATE/n8n-workflow.json"
chmod 600 "$STATE/n8n-workflow.json"
docker compose cp "$STATE/n8n-workflow.json" n8n:/tmp/toypost-nextcloud.json >/dev/null
docker compose exec -T n8n n8n import:workflow --input=/tmp/toypost-nextcloud.json >/dev/null \
  || fehler "n8n konnte den Workflow nicht importieren. Prüfe: docker compose logs n8n"
docker compose exec -T n8n n8n publish:workflow --id=ToyPostNextcloud1 >/dev/null \
  || fehler "n8n konnte den Workflow nicht veröffentlichen. Öffne n8n, wähle den Workflow 'ToyPost → Nextcloud', klicke auf 'Publish' und starte dieses Skript erneut."
docker compose exec -T n8n rm -f /tmp/toypost-nextcloud.json
docker compose restart n8n >/dev/null
warte_auf n8n "$N8N/healthz"
ok "Workflow \"ToyPost → Nextcloud\" importiert und veröffentlicht"
toypost_put n8n "$(jq -n --arg u "http://n8n:5678/webhook/$WEBHOOK_PATH" '{eventsUrl:$u}')"

# ---------- 5. Probelauf ----------
schritt "Probelauf: ein Testbrief durch die ganze Kette"
heute=$(date +%F)
brief=$(printf 'Stadtwerke Probe GmbH\nKundennummer: PROBE-%s\nRechnungsdatum: %s\nRechnungsbetrag: 12,34 €\nZahlbar innerhalb von 14 Tagen auf IBAN DE89 3704 0044 0532 0130 00.' "$(date +%s)" "$heute")
probe=$(curl -s -X POST "$TOYPOST/v1/documents" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$brief" --arg d "$heute" '{text:$t, letterDate:$d, title:"Testbrief der Einrichtung"}')")
CASE_ID=$(echo "$probe" | jq -r .caseId)
[ -n "$CASE_ID" ] && [ "$CASE_ID" != null ] || fehler "ToyPost hat den Testbrief nicht verarbeitet: $(echo "$probe" | jq -r '.error.message // .')"
ok "ToyPost: Vorgang angelegt, Frist $(echo "$probe" | jq -r .case.deadline.date)"
for _ in $(seq 1 12); do
  code=$(dav "$NEXTCLOUD/remote.php/dav/calendars/$ADMIN_USER/toypost/toypost-$CASE_ID-aufgabe.ics")
  [ "$code" = 200 ] && break; sleep 5
done
[ "$code" = 200 ] || fehler "Die Aufgabe kam nicht in Nextcloud an. Prüfe in n8n unter \"Executions\" den Workflow \"ToyPost → Nextcloud\"."
ok "Nextcloud: Aufgabe und Termin im Kalender \"ToyPost\" (über n8n)"
curl -s -X PATCH "$TOYPOST/v1/cases/$CASE_ID" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":"done"}' >/dev/null
ok "Testvorgang wieder als erledigt markiert"

# ---------- Zusammenfassung ----------
cat > "$STATE/zugaenge.txt" <<EOF
ToyPost-Konto:   $ACCOUNT_ID
Paperless:      https://paperless.$DOMAIN   ($ADMIN_USER)
Nextcloud:      https://cloud.$DOMAIN       ($ADMIN_USER)
n8n:            https://n8n.$DOMAIN         (Inhaber beim ersten Aufruf anlegen)
ToyPost-API:     https://toypost.$DOMAIN
Webhook-Pfad:   http://n8n:5678/webhook/$WEBHOOK_PATH
EOF
chmod 600 "$STATE/zugaenge.txt"
schritt "Fertig"
cat "$STATE/zugaenge.txt"
echo
echo "Diese Übersicht liegt auch in $(pwd)/$STATE/zugaenge.txt"
