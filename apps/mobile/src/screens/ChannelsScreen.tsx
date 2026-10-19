import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { MessageChannelKind } from '@toypost/shared';
import { Button, Card, Chip, Field, Loading, Notice, Screen, Section } from '../components/base.tsx';
import { ChannelBadge, formatTime, Pill } from '../components/toy.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import type { ChannelInfo } from '../api/types.ts';

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  number?: boolean;
  list?: boolean;
  optional?: boolean;
  hint?: string;
}

/** What each channel needs, with a sentence on where to find it. */
const FORMS: Partial<Record<MessageChannelKind, { purpose: string; fields: FieldDef[]; extra?: Record<string, unknown> }>> = {
  email: {
    purpose: 'Senden über deinen Mailserver (SMTP). Eingehende Mails leitet n8n oder ein Mail-Filter an den Eingang weiter.',
    fields: [
      { key: 'host', label: 'SMTP-Server', placeholder: 'smtp.beispiel.de' },
      { key: 'port', label: 'Port', placeholder: '587', number: true, optional: true },
      { key: 'user', label: 'Benutzer', placeholder: 'team@beispiel.de', optional: true },
      { key: 'password', label: 'Passwort', placeholder: 'App-Passwort des Postfachs', secret: true, optional: true },
      { key: 'from', label: 'Absender', placeholder: 'team@beispiel.de' },
      { key: 'fromName', label: 'Absendername', placeholder: 'ToyCoin-Team', optional: true },
    ],
  },
  telegram: {
    purpose: 'Ein eigener Bot: Nachrichten, Fotos und Dateien kommen direkt in ToyPost an. Token von @BotFather.',
    fields: [{ key: 'botToken', label: 'Bot-Token', placeholder: '123456:ABC…', secret: true }],
  },
  matrix: {
    purpose: 'Matrix/Element-Räume, z. B. für die Community. Zugangstoken eines eigenen ToyPost-Benutzers.',
    fields: [
      { key: 'homeserver', label: 'Homeserver', placeholder: 'https://matrix.beispiel.de' },
      { key: 'accessToken', label: 'Zugangstoken', placeholder: 'syt_…', secret: true },
      { key: 'defaultRoom', label: 'Standard-Raum', placeholder: '!abc123:beispiel.de', optional: true },
    ],
  },
  signal: {
    purpose: 'Über signal-cli-rest-api auf deinem Server, mit einer eigenen Nummer.',
    fields: [
      { key: 'url', label: 'Adresse von signal-cli-rest-api', placeholder: 'http://signal:8080' },
      { key: 'number', label: 'Signal-Nummer', placeholder: '+491701234567' },
    ],
  },
  sms: {
    purpose: 'Ein altes Android-Handy mit SIM-Karte und der App „SMS Gateway for Android“ wird zum SMS-Server.',
    fields: [
      { key: 'url', label: 'Adresse des Handys', placeholder: 'http://192.168.1.40:8080' },
      { key: 'user', label: 'Benutzer', placeholder: 'sms' },
      { key: 'password', label: 'Passwort', placeholder: 'aus der Gateway-App', secret: true },
    ],
    extra: { provider: 'android' },
  },
  ntfy: {
    purpose: 'Push-Nachrichten aufs Handy über ntfy, auch als UnifiedPush-Verteiler wie in der TOYPAY Wallet geplant.',
    fields: [
      { key: 'server', label: 'Server', placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: 'Thema', placeholder: 'toypost-geheimes-thema' },
      { key: 'token', label: 'Zugangstoken', placeholder: 'nur bei geschütztem Thema', secret: true, optional: true },
    ],
  },
  talk: {
    purpose: 'Nachrichten in eine Unterhaltung in Nextcloud Talk.',
    fields: [
      { key: 'url', label: 'Nextcloud', placeholder: 'https://cloud.beispiel.de' },
      { key: 'user', label: 'Benutzer', placeholder: 'toypost' },
      { key: 'appPassword', label: 'App-Passwort', placeholder: 'Einstellungen → Sicherheit', secret: true },
      { key: 'defaultToken', label: 'Unterhaltung (Token)', placeholder: 'aus der Talk-Adresse', optional: true },
    ],
  },
  discord: { purpose: 'Mitteilungen in einen Discord-Kanal über einen Webhook.', fields: [{ key: 'webhookUrl', label: 'Webhook-Adresse', placeholder: 'https://discord.com/api/webhooks/…', secret: true }] },
  slack: { purpose: 'Mitteilungen in einen Slack-Kanal über einen eingehenden Webhook.', fields: [{ key: 'webhookUrl', label: 'Webhook-Adresse', placeholder: 'https://hooks.slack.com/…', secret: true }] },
  webhook: {
    purpose: 'Eigene Dienste: ToyPost sendet JSON (signiert) und nimmt Nachrichten im einfachen Format an.',
    fields: [
      { key: 'url', label: 'Ziel-Adresse', placeholder: 'https://beispiel.de/hook' },
      { key: 'secret', label: 'Geheimnis für die Signatur', placeholder: 'beliebig, lang', secret: true, optional: true },
    ],
  },
  feed: {
    purpose: 'RSS, Atom oder JSON Feed: Projekt-Blogs, Behörden-Meldungen, Status-Seiten. Neue Einträge landen im Posteingang.',
    fields: [
      { key: 'url', label: 'Feed-Adresse', placeholder: 'https://blog.beispiel.de/feed.xml' },
      { key: 'everyMinutes', label: 'Abruf alle … Minuten', placeholder: '30', number: true, optional: true },
    ],
  },
  github: {
    purpose: 'Fortschritt der Toy-Projekte: Meilensteine aus docs/STATUS.md und neue Versionen. Mit Token auch Issues und Berichte.',
    fields: [
      { key: 'repo', label: 'Repository', placeholder: 'Safehaigit/toycoin' },
      { key: 'token', label: 'Token (fein granuliert)', placeholder: 'github_pat_…', secret: true, optional: true, hint: 'Lesen reicht für Meilensteine. Für Issues und Berichte: Issues und Pull Requests schreiben.' },
    ],
  },
  toyscan: {
    purpose: 'Warnampel und Zahlungseingänge von ToyScan. ToyPost liest nur, ohne Schlüssel.',
    fields: [
      { key: 'url', label: 'ToyScan-Adresse', placeholder: 'https://scan.toycoin.example' },
      { key: 'rpcUrl', label: 'ToyChain-Knoten (optional)', placeholder: 'http://localhost:8545', optional: true },
      { key: 'watchAddresses', label: 'Eigene Adressen beobachten', placeholder: '0x…, 0x…', list: true, optional: true },
    ],
  },
};

