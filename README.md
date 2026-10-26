# ToyPost

ToyPost ist der Korrespondenz-Assistent des **ToyVerse**, des Toy-Ökosystems aus ToyChain, ToyCoin, TOYPAY, ToyScan und später ToyCash und TOYQUEST (Überblick: `docs/spaeter/11-toyverse.md` in `TOYfoundation/toycoin`). Er liest jede Post, ob Papierbrief, E-Mail, Telegram, SMS, Matrix, Signal oder Datenfeed. Daraus macht er Vorgänge mit Frist, Betrag und nächstem Schritt, erkennt TOY-Zahlungsaufforderungen und Betrugsversuche und schreibt Antworten. Tester und Community hält er über den Fortschritt der Projekte auf dem Laufenden, in 45 Sprachen und erst nach Freigabe.

ToyPost ist ein Ableger von Dokufy und übernimmt dessen Grundlage: Paperless-ngx als Archiv und Texterkennung, Nextcloud für Fristen und Entwürfe, n8n für eigene Abläufe.

## Was ToyPost kann

**Alle Kanäle in einem Posteingang**
- E-Mail (eigener SMTP-Versand), Telegram-Bot, Matrix, Signal, SMS über ein altes Android-Handy oder Twilio, Nextcloud Talk, Discord, Slack, ntfy/UnifiedPush, Webhooks
- Fotos und Scans aus Messengern gehen an Paperless zur Texterkennung
- Datenfeeds (RSS, Atom, JSON Feed): Projekt-Blogs, Behörden, Status-Seiten
- **Eine Person, viele Kanäle:** Kontakte bündeln E-Mail, Telefonnummer, Telegram-Chat und TOY-Adresse, mit Sprache und Gruppen; doppelte Kontakte lassen sich zusammenführen
- Unterhaltungen bleiben in einem Vorgang; längere Nachrichten werden ausgewertet wie Briefe (Fristen nach BGB und AO, Beträge, IBAN)

**TOY im Alltag**
- TOY-Zahlungsaufforderungen in Briefen, Mails und Chats werden erkannt: Betrag, Adresse mit EIP-55-Prüfsumme, `toychain:`-Link mit QR-Code zum Öffnen in der TOYPAY Wallet
- Eigene **TOY-Rechnungen** mit eindeutigem Verwendungszweck (`TP-7K3QXP …`); meldet ToyScan die Zahlung, wird der Vorgang geschlossen und der Zahler bekommt einen Dank in seiner Sprache
- **Anmelden mit Adresse** (EIP-4361) mit der TOYPAY Wallet
- ToyPost hat **keine Schlüssel** und sendet nie TOY; bezahlt wird immer in der Wallet

**Schutz**
- Nachrichten, die nach der Wiederherstellungsphrase fragen, falsche Airdrops, Adress-Fallen (gleicher Anfang und gleiches Ende wie eine bekannte Adresse) und die alten ToyCoin-Token auf Ethereum und Polygon werden markiert, mit Push an den Betreiber
- Ausgehende Nachrichten mit Phrase oder privatem Schlüssel werden **blockiert**; Geheimnisse werden vor dem Speichern und vor jeder KI geschwärzt
- Sicherheitsmeldungen von außen werden nie öffentlich, der Absender bekommt den vertraulichen Meldeweg

**Fortschritt der Toy-Projekte, automatisch kommuniziert**
- liest `docs/STATUS.md` und Releases von `TOYfoundation/toycoin`
- wird ein Meilenstein fertig, liegt eine Mitteilung an die Gruppe „Tester“ zur Freigabe bereit; jede Sprache als Vorschau, Versand über den besten Kanal jedes Empfängers
- Warnampel von ToyScan: bei Rot sofort Push und Notfall-Mitteilung zum Freigeben
- Fehlermeldungen per Nachricht werden zu GitHub-Issues, ohne Namen und Telefonnummern
- monatlicher **Transparenz-Bericht** als Entwurf und Pull Request für `docs/berichte/`

**Automationen:** Ereignis + Bedingungen + Aktionen, als JSON ohne Code. Sieben fertige Vorlagen für die Toy-Projekte. Was viele Menschen erreicht, braucht immer eine Freigabe; in Team-Konten muss eine zweite Person freigeben.

## Aufbau

```
apps/
  api/          Node.js-API ohne externe Abhängigkeiten
    src/channels/   Kanäle: Konfiguration, SMTP, Senden, Eingang, Feeds
    src/services/   Vorgänge, Nachrichten, Kontakte, Mitteilungen, Automationen, Rechnungen, Bericht
    src/toy/        ToyChain-RPC, ToyScan, GitHub, Abruf, secp256k1, Anmelden mit Adresse
  mobile/       Expo-App (iOS, Android, Web): Heute, Vorgänge, Erfassen, Posteingang, Konto
packages/
  shared/       Fristen, Tarife, GiroCode und der Toy-Kern (TOY-Beträge, Adressen, Zahlungslink, Schutz, 45 Sprachen)
deploy/proxmox/ Installation auf Proxmox (von Hand, mit einem Befehl oder als ein Block)
docs/           TOY-SCHNITTSTELLE.md (Vereinbarung mit toycoin), KANAELE.md (Einrichtung)
tools/          Vorschau der App, Abgleich der Sprachen mit toycoin
```

## Schnellstart

Voraussetzung: Node.js 22.18 oder neuer.

```bash
cp apps/api/.env.example apps/api/.env
npm run seed --workspace @toypost/api      # Demo-Konto
npm run api                                # http://localhost:8787

npm ci                                     # installiert genau die Versionen aus package-lock.json
cd apps/mobile && npm run start
```

