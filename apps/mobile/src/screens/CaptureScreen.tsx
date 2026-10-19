import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { formatDateDe } from '@dokufy/shared';
import { Button, Card, Field, Icon, Notice, Screen, Section, type IconName } from '../components/base.tsx';
import { useNav } from '../nav.ts';
import { useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import type { UploadInput, UploadResult } from '../api/types.ts';

const styles = (p: Palette) =>
  StyleSheet.create({
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.lg,
      padding: space.lg,
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.line,
    },
    optionIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: p.stampSoft, alignItems: 'center', justifyContent: 'center' },
    optionTitle: { ...type.label, color: p.ink },
    optionText: { ...type.small, color: p.inkMuted },
    toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
    toggleTitle: { ...type.label, color: p.ink },
    toggleText: { ...type.small, color: p.inkMuted },
    lead: { ...type.body, color: p.inkSoft, marginBottom: space.lg },
  });

async function blobToBase64(uri: string): Promise<{ base64: string; size: number }> {
  const blob = await (await fetch(uri)).blob();
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), size: blob.size };
}

function Option({ icon, title, text, onPress }: { icon: IconName; title: string; text: string; onPress: () => void }) {
  const s = useStyles(styles);
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.option, pressed && { opacity: 0.75 }]}>
      <View style={s.optionIcon}>
        <Icon name={icon} color={p.stamp} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.optionTitle}>{title}</Text>
        <Text style={s.optionText}>{text}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={p.inkMuted} />
    </Pressable>
  );
}

export function CaptureScreen() {
  const s = useStyles(styles);
  const p = usePalette();
  const nav = useNav();
  const { api, touch } = useSession();
  const [premiumOcr, setPremiumOcr] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  const send = async (input: UploadInput) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.upload(input);
      setResult(r);
      touch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Ohne Kamerazugriff kann Dokufy keine Briefe fotografieren. Erlaube den Zugriff in den Einstellungen oder wähle eine Datei.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true, allowsMultipleSelection: false });
    if (shot.canceled || !shot.assets[0]?.base64) return;
    const a = shot.assets[0];
    await send({ channel: 'scan', pages: 1, premiumOcr, file: { name: a.fileName ?? 'scan.jpg', mime: a.mimeType ?? 'image/jpeg', base64: a.base64! } });
  };

  const fromFile = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets[0]) return;
    const a = picked.assets[0];
    if ((a.size ?? 0) > 20 * 1024 * 1024) {
      setError('Die Datei ist größer als 20 MB. Teile sie auf oder verkleinere sie.');
      return;
    }
    const { base64 } = await blobToBase64(a.uri);
    await send({ channel: 'upload', pages: 1, premiumOcr, file: { name: a.name, mime: a.mimeType ?? 'application/pdf', base64 } });
  };

  const fromText = async () => {
    if (text.trim().length < 20) {
      setError('Füge mindestens einen Satz aus dem Schreiben ein.');
      return;
    }
    await send({ channel: 'upload', pages: 1, premiumOcr: false, text });
    setText('');
    setPasting(false);
  };

  return (
    <Screen title="Post erfassen">
      <Text style={s.lead}>Dokufy liest das Schreiben, erkennt Absender, Frist und Betrag und legt es im passenden Vorgang ab.</Text>

      {result ? (
        result.queued ? (
          <Notice tone="success">{result.message}</Notice>
        ) : (
          <Card>
            <Notice tone="success">
              {result.createdCase ? 'Neuer Vorgang angelegt' : 'Zum bestehenden Vorgang gelegt'}
              {result.matchedRule ? ' (per Regel, ohne Credits)' : ` · ${result.creditsSpent} ${result.creditsSpent === 1 ? 'Credit' : 'Credits'}`}
            </Notice>
            <Text style={[type.title, { color: p.ink, marginTop: space.md }]}>{result.case.title}</Text>
            <Text style={[type.small, { color: p.inkSoft }]}>
              {result.case.correspondent}
              {result.case.deadline ? ` · Frist ${formatDateDe(result.case.deadline.date)}` : ''}
            </Text>
            <Button label="Vorgang öffnen" style={{ marginTop: space.md, alignSelf: 'flex-start' }} onPress={() => nav.go(`/vorgang/${result.caseId}`)} />
          </Card>
        )
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {busy ? <Notice tone="info">Wird gelesen und eingeordnet …</Notice> : null}

      <View style={{ gap: space.md, marginTop: space.lg }}>
        <Option icon="camera" title="Brief fotografieren" text="Mehrseitig: jede Seite einzeln, Dokufy fügt sie zusammen" onPress={fromCamera} />
        <Option icon="file" title="PDF oder Bild wählen" text="Aus Dateien, Downloads oder der Cloud" onPress={fromFile} />
        <Option icon="clipboard" title="Text einfügen" text="Für E-Mails und Schreiben aus Portalen" onPress={() => setPasting((v) => !v)} />
      </View>

      {pasting ? (
        <Card style={{ marginTop: space.md }}>
          <Field label="Text des Schreibens" multiline value={text} onChangeText={setText} placeholder="Absender, Datum und Inhalt einfügen" />
          <Button label="Auswerten" hint="1 Credit" busy={busy} style={{ marginTop: space.md, alignSelf: 'flex-start' }} onPress={fromText} />
        </Card>
      ) : null}

      <Section title="Optionen">
        <Card>
          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleTitle}>Premium-Texterkennung</Text>
              <Text style={s.toggleText}>Für Handschrift und schlechte Scans · 1 Credit je Seite</Text>
            </View>
            <Switch
              accessibilityLabel="Premium-Texterkennung"
              value={premiumOcr}
              onValueChange={setPremiumOcr}
              trackColor={{ true: p.stamp, false: p.line }}
            />
          </View>
        </Card>
        <Notice tone="info">E-Mails mit Anhängen holt Paperless automatisch aus deinem Postfach, sobald es unter Konto → Verbindungen eingerichtet ist.</Notice>
      </Section>
    </Screen>
  );
}
