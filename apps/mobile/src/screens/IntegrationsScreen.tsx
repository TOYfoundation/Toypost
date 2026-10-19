import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button, Card, Field, Loading, Notice, Screen, Section } from '../components/base.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import type { IntegrationKind } from '../api/types.ts';

const FORMS: Record<IntegrationKind, { title: string; purpose: string; fields: { key: string; label: string; placeholder: string; secret?: boolean; hint?: string }[] }> = {
  paperless: {
    title: 'Paperless-ngx',
    purpose: 'Archiv und Texterkennung. Alle Post landet hier; ToyPost liest mit.',
    fields: [
      { key: 'url', label: 'Adresse', placeholder: 'https://paperless.beispiel.de' },
      { key: 'token', label: 'API-Token', placeholder: 'aus Paperless → Profil → API-Token', secret: true },
    ],
  },
  nextcloud: {
    title: 'Nextcloud',
    purpose: 'Fristen im Kalender, Entwürfe als Dateien.',
    fields: [
      { key: 'url', label: 'Adresse', placeholder: 'https://cloud.beispiel.de' },
      { key: 'user', label: 'Benutzername', placeholder: 'alex' },
      { key: 'appPassword', label: 'App-Passwort', placeholder: 'Einstellungen → Sicherheit → App-Passwort', secret: true, hint: 'Ein App-Passwort lässt sich jederzeit widerrufen, ohne dein Hauptpasswort zu ändern.' },
      { key: 'calendar', label: 'Kalender', placeholder: 'personal' },
    ],
  },
  n8n: {
    title: 'n8n',
    purpose: 'Eigene Abläufe: ToyPost meldet jedes Ereignis an deinen Workflow. Ab Team.',
    fields: [{ key: 'eventsUrl', label: 'Webhook-Adresse', placeholder: 'https://n8n.beispiel.de/webhook/toypost' }],
  },
};

const styles = (p: Palette) =>
  StyleSheet.create({
    head: { gap: 2 },
    title: { ...type.title, color: p.ink },
    purpose: { ...type.small, color: p.inkSoft, marginTop: 2, marginBottom: space.md },
    status: { ...type.caption },
    mono: { ...type.small, color: p.ink },
  });

function IntegrationForm({ kind, connected, summary }: { kind: IntegrationKind; connected: boolean; summary?: string }) {
  const s = useStyles(styles);
  const p = usePalette();
  const { api, touch } = useSession();
  const form = FORMS[kind];
  const [open, setOpen] = useState(!connected);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const missing = form.fields.find((f) => f.key !== 'calendar' && !values[f.key]?.trim());
    if (missing) {
      setError(`Bitte „${missing.label}“ ausfüllen.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveIntegration(kind, values);
      setOpen(false);
      touch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <View style={s.head}>
        <Text style={s.title}>{form.title}</Text>
        <Text style={[s.status, { color: connected ? p.done : p.inkMuted }]}>{connected ? `Verbunden · ${summary}` : 'Nicht verbunden'}</Text>
      </View>
      <Text style={s.purpose}>{form.purpose}</Text>
      {open ? (
        <View style={{ gap: space.md }}>
          {form.fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              hint={f.hint}
              secureTextEntry={f.secret}
              autoCapitalize="none"
              autoCorrect={false}
              value={values[f.key] ?? ''}
              onChangeText={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
            />
          ))}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label="Verbinden" busy={busy} onPress={save} />
            {connected ? <Button variant="quiet" label="Abbrechen" onPress={() => setOpen(false)} /> : null}
          </View>
        </View>
      ) : (
        <Button small variant="secondary" label="Zugang ändern" onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      )}
    </Card>
  );
}

export function IntegrationsScreen() {
  const s = useStyles(styles);
  const nav = useNav();
  const { data, loading, error } = useLoad((a) => a.integrations());
  const [copied, setCopied] = useState(false);

  return (
    <Screen title="Verbindungen" onBack={nav.back}>
      {loading && !data ? <Loading /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data ? (
        <View style={{ gap: space.md }}>
          {(['paperless', 'nextcloud', 'n8n'] as const).map((k) => (
            <IntegrationForm key={k} kind={k} connected={data[k].connected} summary={data[k].summary} />
          ))}
          <Section title="Neue Post aus Paperless melden">
            <Card>
              <Text style={[type.small, { marginBottom: space.sm }]}>
                Lege in Paperless einen Workflow „Dokument hinzugefügt“ mit dieser Webhook-Adresse an, oder nutze die n8n-Vorlage aus dem Repository.
              </Text>
              <Text selectable style={s.mono}>
                {data.webhookUrl}
              </Text>
              <Button
                small
                variant="secondary"
                icon={copied ? 'check' : 'copy'}
                label={copied ? 'Kopiert' : 'Adresse kopieren'}
                style={{ alignSelf: 'flex-start', marginTop: space.md }}
                onPress={async () => {
                  await Clipboard.setStringAsync(data.webhookUrl);
                  setCopied(true);
                }}
              />
            </Card>
          </Section>
        </View>
      ) : null}
    </Screen>
  );
}
