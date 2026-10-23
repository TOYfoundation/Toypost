# ToyPost und die Toy-Projekte: Schnittstelle

Stand 19.10.2026, ergänzt 24.10.2026 (Abschnitt 10, ToyVerse) · Vorschlag · Gilt für ToyPost (dieses Repository) und für `Safehaigit/toycoin` (ToyChain, TOYPAY Wallet, ToyScan).

ToyPost ist der Korrespondenz-Assistent im Toy-Ökosystem: Er liest Post aus allen Kanälen (Brief, E-Mail, Telegram, SMS, Matrix, Signal, Feeds), erkennt TOY-Zahlungsaufforderungen und Betrugsversuche, verschickt Rechnungen in TOY und hält Tester und Community über den Fortschritt der Projekte auf dem Laufenden, in ihren Sprachen.

Dieses Dokument legt fest, worauf sich beide Seiten verlassen. Wo toycoin schon etwas festgelegt hat, übernimmt ToyPost das wörtlich. Wo noch nichts festgelegt ist (ToyChain ist bei M1, RPC kommt in M7, ToyScan in M11), steht hier ein **Vorschlag**, den ToyPost bereits tolerant umsetzt.

## 1. Grundsätze

| Regel aus toycoin | Umsetzung in ToyPost |
|---|---|
| ToyScan hat nie Schlüssel (Entscheidung 56) | ToyPost hat keine Schlüssel, signiert nie und sendet nie TOY. Bezahlt wird immer in der TOYPAY Wallet über einen `toychain:`-Link. |
| Beträge als ganze Zahlen in kleinsten Einheiten, nie Fließkomma | `bigint` in kleinsten Einheiten, 18 Dezimalstellen, Obergrenze 10^26. Über Schnittstellen als Dezimaltext. |
| Adressen wie Ethereum (secp256k1, Keccak-256, EIP-55) | Adressen werden mit EIP-55-Prüfsumme geprüft; falsche Prüfsumme gilt als Tippfehler oder Manipulation. |
| Phrase und Schlüssel nie loggen, nie im Klartext speichern | Ausgehende Nachrichten mit Phrase oder privatem Schlüssel werden blockiert; eingehende werden vor dem Speichern geschwärzt. |
| Musterkennung nur als Warnung (Spezifikation 8, Ebene C) | Betrugserkennung erzeugt nur Warnungen, nie Eingriffe. |
| 45 Sprachen, gemeinsame Begriffsliste (Entscheidung 103) | ToyPost übernimmt `i18n/sprachen.tsv` und `i18n/begriffe.tsv` per Skript (`tools/toy-i18n-sync.mjs`) und übersetzt Mitteilungen mit diesen Begriffen. |
| Nur nativer Coin, keine Token, keine Verträge (Entscheidung 36) | ToyPost nutzt nur Überweisung mit Verwendungszweck. Alte ToyCoin-Token auf Ethereum und Polygon werden als „nicht ToyChain-TOY“ gewarnt (Entscheidung 63). |

## 2. Zahlungslink `toychain:`

Grundlage: TOYPAY-Konzept 04, Abschnitt 7a („nach dem Vorbild von BIP-21 und EIP-681: `toychain:<adresse>?betrag=…&zweck=…`“).

```
toychain:<adresse>[?betrag=<TOY>][&zweck=<text>][&nachricht=<text>][&bis=<JJJJ-MM-TT>]
```

| Parameter | Bedeutung | Regel |
|---|---|---|
| `<adresse>` | Empfänger | 0x + 40 Hex-Zeichen, EIP-55-Prüfsumme wird geprüft, wenn Groß- und Kleinbuchstaben gemischt sind |
| `betrag` | Betrag in **TOY** (nicht kleinste Einheiten) | Dezimalzahl mit Punkt, höchstens 18 Nachkommastellen, höchstens 100.000.000. Kein Exponent, kein Komma |
| `zweck` | Verwendungszweck, geht mit auf die Kette | höchstens **32 Byte** UTF-8 (Spezifikation 7.2), Prozent-kodiert |
| `nachricht` | Hinweis für den Zahler | nur in der Wallet sichtbar, nie auf der Kette |
| `bis` | Zahlungsanforderung gilt bis | Datum JJJJ-MM-TT, für „Rechnungen mit Status“ (TOYPAY 7c) |

