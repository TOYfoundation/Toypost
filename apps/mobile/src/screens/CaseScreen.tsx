import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { addDays, formatDateDe, formatEuro, formatIban, relativeDueDe, todayIso, type CaseDetail } from '@toypost/shared';
import { Button, Card, Chip, Divider, Field, Icon, Loading, Notice, Row, Screen, Section } from '../components/base.tsx';
import { DeadlineStamp } from '../components/case.tsx';
import { ChannelBadge, CHANNEL_NAME, formatTime, Pill, SafetyNotes, ToyPaymentCard } from '../components/toy.tsx';
import { useNav, useParam } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import { ApiError } from '../api/types.ts';

const STATUS_LABEL: Record<CaseDetail['status'], string> = {
  action: 'Offen',
  waiting: 'Wartet auf Antwort',
  info: 'Zur Info',
  done: 'Erledigt',
};

const CHANNEL_LABEL: Record<string, string> = {
  scan: 'Scan',
  mail: 'E-Mail',
  upload: 'Upload',
  nextcloud: 'Nextcloud',
  email: 'E-Mail',
  telegram: 'Telegram',
  matrix: 'Matrix',
  signal: 'Signal',
  sms: 'SMS',
  talk: 'Talk',
  webhook: 'Webhook',
  feed: 'Feed',
  github: 'GitHub',
  toyscan: 'ToyScan',
};

const styles = (p: Palette) =>
  StyleSheet.create({
    head: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start', marginBottom: space.lg },
    from: { ...type.small, color: p.inkMuted },
    title: { ...type.heading, color: p.ink },
    status: { ...type.caption, color: p.inkSoft, marginTop: space.xs },
    summary: { ...type.body, color: p.ink },
    explain: { ...type.small, color: p.inkSoft, marginTop: space.sm },
    quote: { ...type.small, color: p.inkMuted, fontStyle: 'italic', marginTop: space.xs },
    big: { ...type.heading, color: p.ink },
    mono: { ...type.body, color: p.ink, letterSpacing: 0.5 },
    qrBox: { alignSelf: 'flex-start', padding: space.md, backgroundColor: '#FFFFFF', borderRadius: 10, marginVertical: space.md },
    draftSubject: { ...type.label, color: p.ink, marginBottom: space.sm },
    draftBody: { ...type.body, color: p.ink },
    tl: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm },
    tlDate: { ...type.small, color: p.inkMuted, width: 76 },
    tlText: { ...type.small, color: p.ink, flex: 1 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xl },
  });