Ohne Server läuft die App im Demo-Modus mit Beispielen für alle Kanäle und die Toy-Projekte. Für den eigenen Server auf Proxmox: `deploy/proxmox/README.md`.

### Abhängigkeiten aktualisieren

`package-lock.json` legt alle Versionen fest, damit jeder Rechner und die CI dasselbe installieren. Zum Aktualisieren:

```bash
cd apps/mobile && npx expo install --fix   # Expo-Pakete passend zur Expo-Version
cd ../.. && npm install                    # schreibt die neue package-lock.json
```

Danach `package.json` und `package-lock.json` zusammen committen. Die CI nutzt `npm ci` und bricht ab, wenn beide nicht zusammenpassen.

**Bekannte Meldungen von `npm audit` (Stand 24.10.2026):** 10 Meldungen (6 hoch, 4 mittel) in Expos eigenen Werkzeugen: `node-forge` und `postcss` über `@expo/cli` und `@expo/metro-config`, `image-size` über `metro`, `decode-uri-component` über `expo-router`. Sie betreffen die Entwicklungs- und Build-Werkzeuge, nicht die API (die hat keine fremden Abhängigkeiten). Eine Behebung gibt es nur über neue Expo-Versionen. Deshalb bei jedem Expo-Update `npm audit --omit=dev` erneut prüfen.

## Einstellungen

| Variable | Bedeutung |
|---|---|
| `TOYPOST_SECRET` | mindestens 32 Zeichen, schützt Anmeldungen und gespeicherte Zugangsdaten |
| `PUBLIC_URL` | öffentliche Adresse der API, für Eingangsadressen und Anmelden mit Adresse |
| `AI_PROVIDER` | `mock` (nur Regeln), `anthropic` (Claude) oder `ollama` (lokal) |
| `TOYCHAIN_CHAIN_IDS` | erlaubte Chain-IDs beim Anmelden mit Adresse (leer = jede, solange ToyChain keine feste ID hat) |
| `SIWE_DOMAIN` | Domain für Anmelden mit Adresse (Standard: Host von `PUBLIC_URL`) |
| `SCHEDULER` | Abruf von Feeds, GitHub und ToyScan im Hintergrund (Standard an) |
| `SENTRY_DSN` | Fehlerberichte an Sentry (Projekt „toypost-api“); ohne Inhalte, Geheimnisse geschwärzt |

## Sprachen

Die 45 Sprachen und die Begriffsliste kommen aus `TOYfoundation/toycoin`, damit „Aktivierungs-Pfand“ oder „Wiederherstellungsphrase“ überall gleich übersetzt sind:

```bash
node tools/toy-i18n-sync.mjs ../toycoin    # erzeugt i18n-data.ts und toyverse-data.ts in packages/shared/src/toy/
```

`toyverse-data.ts` enthält die festen Werte des ToyVerse aus toycoin `shared/toyverse.json` (Entscheidung 135): Dezimalstellen, Obergrenze, Chain-IDs, Typ-Bytes, alte ToyCoin-Token. `amount.ts` und `safety.ts` lesen sie von dort, `test/toyverse.test.ts` prüft sie.

**Automatisch:** Der Workflow „Abgleich mit toycoin“ (`.github/workflows/sync-toycoin.yml`) läuft täglich und auf Knopfdruck und öffnet bei Änderungen einen Pull Request. Einmalig nötig: ein Lese-Schlüssel (fine-grained Token, nur „Contents: Read-only“ für `TOYfoundation/toycoin`) als Secret `TOYCOIN_READ_TOKEN` und unter „Settings → Actions → General“ das Häkchen „Allow GitHub Actions to create and approve pull requests“.

## Tests

```bash
npm test
```

- **Gemeinsames Paket (29 Tests):** Keccak-256 gegen offizielle Vektoren und Node-SHA3, EIP-55-Beispiele, Adressen der Schlüssel 1 und 2, TOY-Beträge, Zahlungslinks, Betrugs- und Phrasenerkennung, 45 Sprachen
- **API (42 Tests):** dazu der ganze Weg mit nachgebauten Diensten: SMS-Gateway, SMTP-Server, ntfy, GitHub, ToyScan, Feed, Telegram und Twilio mit Signatur, Rechnung und Zahlungseingang, Meilenstein-Mitteilung in zwei Sprachen, Warnampel, Issue ohne Absender, Anmelden mit Adresse, Bericht als Pull Request, Sentry-Bericht

## Ehrlich

- ToyChain ist bei Meilenstein M2 (Stand 20.10.2026); RPC (M7) und ToyScan (M11) gibt es noch nicht. ToyPost setzt die in toycoin beschriebenen Schnittstellen um und liest Antworten tolerant. Das genaue Format ist in `docs/TOY-SCHNITTSTELLE.md` vorgeschlagen.
- Keccak-256 und die secp256k1-Prüfung sind nach Standard selbst umgesetzt, weil beim Bau keine Paketquelle erreichbar war. Sie sind gegen offizielle Vektoren und gegen OpenSSL geprüft und sollen gegen eine geprüfte Bibliothek (`@noble/hashes`, `@noble/curves`) getauscht werden.
- Die Erkennung von Phrasen kennt die offizielle BIP-39-Wortliste nicht und arbeitet mit Mustern und Kontextwörtern.
- Betrugserkennung warnt nur; sie entscheidet nie über Geld.

## Lizenz

MIT, siehe `LICENSE`. Gilt für den Code in diesem Repository. Eingebundene Pakete wie Paperless-ngx, Nextcloud und n8n behalten ihre eigenen Lizenzen.