- Unbekannte Parameter werden behalten und ignoriert.
- Unbekannte Parameter mit Vorsilbe `req-` machen den Link ungültig (wie BIP-21), damit eine ältere Wallet keine Pflichtangabe überliest.
- Umsetzung und Tests: `packages/shared/src/toy/payment-link.ts`.

**Beispiel**

```
toychain:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed?betrag=12.5&zweck=TP-7K3QXP%20Validator-Hilfe&bis=2026-11-02
```

## 3. Verwendungszweck für Rechnungen

ToyPost schreibt Rechnungen mit einem eindeutigen Code: `TP-` und sechs Zeichen aus `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (ohne 0/O und 1/I), optional gefolgt von Leerzeichen und Bezeichnung, insgesamt höchstens 32 Byte.

Eine eingehende Überweisung gehört zur Rechnung, wenn

1. der Empfänger die Rechnungsadresse ist und
2. der Verwendungszweck (ohne Groß-/Kleinschreibung) genau `TP-<code>` ist oder mit `TP-<code> ` beginnt.

Dieselbe Transaktion zählt nur einmal. Teilzahlungen werden addiert; ab dem vollen Betrag ist die Rechnung bezahlt. **Wunsch an die Wallet:** den Verwendungszweck aus dem Link unverändert übernehmen und dem Nutzer nicht zum Bearbeiten anbieten, oder nur am Ende ergänzen.

## 4. Daten von ToyScan

Grundlage: ToyScan-Konzept 05, Abschnitte 3 und 8. ToyPost nutzt:

| Pfad | Wofür in ToyPost |
|---|---|
| `GET /api/v1/ampel` | Warnampel überwachen; bei Rot Push an den Betreiber und Notfall-Mitteilung zum Freigeben (Notfall-Plan, Entscheidung 88) |
| `GET /api/v1/supply` | Kennzahlen im monatlichen Transparenz-Bericht |
| `GET /api/v1/address/{adresse}` | Zahlungseingänge auf Rechnungsadressen (Rückfallweg, wenn kein Alarm kommt) |
| `POST /api/v1/alarm` | Adress-Alarm per Webhook abonnieren (bevorzugter Weg) |

**Vorschlag für die Felder** (ToyPost liest deutsche und englische Namen):

```jsonc
// GET /api/v1/ampel
{
  "farbe": "gruen",                 // gruen | gelb | rot
  "grosseRoteLampe": false,         // true, wenn A1, A2 oder A5 rot
  "kriterien": [ { "nr": "A1", "farbe": "gruen", "hinweis": "…" } ],
  "block": 123456, "blockHash": "0x…"
}

// Adress-Alarm (Webhook) und Einträge unter "transaktionen" bei /api/v1/address/{adresse}
{
  "transaktion": {
    "hash": "0x…",
    "von": "0x…", "an": "0x…",
    "betrag": { "wert": "12500000000000000000", "formatiert": "12,5 TOY" },  // oder direkt "12500000000000000000"
    "zweck": "TP-7K3QXP Validator-Hilfe",
    "block": 123456, "zeit": "2026-10-19T10:00:00Z"
  }
}
```

- Beträge als Dezimaltext in kleinsten Einheiten, wie in Konzept 05 Abschnitt 3 festgelegt.
- ToyChain ist nach einem Block endgültig; ToyPost bucht deshalb jede gemeldete Transaktion sofort.
- **Datenschutz:** Konzept 04, Abschnitt 7e, warnt, dass der Adress-Alarm die Benachrichtigungsadresse mit dem Konto verknüpft. ToyPost abonniert ihn deshalb nur für eigene Rechnungsadressen des Betreibers, nie für Adressen von Kontakten.
- **Wunsch an ToyScan:** der Webhook signiert mit einem Geheimnis, das beim Abonnieren entsteht (Kopfzeile `x-toyscan-signature`, HMAC-SHA256 des Rohinhalts). ToyPost nimmt bis dahin ein Token in der Adresse an.

## 5. Daten vom ToyChain-Knoten

ToyPost liest optional direkt vom Knoten (Bauplan M7): `eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `toy_getSupply`, `toy_getEpoch`, `toy_getBootstrap`, `toy_getConstitution`. Es schreibt nie (`eth_sendRawTransaction` wird nicht benutzt).

