import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatToy, TOY_LANGUAGES, type ToyInvoiceSummary } from '@toypost/shared';
import { Button, Card, Chip, Divider, Field, Icon, Loading, Notice, Screen, Section } from '../components/base.tsx';
import { formatTime, Pill, SafetyNotes, ToyPaymentCard } from '../components/toy.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import type { BroadcastInfo, CheckResult } from '../api/types.ts';

const AMPEL_TEXT = {
  gruen: ['Grün', 'Alle Regeln der Kette sind eingehalten.'],
  gelb: ['Gelb', 'Auffälligkeit ohne Regelbruch, z. B. veraltete Daten oder Stake-Konzentration.'],
  rot: ['Rot', 'Eine Regel ist nachweislich gebrochen. Details in ToyScan.'],
  unbekannt: ['Unbekannt', 'ToyScan hat keinen eindeutigen Stand gemeldet.'],
} as const;

const INVOICE_STATUS: Record<ToyInvoiceSummary['status'], [string, 'blue' | 'yellow' | 'green' | 'grey']> = {
  open: ['Offen', 'blue'],
  partial: ['Teilweise bezahlt', 'yellow'],
  paid: ['Bezahlt', 'green'],
  expired: ['Abgelaufen', 'grey'],
};

const styles = (p: Palette) =>
  StyleSheet.create({
    ampel: { flexDirection: 'row', gap: space.lg, alignItems: 'center' },
    lamp: { width: 52, height: 52, borderRadius: 26, borderWidth: 4, borderColor: p.surface },
    lampLabel: { ...type.heading, color: p.ink },
    small: { ...type.small, color: p.inkSoft },
    caption: { ...type.caption, color: p.inkMuted },
    msRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm, alignItems: 'flex-start' },
    msId: { ...type.label, color: p.ink, width: 44 },
    msText: { ...type.small, color: p.ink, flex: 1 },
    subject: { ...type.label, color: p.ink, marginBottom: space.xs },
    body: { ...type.body, color: p.ink },
    langs: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap', marginVertical: space.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
    invRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space.md, gap: space.md },
    preview: { backgroundColor: p.paper, borderRadius: radius.control, padding: space.md, marginTop: space.sm },
  });

