import { Pressable, StyleSheet, Text, View } from 'react-native';
import { daysBetween, formatDateDe, formatEuro, type CaseSummary, type Deadline } from '@dokufy/shared';
import { radius, space, type, urgencyColors, urgencyOf, usePalette, useStyles, type Palette } from '../theme.ts';
import { Button, Icon } from './base.tsx';

const DEADLINE_WORD: Record<Deadline['kind'], string> = {
  zahlung: 'Zahlen bis',
  einspruch: 'Einspruch bis',
  antwort: 'Antworten bis',
  kuendigung: 'Kündigen bis',
  allgemein: 'Frist',
};

/**
 * Der Fristen-Stempel: das eine laute Element der App.
 * Leicht schräg wie ein Eingangsstempel, Farbe nach Dringlichkeit.
 */
export function DeadlineStamp({ deadline, today, size = 64 }: { deadline?: Deadline; today: string; size?: number }) {
  const p = usePalette();
  const days = deadline ? daysBetween(today, deadline.date) : null;
  const u = urgencyOf(days);
  const c = urgencyColors(p, u);
  let big = '–';
  let small = 'keine Frist';
  if (days !== null) {
    if (days < 0) {
      big = String(-days);
      small = -days === 1 ? 'Tag drüber' : 'Tage drüber';
    } else if (days === 0) {
      big = '!';
      small = 'heute';
    } else {
      big = String(days);
      small = days === 1 ? 'Tag' : 'Tage';
    }
  }
  const label = days === null ? 'Keine Frist' : days < 0 ? `Frist seit ${-days} Tagen abgelaufen` : days === 0 ? 'Frist heute' : `Frist in ${days} Tagen`;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: days === null ? p.line : c.fg,
        backgroundColor: c.bg,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ rotate: days === null ? '0deg' : '-4deg' }],
      }}
    >
      <Text style={{ ...type.display, fontSize: size * 0.42, lineHeight: size * 0.48, color: days === null ? p.inkMuted : c.fg }}>{big}</Text>
      <Text style={{ ...type.caption, fontSize: 11, lineHeight: 13, color: days === null ? p.inkMuted : c.fg }}>{small}</Text>
    </View>
  );
}

const cardStyles = (p: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.line,
      padding: space.lg,
      gap: space.md,
    },
    top: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' },
    body: { flex: 1, gap: 2 },
    from: { ...type.caption, color: p.inkMuted },
    title: { ...type.title, color: p.ink },
    next: { ...type.body, color: p.inkSoft },
    meta: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
    metaItem: { ...type.small, color: p.inkSoft },
    unsure: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    unsureText: { ...type.small, color: p.soon },
    actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
    compact: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
    compactTitle: { ...type.label, color: p.ink },
    compactMeta: { ...type.small, color: p.inkMuted },
    statusDot: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  });

/** Karte für die Heute-Ansicht: Was ist es, was ist zu tun, bis wann – und die passende Handlung direkt daneben. */
export function CaseCard({
  c,
  today,
  onOpen,
  onDone,
  busy,
}: {
  c: CaseSummary;
  today: string;
  onOpen: () => void;
  onDone?: () => void;
  busy?: boolean;
}) {
  const s = useStyles(cardStyles);
  const p = usePalette();
  const primary =
    c.payment ? 'Bezahlen' : c.deadline?.kind === 'antwort' || c.deadline?.kind === 'einspruch' ? 'Antwort entwerfen' : 'Ansehen';
  return (
    <View style={s.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${c.title}, ${c.correspondent}`} onPress={onOpen} style={s.top}>
        <DeadlineStamp deadline={c.deadline} today={today} />
        <View style={s.body}>
          <Text style={s.from}>{c.correspondent}</Text>
          <Text style={s.title}>{c.title}</Text>
          {c.nextAction ? <Text style={s.next}>{c.nextAction}</Text> : null}
          <View style={s.meta}>
            {c.deadline ? (
              <Text style={s.metaItem}>
                {DEADLINE_WORD[c.deadline.kind]} {formatDateDe(c.deadline.date)}
              </Text>
            ) : null}
            {c.payment ? <Text style={s.metaItem}>· {formatEuro(c.payment.amountCents)}</Text> : null}
            {c.assigneeName ? <Text style={s.metaItem}>· {c.assigneeName}</Text> : null}
          </View>
        </View>
      </Pressable>
      {c.confidence < 0.8 ? (
        <View style={s.unsure}>
          <Icon name="help-circle" size={16} color={p.soon} />
          <Text style={s.unsureText}>Bitte kurz prüfen: Zuordnung unsicher</Text>
        </View>
      ) : null}
      <View style={s.actions}>
        <Button small label={primary} onPress={onOpen} />
        {onDone ? <Button small variant="secondary" label="Erledigt" icon="check" onPress={onDone} busy={busy} /> : null}
      </View>
    </View>
  );
}

/** Kompakte Zeile für Listen (Vorgänge, Suche, Wartet, Info). */
export function CaseRow({ c, today, onOpen }: { c: CaseSummary; today: string; onOpen: () => void }) {
  const s = useStyles(cardStyles);
  const p = usePalette();
  const status = { action: 'Offen', waiting: 'Wartet auf Antwort', info: 'Zur Info', done: 'Erledigt' }[c.status];
  const due = c.status === 'waiting' && c.followUpOn ? `Nachhaken ${formatDateDe(c.followUpOn)}` : c.deadline ? `${DEADLINE_WORD[c.deadline.kind]} ${formatDateDe(c.deadline.date)}` : status;
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [s.compact, pressed && { opacity: 0.7 }]}>
      {c.status === 'action' && c.deadline ? (
        <DeadlineStamp deadline={c.deadline} today={today} size={44} />
      ) : (
        <View style={[s.statusDot, { backgroundColor: c.status === 'done' ? p.doneSoft : c.status === 'waiting' ? p.soonSoft : p.stampSoft }]}>
          <Icon
            name={c.status === 'done' ? 'check' : c.status === 'waiting' ? 'clock' : c.status === 'info' ? 'info' : 'circle'}
            size={18}
            color={c.status === 'done' ? p.done : c.status === 'waiting' ? p.soon : p.stamp}
          />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={s.compactTitle} numberOfLines={1}>
          {c.title}
        </Text>
        <Text style={s.compactMeta} numberOfLines={1}>
          {c.correspondent} · {due}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={p.inkMuted} />
    </Pressable>
  );
}