## 6. Anmelden mit Adresse (EIP-4361)

Grundlage: TOYPAY-Konzept 04, Abschnitt 7b („Anmelden mit Adresse nach Sign-In with Ethereum“).

ToyPost bietet die Anmeldung mit der TOYPAY Wallet an:

1. `GET /v1/auth/wallet/nonce` liefert Nonce, Domain und Adresse von ToyPost.
2. Die Wallet zeigt die Nachricht nach EIP-4361 im Klartext und signiert sie mit `personal_sign` (EIP-191).
3. `POST /v1/auth/wallet` prüft Domain, Nonce (einmalig, 10 Minuten), Zeitpunkt und Unterschrift und meldet an.

**Chain-ID:** Entscheidung 40 legt die ToyChain-Chain-ID erst vor dem Testnet fest. Bis dahin nimmt ToyPost jede Chain-ID an; mit `TOYCHAIN_CHAIN_IDS` lässt sie sich festlegen. **Wunsch:** die gewählte ID für Testnet und Mainnet in `docs/01-spezifikation.md` eintragen, dann setzt ToyPost sie als Standard.

## 7. Projekt-Fortschritt

ToyPost liest aus `Safehaigit/toycoin`:

- **`docs/STATUS.md`**, Tabelle „Überblick Meilensteine“: Zeilen `| M2 | Inhalt | ✅ fertig … |`. Ein Meilenstein gilt als fertig, wenn die Status-Spalte „✅“ oder „fertig“ enthält. **Wunsch:** dieses Tabellenformat beibehalten.
- **Releases** auf GitHub.

Daraus entstehen Mitteilungen an Gruppen (z. B. „Tester“, „Community“), die erst nach Freigabe durch einen Menschen und in der Sprache jedes Empfängers verschickt werden.

**Transparenz-Bericht:** Spezifikation 15 sieht ab Testnet-Start einen monatlichen Bericht in `docs/berichte/` vor. ToyPost erstellt einen Entwurf (Fortschritt, Warnampel, Kennzahlen, Zahl der Nachrichten und Warnungen, ohne Namen) und schlägt ihn als Pull Request `docs/berichte/JJJJ-MM.md` vor. Zusammengeführt wird nur von Hand.

## 8. Rückmeldungen und Sicherheitsmeldungen

- Fehlermeldungen aus E-Mail, Telegram oder SMS kann ToyPost als Issue anlegen, **ohne** Namen, Telefonnummer oder Adresse des Absenders.
- Meldungen, die nach Sicherheitslücke klingen, werden **nie** öffentlich. Der Absender bekommt den Meldeweg aus `SECURITY.md` (private Sicherheitsmeldung auf GitHub oder direkt an den Inhaber).

## 9. Offene Punkte für toycoin