function BroadcastCard({ b, onDone }: { b: BroadcastInfo; onDone: (text: string, tone?: 'success' | 'error') => void }) {
  const s = useStyles(styles);
  const { api } = useSession();
  const [lang, setLang] = useState('de');
  const [preview, setPreview] = useState<{ subject: string; body: string; rtl: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const show = async (code: string) => {
    setLang(code);
    if (code === 'de') return setPreview(null);
    setBusy('preview');
    try {
      const r = await api.previewBroadcast(b.id, code);
      setPreview({ subject: r.subject, body: r.body, rtl: r.language.dir === 'rtl' });
    } catch (e) {
      onDone((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const langName = (code: string) => TOY_LANGUAGES.find((l) => l.code === code)?.name ?? code;
  return (
    <Card>
      <Text style={s.caption}>
        {b.audienceLabel} · {b.recipients} {b.recipients === 1 ? 'Empfänger' : 'Empfänger'} · {b.source}
      </Text>
      <View style={s.langs}>
        <Chip label="Deutsch" active={lang === 'de'} onPress={() => show('de')} />
        {b.languages.filter((l) => l !== 'de').map((l) => (
          <Chip key={l} label={langName(l)} active={lang === l} onPress={() => show(l)} />
        ))}
      </View>
      <View style={preview ? s.preview : undefined}>
        <Text style={[s.subject, preview?.rtl && { textAlign: 'right' }]}>{preview?.subject ?? b.subject}</Text>
        <Text style={[s.body, preview?.rtl && { textAlign: 'right' }]}>{preview?.body ?? b.body}</Text>
      </View>
      <View style={s.actions}>
        <Button
          small
          icon="send"
          label="Freigeben und senden"
          busy={busy === 'send'}
          onPress={async () => {
            setBusy('send');
            try {
              const r = await api.sendBroadcast(b.id);
              onDone(`Gesendet: ${r.results?.sent ?? 0} Nachrichten${r.results?.failed ? `, ${r.results.failed} fehlgeschlagen` : ''}.`);
            } catch (e) {
              onDone((e as Error).message, 'error');
            } finally {
              setBusy(null);
            }
          }}
        />
        <Button small variant="quiet" icon="trash-2" label="Verwerfen" onPress={async () => (await api.discardBroadcast(b.id), onDone('Mitteilung verworfen.'))} />
      </View>
    </Card>
  );
}

export function ToyScreen() {
  const nav = useNav();
  const s = useStyles(styles);
  const p = usePalette();
  const { api } = useSession();
  const overview = useLoad((a) => a.toyOverview(), []);
  const broadcasts = useLoad((a) => a.broadcasts(), []);
  const automations = useLoad((a) => a.automations(), []);
  const channels = useLoad((a) => a.channels(), []);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [inv, setInv] = useState({ address: '', amount: '', label: '' });
  const [created, setCreated] = useState<ToyInvoiceSummary | null>(null);
  const [checkText, setCheckText] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const say = (text: string, tone: 'success' | 'error' = 'success') => setMessage({ text, tone });
  const reloadAll = () => Promise.all([overview.reload(), broadcasts.reload(), automations.reload()]);

  const o = overview.data;
  const drafts = (broadcasts.data ?? []).filter((b) => b.status === 'draft');
  const installed = new Set((automations.data?.automations ?? []).map((a) => a.name));
  const githubId = channels.data?.channels.find((c) => c.kind === 'github')?.id;
  const announceId = channels.data?.channels.find((c) => ['ntfy', 'telegram', 'matrix', 'discord', 'slack', 'talk'].includes(c.kind))?.id;

  return (
    <Screen title="Toy-Projekte" onBack={nav.back}>
      {message ? (
        <View style={{ marginBottom: space.md }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </View>
      ) : null}
      {overview.loading && !o ? <Loading /> : null}

      <Card>
        {o?.ampel ? (
          <View style={s.ampel} accessible accessibilityLabel={`Warnampel ${AMPEL_TEXT[o.ampel.color][0]}`}>
            <View style={[s.lamp, { backgroundColor: { gruen: p.done, gelb: p.soon, rot: p.overdue, unbekannt: p.inkMuted }[o.ampel.color] }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.lampLabel}>Warnampel {AMPEL_TEXT[o.ampel.color][0]}</Text>
              <Text style={s.small}>{o.ampel.bigRedLamp ? 'Große rote Lampe: Obergrenze, Fair Launch oder Verfassung verletzt.' : AMPEL_TEXT[o.ampel.color][1]}</Text>
              <Text style={s.caption}>ToyScan, geprüft {formatTime(o.ampel.checkedAt)}</Text>
            </View>
          </View>
        ) : (
          <Text style={s.small}>Verbinde ToyScan unter Kanäle, dann siehst du hier die Warnampel der Kette.</Text>
        )}
      </Card>

      <Section title="Mitteilungen zur Freigabe" meta={drafts.length ? `${drafts.length}` : undefined}>
        {drafts.length ? (
          <View style={{ gap: space.md }}>
            {drafts.map((b) => (
              <BroadcastCard key={b.id} b={b} onDone={(text, tone) => (say(text, tone), reloadAll())} />
            ))}
          </View>
        ) : (
          <Card>
            <Text style={s.small}>Nichts wartet. Automationen legen hier Entwürfe ab, z. B. wenn ein Meilenstein fertig wird.</Text>
          </Card>
        )}
      </Section>

      {o?.milestones.length ? (
        <Section title="Fortschritt ToyChain" meta={`${o.milestones.filter((m) => m.done).length} von ${o.milestones.length} fertig`}>
          <Card>
            {o.milestones.map((m) => (
              <View key={m.id} style={s.msRow}>
                <Icon name={m.done ? 'check-circle' : 'circle'} size={18} color={m.done ? p.done : p.inkMuted} />
                <Text style={s.msId}>{m.id}</Text>
                <Text style={s.msText}>{m.title}</Text>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="TOY-Rechnungen" meta={o ? `${o.invoices.open} offen` : undefined}>
        <Card>
          {(o?.invoices.list ?? []).map((i, n) => (
            <View key={i.id}>
              {n > 0 ? <Divider /> : null}
              <View style={s.invRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[type.label, { color: p.ink }]}>{formatToy(BigInt(i.amount), 'de')}</Text>
                  <Text style={s.caption}>{i.purpose}</Text>
                </View>
                <Pill label={INVOICE_STATUS[i.status][0]} tone={INVOICE_STATUS[i.status][1]} />
              </View>
            </View>
          ))}
          <View style={{ gap: space.md, marginTop: space.md }}>
            <Field label="Empfangsadresse (deine TOYPAY-Adresse)" placeholder="0x…" autoCapitalize="none" value={inv.address} onChangeText={(v: string) => setInv({ ...inv, address: v })} />
            <Field label="Betrag in TOY" placeholder="12.5" keyboardType="decimal-pad" value={inv.amount} onChangeText={(v: string) => setInv({ ...inv, amount: v.replace(',', '.') })} />
            <Field label="Bezeichnung (optional)" placeholder="Validator-Hilfe" value={inv.label} onChangeText={(v: string) => setInv({ ...inv, label: v })} hint="Der Verwendungszweck bekommt einen Code wie TP-7K3QXP; daran erkennt ToyPost die Zahlung." />
            <Button
              icon="file-plus"
              label="Rechnung erstellen"
              busy={busy === 'invoice'}
              style={{ alignSelf: 'flex-start' }}
              onPress={async () => {
                setBusy('invoice');
                try {
                  const r = await api.createInvoice({ address: inv.address.trim(), amount: inv.amount.trim(), label: inv.label.trim() || undefined });
                  setCreated(r.invoice);
                  setInv({ address: inv.address, amount: '', label: '' });
                  await overview.reload();
                } catch (e) {
                  say((e as Error).message, 'error');
                } finally {
                  setBusy(null);
                }
              }}
            />
          </View>
          {created ? (
            <View style={{ marginTop: space.lg }}>
              <ToyPaymentCard
                link={created.link}
                address={created.address}
                amount={created.amount}
                purpose={created.purpose}
                hint="Zeige den QR-Code oder schicke den Link. Ist die Zahlung bei ToyScan sichtbar, schließt ToyPost die Rechnung selbst."
                onMessage={(t) => say(t)}
              />
            </View>
          ) : null}
        </Card>
      </Section>

      <Section title="Nachricht prüfen">
        <Card>
          <Field
            label="Verdächtige Nachricht einfügen"
            placeholder="z. B. eine Mail, die nach deiner Phrase fragt, oder eine Zahlungsaufforderung"
            multiline
            value={checkText}
            onChangeText={setCheckText}
          />
          <Button
            small
            icon="shield"
            label="Prüfen"
            busy={busy === 'check'}
            style={{ alignSelf: 'flex-start', marginTop: space.md }}
            onPress={async () => {
              setBusy('check');
              try {
                setCheck(await api.checkText(checkText));
              } catch (e) {
                say((e as Error).message, 'error');
              } finally {
                setBusy(null);
              }
            }}
          />
          {check ? (
            <View style={{ marginTop: space.md, gap: space.sm }}>
              {check.findings.length ? <SafetyNotes notes={check.findings} /> : <Notice tone="success">Keine bekannten Betrugsmuster gefunden. Prüfe Absender und Adresse trotzdem selbst.</Notice>}
              {check.toyRequest ? (
                <Text style={s.small}>
                  Enthält eine Zahlungsaufforderung{check.toyRequest.amount ? ` über ${formatToy(BigInt(check.toyRequest.amount), 'de')}` : ''} an {check.toyRequest.address}.
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>
      </Section>

      <Section title="Automationen">
        <Card>
          {(automations.data?.automations ?? []).map((a, n) => (
            <View key={a.id}>
              {n > 0 ? <Divider /> : null}
              <View style={{ paddingVertical: space.sm }}>
                <Text style={[type.label, { color: p.ink }]}>{a.name}</Text>
                <Text style={s.caption}>{a.runs ? `${a.runs}× ausgeführt, zuletzt ${formatTime(a.lastRunAt!)} · ${a.log[0]?.result ?? ''}` : 'Noch nicht ausgeführt'}</Text>
              </View>
            </View>
          ))}
        </Card>
        {(automations.data?.presets ?? [])
          .filter((pr) => !installed.has(pr.name))
          .map((pr) => (
            <Card key={pr.id} style={{ marginTop: space.md }}>
              <Text style={[type.label, { color: p.ink }]}>{pr.name}</Text>
              <Text style={[s.small, { marginTop: space.xs }]}>{pr.description}</Text>
              <Button
                small
                variant="secondary"
                icon="zap"
                label="Einrichten"
                busy={busy === pr.id}
                style={{ alignSelf: 'flex-start', marginTop: space.md }}
                onPress={async () => {
                  setBusy(pr.id);
                  try {
                    await api.installPreset(pr.id, { github: githubId, announce: announceId });
                    say(`„${pr.name}“ ist eingerichtet.`);
                    await automations.reload();
                  } catch (e) {
                    say((e as Error).message, 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            </Card>
          ))}
      </Section>

      <Text style={[s.caption, { marginTop: space.xl }]}>
        {o?.languages ?? 45} Sprachen und Begriffsliste wie TOYPAY Wallet und ToyScan (aus Safehaigit/toycoin). ToyPost hat keine Schlüssel und zahlt nie selbst.
      </Text>
    </Screen>
  );
}