export function CaseScreen() {
  const id = useParam('id');
  const s = useStyles(styles);
  const p = usePalette();
  const nav = useNav();
  const { api, touch } = useSession();
  const { data: c, loading, error, reload } = useLoad((a) => a.caseDetail(id), [id]);
  const { data: giro } = useLoad((a) => (c?.payment ? a.giroCode(id) : Promise.resolve(null)), [id, c?.payment?.iban]);
  const [intent, setIntent] = useState('');
  const [tone, setTone] = useState<'sachlich' | 'freundlich' | 'bestimmt'>('sachlich');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const today = todayIso();

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      if (success) setMessage({ tone: 'success', text: success });
      touch();
      await reload();
    } catch (e) {
      const err = e as ApiError;
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !c) return <Screen onBack={nav.back}><Loading /></Screen>;
  if (error || !c) return <Screen onBack={nav.back}><Notice tone="error">{error ?? 'Vorgang nicht gefunden.'}</Notice></Screen>;

  const isFollowUp = c.status === 'waiting';
  const isScam = (c.safety ?? []).some((f) => f.severity !== 'yellow');

  return (
    <Screen onBack={nav.back}>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.from}>{c.correspondent}</Text>
          <Text accessibilityRole="header" style={s.title}>
            {c.title}
          </Text>
          <Text style={s.status}>
            {STATUS_LABEL[c.status]}
            {c.reference ? ` · ${c.reference}` : ''}
            {c.contact && c.contact.name !== c.correspondent ? ` · ${c.contact.name}` : ''}
          </Text>
        </View>
      </View>

      {c.safety?.length ? (
        <View style={{ marginBottom: space.md }}>
          <SafetyNotes notes={c.safety} />
        </View>
      ) : null}

      <Card>
        <Text style={s.summary}>{c.summary}</Text>
        {c.confidence < 0.8 ? (
          <View style={{ marginTop: space.md }}>
            <Notice tone="warning">ToyPost ist sich bei diesem Vorgang nicht sicher. Prüfe Absender und Frist; deine Korrektur wird zur Regel.</Notice>
          </View>
        ) : null}
      </Card>

      {message ? (
        <View style={{ marginTop: space.md }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </View>
      ) : null}

      {c.deadline && c.status === 'action' ? (
        <Section title="Frist" meta={relativeDueDe(c.deadline.date, today)}>
          <Card style={{ flexDirection: 'row', gap: space.lg, alignItems: 'center' }}>
            <DeadlineStamp deadline={c.deadline} today={today} size={72} />
            <View style={{ flex: 1 }}>
              <Text style={s.big}>{formatDateDe(c.deadline.date)}</Text>
              <Text style={s.explain}>{c.deadline.explanation}</Text>
              <Text style={s.quote}>„{c.deadline.phrase}“</Text>
            </View>
          </Card>
        </Section>
      ) : null}

      {c.payment && c.status === 'action' ? (
        <Section title="Zahlung" meta={formatEuro(c.payment.amountCents)}>
          <Card>
            <Text style={s.from}>Mit der Banking-App scannen</Text>
            {giro?.payload ? (
              <View style={s.qrBox} accessible accessibilityLabel="GiroCode für die Überweisung">
                <QRCode value={giro.payload} size={168} ecl="M" />
              </View>
            ) : null}
            <Row label="Empfänger" value={c.payment.recipient} />
            <Divider />
            <Row label="IBAN" value={formatIban(c.payment.iban)} />
            <Divider />
            {c.payment.reference ? (
              <>
                <Row label="Zweck" value={c.payment.reference} />
                <Divider />
              </>
            ) : null}
            <View style={s.actions}>
              <Button
                variant="secondary"
                small
                icon="copy"
                label="IBAN kopieren"
                onPress={async () => {
                  await Clipboard.setStringAsync(c.payment!.iban);
                  setMessage({ tone: 'success', text: 'IBAN kopiert.' });
                }}
              />
              <Button small icon="check" label="Bezahlt" busy={busy === 'paid'} onPress={() => run('paid', () => api.markPaid(c.id), 'Als bezahlt markiert und abgelegt.')} />
            </View>
          </Card>
        </Section>
      ) : null}

      {c.toyRequest && c.status === 'action' ? (
        <Section title="TOY-Zahlung" meta="über TOYPAY">
          <Card>
            <ToyPaymentCard
              link={c.toyRequest.link}
              address={c.toyRequest.address}
              amount={c.toyRequest.amount}
              purpose={c.toyRequest.purpose}
              hint="ToyPost zahlt nie selbst. Der Link öffnet deine TOYPAY Wallet; prüfe dort Adresse und Betrag, bevor du unterschreibst."
              onMessage={(t) => setMessage({ tone: 'success', text: t })}
            />
            <View style={s.actions}>
              <Button small variant="secondary" icon="check" label="Bezahlt" busy={busy === 'paid'} onPress={() => run('paid', () => api.markPaid(c.id), 'Als bezahlt markiert und abgelegt.')} />
            </View>
          </Card>
        </Section>
      ) : null}

      {c.toyInvoice ? (
        <Section title="Deine TOY-Rechnung" meta={c.toyInvoice.code}>
          <Card>
            <Pill
              label={{ open: 'Offen', partial: 'Teilweise bezahlt', paid: 'Bezahlt', expired: 'Abgelaufen' }[c.toyInvoice.status]}
              tone={{ open: 'blue', partial: 'yellow', paid: 'green', expired: 'grey' }[c.toyInvoice.status] as 'blue'}
            />
            {c.toyInvoice.status !== 'paid' ? (
              <View style={{ marginTop: space.md }}>
                <ToyPaymentCard
                  link={c.toyInvoice.link}
                  address={c.toyInvoice.address}
                  amount={(BigInt(c.toyInvoice.amount) - BigInt(c.toyInvoice.paid)).toString()}
                  purpose={c.toyInvoice.purpose}
                  hint="Sobald ToyScan die Zahlung mit diesem Verwendungszweck meldet, schließt ToyPost den Vorgang."
                  onMessage={(t) => setMessage({ tone: 'success', text: t })}
                />
              </View>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {isScam ? (
        <Section title="Was jetzt?">
          <Notice tone="warning">Nicht antworten, keine Links öffnen, nichts zahlen. Echte Stellen fragen nie nach Phrase oder Schlüssel. Markiere den Vorgang als erledigt; die Nachricht bleibt zur Beweissicherung gespeichert.</Notice>
        </Section>
      ) : null}

      {isScam ? null : <Section title={isFollowUp ? 'Erinnerung schreiben' : 'Antwort'} meta="5 Credits">
        {c.draft ? (
          <Card>
            <Text style={s.draftSubject}>{c.draft.subject}</Text>
            <Text selectable style={s.draftBody}>
              {c.draft.body}
            </Text>
            <View style={s.actions}>
              <Button
                small
                variant="secondary"
                icon="copy"
                label="Text kopieren"
                onPress={async () => {
                  await Clipboard.setStringAsync(`${c.draft!.subject}\n\n${c.draft!.body}`);
                  setMessage({ tone: 'success', text: 'Entwurf kopiert.' });
                }}
              />
              {c.contact ? (
                <Button
                  small
                  icon="send"
                  label={`An ${c.contact.name} senden`}
                  busy={busy === 'sendVia'}
                  onPress={() => run('sendVia', () => api.sendDraft(c.draft!.id, ''), `Über den Kanal von ${c.contact!.name} gesendet. ToyPost erinnert dich in 14 Tagen.`)}
                />
              ) : null}
              <Button
                small
                variant={c.contact ? 'quiet' : 'primary'}
                icon="check"
                label="Als versendet markieren"
                busy={busy === 'send'}
                onPress={() => run('send', () => api.sendDraft(c.draft!.id), 'Versendet. ToyPost erinnert dich in 14 Tagen, falls keine Antwort kommt.')}
              />
            </View>
          </Card>
        ) : (
          <Card>
            <Field
              label="Was soll drinstehen?"
              placeholder={isFollowUp ? 'z. B. Nach dem Stand der Bearbeitung fragen' : 'z. B. Ratenzahlung in 3 Raten anfragen'}
              value={intent}
              onChangeText={setIntent}
              hint="Stichworte reichen. Leer lassen für eine passende Standardantwort."
            />
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              {(['sachlich', 'freundlich', 'bestimmt'] as const).map((t) => (
                <Chip key={t} label={t[0].toUpperCase() + t.slice(1)} active={tone === t} onPress={() => setTone(t)} />
              ))}
            </View>
            <View style={s.actions}>
              <Button
                icon="edit-3"
                label="Entwurf schreiben"
                hint="5 Credits"
                busy={busy === 'draft'}
                onPress={() =>
                  run('draft', () =>
                    api.createDraft(c.id, {
                      intent: intent || (isFollowUp ? 'Nach dem Stand der Bearbeitung fragen' : undefined),
                      tone,
                    }),
                  )
                }
              />
            </View>
          </Card>
        )}
      </Section>}

      {c.messages?.length ? (
        <Section title="Nachrichten" meta={`${c.messages.length}`}>
          <Card style={{ paddingVertical: 0 }}>
            {c.messages.map((m, i) => (
              <View key={m.id}>
                {i > 0 ? <Divider /> : null}
                <View style={{ flexDirection: 'row', gap: space.md, paddingVertical: space.md }}>
                  <ChannelBadge kind={m.channelKind} direction={m.direction} />
                  <View style={{ flex: 1 }}>
                    <Text style={[type.small, { color: p.inkMuted }]}>
                      {m.direction === 'out' ? 'Gesendet' : 'Eingegangen'} {formatTime(m.createdAt)} · {CHANNEL_NAME[m.channelKind]}
                    </Text>
                    {m.subject ? <Text style={[type.label, { color: p.ink }]}>{m.subject}</Text> : null}
                    <Text selectable style={[type.small, { color: p.ink, marginTop: 2 }]}>
                      {m.body}
                    </Text>
                    {m.status === 'failed' || m.status === 'blocked' ? (
                      <View style={{ marginTop: space.xs }}>
                        <Pill label={m.status === 'blocked' ? 'Blockiert' : `Nicht gesendet: ${m.error ?? ''}`} tone="red" />
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      {c.documents.length ? <Section title="Dokumente" meta={`${c.documents.length}`}>
        <Card style={{ paddingVertical: 0 }}>
          {c.documents.map((d, i) => (
            <View key={d.id}>
              {i > 0 ? <Divider /> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
                <Icon name={d.direction === 'out' ? 'arrow-up-right' : 'arrow-down-left'} size={18} color={d.direction === 'out' ? p.done : p.stamp} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.label, { color: p.ink }]}>{d.title}</Text>
                  <Text style={[type.small, { color: p.inkMuted }]}>
                    {d.direction === 'out' ? 'Gesendet' : 'Eingegangen'} {formatDateDe(d.receivedAt.slice(0, 10))} · {CHANNEL_LABEL[d.channel]} · {d.pages}{' '}
                    {d.pages === 1 ? 'Seite' : 'Seiten'}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </Card>
      </Section> : null}

      <Section title="Verlauf">
        <View>
          {c.timeline.map((t, i) => (
            <View key={i} style={s.tl}>
              <Text style={s.tlDate}>{formatDateDe(t.at.slice(0, 10), false)}</Text>
              <Text style={s.tlText}>{t.text}</Text>
            </View>
          ))}
        </View>
      </Section>

      <View style={s.actions}>
        {c.status !== 'done' ? (
          <Button variant="secondary" icon="check" label="Erledigt" busy={busy === 'done'} onPress={() => run('done', () => api.updateCase(c.id, { status: 'done' }), 'Erledigt und abgelegt.')} />
        ) : (
          <Button variant="secondary" icon="rotate-ccw" label="Wieder öffnen" busy={busy === 'open'} onPress={() => run('open', () => api.updateCase(c.id, { status: 'action' }))} />
        )}
        {c.status === 'action' ? (
          <Button
            variant="quiet"
            icon="clock"
            label="In 7 Tagen erinnern"
            busy={busy === 'snooze'}
            onPress={() => run('snooze', () => api.updateCase(c.id, { status: 'waiting', followUpOn: addDays(today, 7) }), 'ToyPost erinnert dich in 7 Tagen.')}
          />
        ) : null}
      </View>
      {Platform.OS === 'web' ? <View style={{ height: space.xl }} /> : null}
    </Screen>
  );
}