1. Format von `/api/v1/ampel` und des Adress-Alarms (Abschnitt 4) bestätigen oder anpassen.
2. Signatur des Adress-Alarms festlegen.
3. Parameter `nachricht` und `bis` im Zahlungslink aufnehmen; Verhalten der Wallet beim Verwendungszweck (Abschnitt 3).
4. ~~Chain-ID für Testnet und Mainnet (Entscheidung 40).~~ **Erledigt (Entscheidung 116, 20.10.2026):** Mainnet 7630713, Testnet 7630714, lokales Devnet 7630715. ToyPost kann `TOYCHAIN_CHAIN_IDS` damit vorbelegen.
5. Format der Meilenstein-Tabelle in `docs/STATUS.md` als stabil kennzeichnen.
6. ToyVerse-Ergänzung (Abschnitt 10) bestätigen, sobald ToyScan-Pfade B1 bis B4 und ToyCash feststehen.

## 10. ToyPost im ToyVerse (Ergänzung vom 24.10.2026, Vorschlag)

Mit Entscheidung 117 gehört ToyPost zum **ToyVerse** (Überblick: `docs/spaeter/11-toyverse.md` in `Safehaigit/toycoin`). ToyCash und TOYQUEST-Items kommen erst später. Die Grundsätze aus Abschnitt 1 gelten unverändert: keine Schlüssel, nie Geld senden, Muster nur als Warnung.

| Bereich | Was ToyPost tun soll | Grundlage |
|---|---|---|
| **ToyVerse-Ampel** | `GET /api/v1/toyverse/ampel` (B1 bis B4) überwachen. Gelb und Rot gehen als Push an den Betreiber und als Entwurf zur Freigabe an die passende Gruppe. Die große rote Lampe bleibt nur bei A1, A2, A5 | ToyScan-Konzept 05, Abschnitt 11 |
| **Transparenz-Bericht** | zusätzlich Kennzahlen aus `/api/v1/toyverse/wirtschaft`, `/api/v1/toycash`, `/api/v1/toyquest/topf`: Emission, Gebührenfluss, Topf, ToyCash-Umlauf gegenüber Reserve. Keine Prognosen, keine Renditen | Entscheidung 117, 121 |
| **Betrugsschutz** | neue Muster warnen: falsche Prägeseiten, Angebote „ToyCash kaufen mit Rendite“, „Topf-Auszahlung“ gegen Vorkasse, Anfragen nach Gutschein-Codes, gefälschte Mint-Gutscheine | ToyVerse 11, Abschnitt 6 |
| **Geheimnisse** | Codes von ToyCash-Inhaber-Gutscheinen wie Phrase und Schlüssel behandeln: in ausgehenden Nachrichten blockieren, eingehend schwärzen. Sie sind wie Bargeld | ToyCash 12, Abschnitt 5.3 |
| **ToyCash-Rechnungen** | erst ab ToyCash Stufe 2: Rechnung als Zahlungsaufforderung, die die Wallet öffnet. ToyPost sieht nie Beträge anderer, nur die Bestätigung der eigenen Rechnung. Format später | ToyCash 12 |
| **Community-Gruppen** | Kontaktgruppen für Mentoren, Händler, Knotenbetreiber, Gilden, Ersteller zusätzlich zu Tester, Validatoren, Community. Massenversand nur nach Freigabe | ToyVerse 11, Abschnitt 5 |
| **Mitteilungen aus TOYQUEST** | Meilensteine der Lernwelt (neue Orte, neue Maschinen, Saisonstart) als Vorlage für Mitteilungen. Texte aus derselben geprüften Wissensbasis wie die NPCs | Lernwelt `toypay/docs/08_LERNWELT_ZEITREISE.md`, Abschnitt 5 |
| **Begriffe** | neue Einträge in `i18n/begriffe.tsv` (ToyVerse, ToyCash, Note, Siegel, Anker, Offline-Rahmen, Rückholfrist, Gutschein, Prägegebühr, POL-Topf) über `tools/toy-i18n-sync.mjs` übernehmen | Entscheidung 103 |
| **Alte ToyCoin-Token** | Warnung „nicht ToyChain-TOY, nicht eintauschbar“ bleibt (Nr. 63). Falls Nr. 122 die Token für die Prägegebühr zulässt, Text ergänzen: „bezahlt nur Prägegebühren“ | Entscheidung 63, 122 |
