import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageSummary } from '@toypost/shared';
import { Button, Card, Chip, Divider, Empty, Loading, Notice, Screen } from '../components/base.tsx';
import { ChannelBadge, CHANNEL_NAME, formatTime, Pill } from '../components/toy.tsx';
import { useNav } from '../nav.ts';
import { useLoad } from '../session.tsx';
import { space, type, usePalette, useStyles, type Palette } from '../theme.ts';

type Filter = 'alle' | 'in' | 'out' | 'warnungen';

const styles = (p: Palette) =>
  StyleSheet.create({
    filters: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginBottom: space.lg },
    row: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, alignItems: 'flex-start' },
    who: { ...type.label, color: p.ink, flexShrink: 1 },
    meta: { ...type.caption, color: p.inkMuted },
    subject: { ...type.small, color: p.ink, fontWeight: '600', marginTop: 2 },
    preview: { ...type.small, color: p.inkSoft, marginTop: 2 },
    top: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm, alignItems: 'baseline' },
  });

function Line({ m, onOpen }: { m: MessageSummary; onOpen?: () => void }) {
  const s = useStyles(styles);
  const red = m.safety.some((f) => f.severity !== 'yellow');
  const yellow = !red && m.safety.length > 0;
  const who = m.contact?.name ?? m.channelName ?? CHANNEL_NAME[m.channelKind];
  return (
    <Pressable onPress={onOpen} disabled={!onOpen} accessibilityRole={onOpen ? 'button' : undefined} style={s.row}>
      <ChannelBadge kind={m.channelKind} direction={m.direction} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.top}>
          <Text style={s.who} numberOfLines={1}>
            {m.direction === 'out' ? `An ${who}` : who}
          </Text>
          <Text style={s.meta}>{formatTime(m.createdAt)}</Text>
        </View>
        <Text style={s.meta}>
          {CHANNEL_NAME[m.channelKind]}
          {m.channelName ? ` · ${m.channelName}` : ''}
          {m.language && m.language !== 'de' ? ` · ${m.language}` : ''}
        </Text>
        {m.subject ? (
          <Text style={s.subject} numberOfLines={1}>
            {m.subject}
          </Text>
        ) : null}
        <Text style={s.preview} numberOfLines={2}>
          {m.preview}
        </Text>
        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.xs, flexWrap: 'wrap' }}>
          {red ? <Pill label="Betrugsverdacht" tone="red" /> : null}
          {yellow ? <Pill label="Hinweis" tone="yellow" /> : null}
          {m.status === 'failed' ? <Pill label="Nicht gesendet" tone="red" /> : null}
          {m.status === 'blocked' ? <Pill label="Blockiert: Geheimnis" tone="red" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

/** One inbox for every channel: letters stay under "Vorgänge", here are e-mails, chats, SMS, feeds. */
export function InboxScreen() {
  const nav = useNav();
  const p = usePalette();
  const s = useStyles(styles);
  const [filter, setFilter] = useState<Filter>('alle');
  const { data, loading, error } = useLoad((a) => a.messages(filter === 'in' || filter === 'out' ? { direction: filter } : {}), [filter]);
  const list = (data ?? []).filter((m) => filter !== 'warnungen' || m.safety.length > 0);

  return (
    <Screen
      title="Posteingang"
      right={<Button small variant="quiet" icon="search" label="Suche" onPress={() => nav.go('/suche')} />}
    >
      <View style={s.filters}>
        {(
          [
            ['alle', 'Alle'],
            ['in', 'Eingang'],
            ['out', 'Gesendet'],
            ['warnungen', 'Warnungen'],
          ] as const
        ).map(([k, l]) => (
          <Chip key={k} label={l} active={filter === k} onPress={() => setFilter(k)} />
        ))}
      </View>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading && !data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty
          title={filter === 'warnungen' ? 'Keine Warnungen' : 'Noch keine Nachrichten'}
          text={filter === 'warnungen' ? 'ToyPost hat nichts Verdächtiges gefunden.' : 'Verbinde E-Mail, Telegram, SMS oder einen Feed unter Konto → Kanäle.'}
          action={filter === 'warnungen' ? undefined : <Button small label="Kanäle einrichten" onPress={() => nav.go('/kanaele')} />}
        />
      ) : (
        <Card style={{ paddingVertical: 0 }}>
          {list.map((m, i) => (
            <View key={m.id}>
              {i > 0 ? <Divider /> : null}
              <Line m={m} onOpen={m.caseId ? () => nav.go(`/vorgang/${m.caseId}`) : undefined} />
            </View>
          ))}
        </Card>
      )}
      <Text style={[type.caption, { color: p.inkMuted, marginTop: space.lg }]}>
        Recovery-Phrasen und private Schlüssel speichert und sendet ToyPost nie. Warnungen erscheinen immer, egal welche Ansicht du nutzt.
      </Text>
    </Screen>
  );
}