const styles = (p: Palette) =>
  StyleSheet.create({
    head: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
    name: { ...type.label, color: p.ink },
    meta: { ...type.small, color: p.inkSoft },
    purpose: { ...type.small, color: p.inkSoft, marginBottom: space.md },
    url: { ...type.caption, color: p.ink, marginTop: space.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
    kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  });

function ChannelCard({ c, onMessage }: { c: ChannelInfo; onMessage: (tone: 'success' | 'error', text: string) => void }) {
  const s = useStyles(styles);
  const p = usePalette();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <View style={s.head}>
        <ChannelBadge kind={c.kind} />
        <View style={{ flex: 1 }}>
          <Text style={s.name}>{c.name}</Text>
          <Text style={s.meta}>
            {c.kindLabel} · {c.summary}
          </Text>
        </View>
        {c.lastError ? <Pill label="Fehler" tone="red" /> : c.enabled ? <Pill label="Aktiv" tone="green" /> : <Pill label="Aus" tone="grey" />}
      </View>
      {c.lastError ? (
        <View style={{ marginTop: space.md }}>
          <Notice tone="error">{c.lastError}</Notice>
        </View>
      ) : null}
      {c.lastPollAt ? <Text style={[type.caption, { color: p.inkMuted, marginTop: space.sm }]}>Zuletzt abgerufen {formatTime(c.lastPollAt)}</Text> : null}
      {c.inboundUrl ? (
        <Text selectable style={s.url}>
          Eingang: {c.inboundUrl}
        </Text>
      ) : null}
      <View style={s.actions}>
        <Button
          small
          variant="secondary"
          icon={c.polled ? 'refresh-cw' : 'send'}
          label={c.polled ? 'Jetzt abrufen' : 'Test senden'}
          busy={busy}
          onPress={async () => {
            setBusy(true);
            try {
              onMessage('success', (await api.testChannel(c.id)).message);
            } catch (e) {
              onMessage('error', (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {c.inboundUrl ? (
          <Button
            small
            variant="quiet"
            icon="copy"
            label="Eingangsadresse kopieren"
            onPress={async () => {
              await Clipboard.setStringAsync(c.inboundUrl!);
              onMessage('success', 'Eingangsadresse kopiert. Sie enthält ein Geheimnis: nur in den jeweiligen Dienst eintragen.');
            }}
          />
        ) : null}
      </View>
    </Card>
  );
}

export function ChannelsScreen() {
  const nav = useNav();
  const s = useStyles(styles);
  const { api } = useSession();
  const { data, loading, error, reload } = useLoad((a) => a.channels(), []);
  const [kind, setKind] = useState<MessageChannelKind | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const form = kind ? FORMS[kind] : undefined;

  const save = async () => {
    if (!kind || !form) return;
    const missing = form.fields.find((f) => !f.optional && !values[f.key]?.trim());
    if (missing) return setMessage({ tone: 'error', text: `Bitte „${missing.label}“ ausfüllen.` });
    const config: Record<string, unknown> = { ...form.extra };
    for (const f of form.fields) {
      const v = values[f.key]?.trim();
      if (!v) continue;
      config[f.key] = f.number ? Number(v) : f.list ? v.split(/[\s,]+/).filter(Boolean) : v;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.createChannel({ kind, name: name.trim(), config });
      setKind(null);
      setValues({});
      setName('');
      setMessage({ tone: 'success', text: 'Kanal gespeichert. Mit „Test senden“ oder „Jetzt abrufen“ prüfst du die Verbindung.' });
      await reload();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Kanäle" onBack={nav.back}>
      {message ? (
        <View style={{ marginBottom: space.md }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </View>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading && !data ? <Loading /> : null}
      <View style={{ gap: space.md }}>
        {(data?.channels ?? []).map((c) => (
          <ChannelCard key={c.id} c={c} onMessage={(tone, text) => setMessage({ tone, text })} />
        ))}
      </View>

      <Section title="Kanal hinzufügen">
        <Card>
          <View style={s.kinds}>
            {(data?.kinds ?? []).map((k) => (
              <Chip key={k.kind} label={k.label.split(' (')[0]} active={kind === k.kind} onPress={() => (setKind(k.kind), setValues({}))} />
            ))}
          </View>
          {form ? (
            <View style={{ gap: space.md }}>
              <Text style={s.purpose}>{form.purpose}</Text>
              <Field label="Name in ToyPost" placeholder={data?.kinds.find((k) => k.kind === kind)?.label} value={name} onChangeText={setName} />
              {form.fields.map((f) => (
                <Field
                  key={f.key}
                  label={f.optional ? `${f.label} (optional)` : f.label}
                  placeholder={f.placeholder}
                  secureTextEntry={f.secret}
                  autoCapitalize="none"
                  value={values[f.key] ?? ''}
                  hint={f.hint}
                  onChangeText={(v: string) => setValues({ ...values, [f.key]: v })}
                />
              ))}
              <Button icon="plus" label="Kanal speichern" busy={busy} onPress={save} style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : (
            <Text style={s.purpose}>Wähle oben, was du verbinden willst. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.</Text>
          )}
        </Card>
      </Section>
    </Screen>
  );
}
