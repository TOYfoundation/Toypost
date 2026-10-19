# Kanäle einrichten

In der App unter **Konto → Kanäle**, oder per API `POST /v1/channels`. Zugangsdaten werden verschlüsselt gespeichert (AES-256-GCM) und nie wieder angezeigt.

Jeder Kanal, der Nachrichten empfängt, hat eine eigene **Eingangsadresse** `https://<toypost>/v1/inbox/<kanal-id>?token=<geheim>`. Sie steht in der App beim Kanal (nur für Inhaber und Admins). Das Token ist ein Geheimnis: nur in den jeweiligen Dienst eintragen.

| Kanal | Senden | Empfangen | Was du brauchst |
|---|---|---|---|
| **E-Mail** | SMTP (eingebaut) | über n8n (IMAP-Knoten → Eingangsadresse) oder Paperless-Mailabruf | SMTP-Server, Port, Benutzer, App-Passwort, Absender |
| **Telegram** | Bot API | Webhook, einmal setzen mit `POST /v1/channels/<id>/telegram-webhook` | Bot-Token von @BotFather |
| **Matrix / Element** | Client-Server-API | über n8n oder eine Bridge an die Eingangsadresse | Homeserver, Zugangstoken eines eigenen Benutzers, Raum-ID |
| **Signal** | signal-cli-rest-api | Empfangsschleife von signal-cli an die Eingangsadresse | eigener signal-cli-rest-api-Container, eigene Nummer |
| **SMS** | Android-Gateway, Twilio oder eigener HTTP-Dienst | Webhook des Gateways bzw. von Twilio (Signatur wird geprüft) | altes Android-Handy mit „SMS Gateway for Android“ oder Twilio-Konto |
| **ntfy / UnifiedPush** | ja | – | ntfy-Server (eigener oder ntfy.sh) und ein geheimes Thema |
| **Nextcloud Talk** | ja | über n8n | Nextcloud-Benutzer mit App-Passwort, Unterhaltungs-Token |
| **Discord, Slack** | Webhook | – | Webhook-Adresse des Kanals |
| **Webhook** | JSON, signiert mit HMAC-SHA256 (`x-toypost-signature`) | einfaches Format (siehe unten) | eigener Dienst |
| **Datenfeed** | – | Abruf (RSS, Atom, JSON Feed) | Feed-Adresse |
| **GitHub-Projekt** | Issues, Pull Requests | Abruf von `docs/STATUS.md` und Releases | Repository; für Issues und Berichte ein Token mit Schreibrecht |
| **ToyScan** | – | Abruf der Warnampel und Adress-Alarm (Webhook) | ToyScan-Adresse, eigene Rechnungsadressen |

## Einfaches Eingangsformat

Für E-Mail über n8n, Matrix-Bridges, Signal-Empfang und eigene Skripte:

```json
POST /v1/inbox/<kanal-id>?token=<geheim>
{
  "from": "anna@example.org",
  "fromName": "Anna",
  "language": "en",
  "subject": "Testnet-Rechnung",
  "text": "Bitte zahle 12,5 TOY an 0x5aAe…",
  "externalId": "<message-id@mail>",
  "threadKey": "<message-id der ersten Mail>",
  "attachments": [{ "name": "scan.pdf", "mime": "application/pdf", "base64": "…" }]
}
```

- `externalId` verhindert doppelte Einträge, wenn ein Dienst dieselbe Nachricht zweimal schickt.
- `threadKey` hält eine Unterhaltung in einem Vorgang zusammen.
- Fotos und PDFs gehen an Paperless zur Texterkennung, wenn Paperless verbunden ist.

## Was mit einer eingehenden Nachricht passiert

1. Kontakt finden oder anlegen (eine Person, viele Kanäle; Sprache aus Telegram oder von Hand).
2. Sicherheitsprüfung: verlangte Phrase, falscher Airdrop, Adress-Falle, alter ToyCoin-Token. Geheimnisse werden vor dem Speichern geschwärzt.
3. Kurze Chat-Zeilen hängen sich an die laufende Unterhaltung. Längere Nachrichten werden wie ein Brief ausgewertet: Frist, Betrag, IBAN, TOY-Zahlungsaufforderung.
4. Automationen laufen (z. B. Push bei Betrugsverdacht, Issue bei Fehlermeldung).

## Mitteilungen an Gruppen

Kontakte bekommen Gruppen (z. B. „Tester“, „Validatoren“, „Community“). Eine Mitteilung an `gruppe:Tester` geht an jeden Kontakt über seinen besten Kanal, in seiner Sprache aus den 45 Sprachen der Toy-Projekte. Vor dem Senden zeigt die App jede Sprache als Vorschau. Gesendet wird erst nach Freigabe; in Team-Konten muss eine zweite Person freigeben.
