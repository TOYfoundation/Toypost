import { Linking, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { formatToy, shortAddress, type MessageChannelKind, type SafetyNote } from '@toypost/shared';
import { Button, Divider, Icon, Notice, Row, type IconName } from './base.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

export const CHANNEL_ICON: Record<MessageChannelKind, IconName> = {
  email: 'mail',
  telegram: 'send',
  matrix: 'hash',
  signal: 'shield',
  sms: 'smartphone',
  ntfy: 'bell',
  talk: 'message-square',
  discord: 'message-circle',
  slack: 'slack',
  webhook: 'link',
  feed: 'rss',
  github: 'github',
  toyscan: 'activity',
};

export const CHANNEL_NAME: Record<MessageChannelKind, string> = {
  email: 'E-Mail',
  telegram: 'Telegram',
  matrix: 'Matrix',
  signal: 'Signal',
  sms: 'SMS',
  ntfy: 'Push',
  talk: 'Talk',
  discord: 'Discord',
  slack: 'Slack',
  webhook: 'Webhook',
  feed: 'Feed',
  github: 'GitHub',
  toyscan: 'ToyScan',
};

const styles = (p: Palette) =>
  StyleSheet.create({
    badge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.stampSoft },
    qrBox: { alignSelf: 'flex-start', padding: space.md, backgroundColor: '#FFFFFF', borderRadius: 10, marginVertical: space.md },
    note: { ...type.small, color: p.inkSoft },
    amount: { ...type.heading, color: p.ink },
    mono: { ...type.small, color: p.ink, fontFamily: 'monospace' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
    pill: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill },
    pillText: { ...type.caption, fontWeight: '600' },
  });

export function ChannelBadge({ kind, direction }: { kind: MessageChannelKind; direction?: 'in' | 'out' }) {
  const s = useStyles(styles);
  const p = usePalette();
  return (
    <View style={[s.badge, direction === 'out' && { backgroundColor: p.doneSoft }]} accessibilityLabel={CHANNEL_NAME[kind]}>
      <Icon name={CHANNEL_ICON[kind]} size={17} color={direction === 'out' ? p.done : p.stamp} />
    </View>
  );
}

/** Warnings are never hidden: the same in every mode, like the wallet's red warnings. */
export function SafetyNotes({ notes }: { notes?: SafetyNote[] }) {
  if (!notes?.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {notes.map((n, i) => (
        <Notice key={i} tone={n.severity === 'yellow' ? 'warning' : 'error'}>
          {n.message}
        </Notice>
      ))}
    </View>
  );
}

export function Pill({ label, tone }: { label: string; tone: 'red' | 'yellow' | 'green' | 'blue' | 'grey' }) {
  const s = useStyles(styles);
  const p = usePalette();
  const c = { red: [p.overdue, p.overdueSoft], yellow: [p.soon, p.soonSoft], green: [p.done, p.doneSoft], blue: [p.stamp, p.stampSoft], grey: [p.inkSoft, p.line] }[tone];
  return (
    <View style={[s.pill, { backgroundColor: c[1] }]}>
      <Text style={[s.pillText, { color: c[0] }]}>{label}</Text>
    </View>
  );
}

/**
 * A TOY payment as QR code and toychain: link. ToyPost never pays itself: the link opens the TOYPAY wallet,
 * where the user checks address and amount and signs.
 */
export function ToyPaymentCard({
  link,
  address,
  amount,
  purpose,
  hint,
  onMessage,
}: {
  link: string;
  address: string;
  amount?: string;
  purpose?: string;
  hint: string;
  onMessage: (text: string) => void;
}) {
  const s = useStyles(styles);
  return (
    <View>
      {amount ? <Text style={s.amount}>{formatToy(BigInt(amount), 'de')}</Text> : null}
      <Text style={s.note}>{hint}</Text>
      <View style={s.qrBox} accessible accessibilityLabel="QR-Code mit dem toychain-Zahlungslink">
        <QRCode value={link} size={168} ecl="M" />
      </View>
      <Row label="An" value={shortAddress(address)} />
      <Divider />
      <Text selectable style={[s.mono, { paddingVertical: space.sm }]}>
        {address}
      </Text>
      {purpose ? (
        <>
          <Divider />
          <Row label="Verwendungszweck" value={purpose} />
        </>
      ) : null}
      <View style={s.actions}>
        <Button small icon="external-link" label="In TOYPAY öffnen" onPress={() => Linking.openURL(link).catch(() => onMessage('Keine Wallet für toychain:-Links gefunden. Kopiere den Link.'))} />
        <Button
          small
          variant="secondary"
          icon="copy"
          label="Link kopieren"
          onPress={async () => {
            await Clipboard.setStringAsync(link);
            onMessage('Zahlungslink kopiert.');
          }}
        />
      </View>
    </View>
  );
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
