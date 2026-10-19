# Dokufy

Dokufy liest jede eingehende Post – ob Papierbrief, PDF oder E-Mail –, erkennt Absender, Frist und Betrag, ordnet sie dem richtigen Vorgang zu und bereitet die Antwort vor. Archiv, Arbeitsplatz und Abläufe kommen aus drei bestehenden Systemen:

| System | Rolle in Dokufy |
| --- | --- |
| **Paperless-ngx** | Eingang, Texterkennung (OCR), revisionsfähiges Archiv – die einzige Quelle der Wahrheit für fertige Dokumente |
| **Nextcloud** | Arbeitsplatz: Fristen im Kalender, Entwürfe als Dateien, Aufgaben in Deck |
| **n8n** | Abläufe: verbindet Ereignisse mit Zielen, ohne dass Dokufy jede Kombination kennen muss |

Dokufy selbst ist die dünne Schicht darüber: Vorgänge, KI-Auswertung, Credits und eine App für alle Geräte.

Das ausführliche Konzept (Funktionen, Tarife, Kostenkalkulation) steht im Claude-Doc „Dokufy – Architekturkonzept“.

## Aufbau

```
apps/
  api/        Node.js-API ohne externe Abhängigkeiten (HTTP, SQLite, Krypto aus Node.js)
  mobile/     Expo-App (iOS, Android, Web) mit Expo Router
packages/
  shared/     Tarife, Credit-Preise, Fristen-Erkennung, GiroCode, Typen, Demo-Daten
integrations/
  n8n/        Workflow-Vorlagen zum Importieren in n8n
tools/
  preview/    Browser-Vorschau der App-Bildschirme für Screenshots und Design-Review
```

## Schnellstart

Voraussetzung: Node.js 22.18 oder neuer (Typ-Stripping und `node:sqlite` sind eingebaut).

```bash
# API mit Demo-Daten
cp apps/api/.env.example apps/api/.env
npm run seed --workspace @dokufy/api      # Konto demo@dokufy.app / dokufy-demo-2026
npm run api                                # http://localhost:8787

# App
npm install
cd apps/mobile && npx expo install --fix   # gleicht Paketversionen an die aktuelle Expo-SDK an
npm run start                              # QR-Code mit Expo Go scannen, "w" für Web
```

Ohne Server lässt sich die App über **„Mit Beispiel-Post ausprobieren“** im Demo-Modus nutzen. Die Server-Adresse setzt `EXPO_PUBLIC_API_URL` oder `extra.apiUrl` in `apps/mobile/app.json`.

Alles zusammen mit Paperless, Nextcloud und n8n:

```bash
cp .env.example .env    # Werte setzen
docker compose up -d
```

## Funktionen

- **Heute-Ansicht** – offene Vorgänge nach Frist sortiert, mit der passenden Handlung direkt an der Karte
- **Fristen-Radar** – erkennt „binnen 14 Tagen“, „innerhalb eines Monats nach Bekanntgabe“ und ausdrückliche Daten; rechnet nach §§ 187 ff. BGB und § 122 AO, verschiebt auf den nächsten Werktag und zeigt die Rechnung an
- **Zahlungs-Assistent** – liest IBAN und Betrag, erzeugt einen GiroCode für die Banking-App
- **Antwortentwürfe** – in drei Tonlagen; im Team mit 4-Augen-Freigabe
- **Wiedervorlage** – nach dem Versand erinnert Dokufy, wenn keine Antwort kommt
- **Lernende Regeln** – jede Korrektur wird zur Regel; der nächste gleiche Brief braucht keine KI und keine Credits
- **Frag dein Archiv** – Fragen in Alltagssprache mit Quellenangabe

## Tarife und Credits

Alle Werte stehen an einer Stelle: `packages/shared/src/plans.ts` und `packages/shared/src/credits.ts`. App, API und Tests lesen sie von dort.

| | Free | Pro | Team | Enterprise |
| --- | --- | --- | --- | --- |
| Preis | 0 € | 6,99 €/Monat · 69 €/Jahr | 8,99 € je Nutzer/Monat · 89 €/Jahr | ab 19 € je Nutzer/Monat |
| Credits/Monat | 30 | 400 | 600 je Nutzer | individuell |
| Speicher | 1 GB | 25 GB | 50 GB je Nutzer | ab 1 TB |

Credits verbraucht nur KI-Arbeit (Auswerten 1, Frage 3, Entwurf 5). Zuerst wird das Monatskontingent verbraucht, dann gekaufte Pakete (24 Monate gültig). Scheitert die KI, werden Credits automatisch erstattet.

## KI-Anbieter

`AI_PROVIDER` in `apps/api/.env`:

- `mock` – Regeln ohne KI (Entwicklung, Tests)
- `anthropic` – Claude: Haiku für Auswertung und Fragen, Sonnet für Entwürfe
- `ollama` – lokales Modell, keine Daten verlassen den Server

Regeln laufen immer zuerst und kosten nichts. Briefinhalte werden als Daten, nicht als Anweisungen behandelt.

## Zahlungsanbieter

Die Abrechnung läuft über die Schnittstelle in `apps/api/src/billing/provider.ts`. Mitgeliefert ist ein Entwicklungs-Anbieter, der Zahlungen sofort verbucht (in Produktion gesperrt). Für Stripe oder Paddle wird ein Adapter mit `createCheckout` und `parseWebhook` ergänzt; Bestellungen werden idempotent freigeschaltet.

## Integrationen einrichten

1. **Paperless**: Profil → API-Token erzeugen, in der App unter Konto → Verbindungen eintragen.
2. **Paperless → Dokufy**: Workflow „Dokument hinzugefügt“ mit Webhook auf die n8n-Vorlage `integrations/n8n/paperless-an-dokufy.json` (signiert die Meldung) oder direkt auf die angezeigte Webhook-Adresse.
3. **Nextcloud**: App-Passwort anlegen (Einstellungen → Sicherheit). Ohne n8n schreibt Dokufy Fristen direkt in den Kalender.
4. **n8n** (ab Team): `integrations/n8n/dokufy-ereignisse-verteilen.json` importieren, Webhook-Adresse in Dokufy eintragen. Dokufy sendet `document.analyzed`, `deadline.detected`, `draft.created`, `case.updated`, signiert mit HMAC-SHA256 (`x-dokufy-signature`).

## Tests

```bash
npm test                 # Shared-Logik und API-Integrationstests
npm run typecheck
```

Die API-Tests starten einen echten Server und prüfen Registrierung, Auswertung, Fristen, Zuordnung, Regeln, Credits (inkl. Erstattung und leeres Guthaben), Kauf, Tarifwechsel, n8n-Ereignisse mit Signatur, Paperless-Webhook, Suche und Speicherlimit.

## Sicherheit und Datenschutz

- Passwörter mit scrypt, Zugangstokens HMAC-signiert, Zugangsdaten zu Paperless/Nextcloud AES-256-GCM-verschlüsselt
- Webhooks in beide Richtungen signiert
- Ratenlimit für Anmeldung und Registrierung
- Lokale KI (Ollama) als Option; Cloud-KI nur mit ausdrücklicher Konfiguration
- Fristberechnung ist eine Hilfe, keine Rechtsberatung; die App zeigt immer die Fundstelle

## Nächste Schritte

- Zahlungs-Adapter (Stripe oder Paddle) und Rechnungsstellung
- Postgres-Adapter für große Installationen
- Native Dokumentenscanner mit Kantenerkennung (Expo Dev Build)
- Push-Benachrichtigungen für Fristen

## Lizenz

Proprietär. Alle Rechte vorbehalten.
