import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateDe, shouldWarn, toUnits, type CaseSummary } from '@dokufy/shared';
import { Button, Card, Divider, Empty, Loading, Notice, Screen, Section } from '../components/base.tsx';
import { CaseCard, CaseRow } from '../components/case.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

const WEEKDAY_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTH_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function longDate(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY_LONG[d.getUTCDay()]}, ${d.getUTCDate()}. ${MONTH_LONG[d.getUTCMonth()]}`;
}

const styles = (p: Palette) =>
  StyleSheet.create({
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.sm },
    date: { ...type.small, color: p.inkMuted },
    pill: { paddingHorizontal: space.md, minHeight: 32, borderRadius: radius.pill, backgroundColor: p.surface, borderWidth: 1, borderColor: p.line, justifyContent: 'center' },
    pillText: { ...type.caption, color: p.ink },
    headline: { ...type.display, color: p.ink },
    sub: { ...type.body, color: p.inkSoft, marginTop: space.xs, marginBottom: space.md },
  });

export function TodayScreen() {
  const s = useStyles(styles);
  const nav = useNav();
  const { api, me, touch } = useSession();
  const { data, loading, error } = useLoad((a) => a.today());
  const [busyId, setBusyId] = useState<string | null>(null);

  const markDone = async (c: CaseSummary) => {
    setBusyId(c.id);
    try {
      await api.updateCase(c.id, { status: 'done' });
      touch();
    } finally {
      setBusyId(null);
    }
  };

  const credits = me?.credits;
  const lowCredits = credits && shouldWarn(toUnits(credits.plan), toUnits(credits.monthlyGrant)) && credits.purchased < 20;
  const count = data ? data.action.length + data.followUpDue.length : 0;
  const first = data?.action.find((c) => c.deadline)?.deadline;

  return (
    <Screen>
      <View style={s.top}>
        <Text style={s.date}>{data ? longDate(data.today) : ' '}</Text>
        {credits ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${credits.total} Credits, Details öffnen`} style={s.pill} onPress={() => nav.go('/credits')}>
            <Text style={s.pillText}>{credits.total.toLocaleString('de-DE')} Credits</Text>
          </Pressable>
        ) : null}
      </View>

      {loading && !data ? <Loading /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {data ? (
        <>
          <Text accessibilityRole="header" style={s.headline}>
            {count === 0 ? 'Alles erledigt.' : count === 1 ? 'Eine Sache braucht dich.' : `${count} Dinge brauchen dich.`}
          </Text>
          <Text style={s.sub}>
            {count === 0
              ? 'Neue Post erscheint hier, sobald sie gelesen ist.'
              : first
                ? `Die nächste Frist ist am ${formatDateDe(first.date)}`
                : 'Keine Frist drängt gerade.'}
          </Text>

          {api.mode === 'demo' ? (
            <Notice tone="info">Demo-Modus mit Beispiel-Post. Änderungen gehen beim Schließen verloren.</Notice>
          ) : null}
          {lowCredits ? (
            <View style={{ marginTop: space.md }}>
              <Notice tone="warning">
                Nur noch {credits!.plan} von {credits!.monthlyGrant} Monats-Credits übrig. Regeln und Suche funktionieren weiter ohne Credits.
              </Notice>
            </View>
          ) : null}

          {data.action.length ? (
            <Section title="Zu tun" meta={`${data.action.length}`}>
              {data.action.map((c) => (
                <CaseCard key={c.id} c={c} today={data.today} onOpen={() => nav.go(`/vorgang/${c.id}`)} onDone={() => markDone(c)} busy={busyId === c.id} />
              ))}
            </Section>
          ) : null}

          {data.followUpDue.length ? (
            <Section title="Nachhaken" meta="keine Antwort erhalten">
              {data.followUpDue.map((c) => (
                <Card key={c.id}>
                  <CaseRow c={c} today={data.today} onOpen={() => nav.go(`/vorgang/${c.id}`)} />
                  <Button small variant="secondary" icon="send" label="Erinnerung entwerfen" onPress={() => nav.go(`/vorgang/${c.id}`)} style={{ alignSelf: 'flex-start' }} />
                </Card>
              ))}
            </Section>
          ) : null}

          {data.waiting.length ? (
            <Section title="Wartet auf Antwort" meta={`${data.waiting.length}`}>
              <Card style={{ paddingVertical: 0 }}>
                {data.waiting.map((c, i) => (
                  <View key={c.id}>
                    {i > 0 ? <Divider /> : null}
                    <CaseRow c={c} today={data.today} onOpen={() => nav.go(`/vorgang/${c.id}`)} />
                  </View>
                ))}
              </Card>
            </Section>
          ) : null}

          {data.newInfo.length ? (
            <Section title="Neu, nichts zu tun" meta={`${data.newInfo.length}`}>
              <Card style={{ paddingVertical: 0 }}>
                {data.newInfo.map((c, i) => (
                  <View key={c.id}>
                    {i > 0 ? <Divider /> : null}
                    <CaseRow c={c} today={data.today} onOpen={() => nav.go(`/vorgang/${c.id}`)} />
                  </View>
                ))}
              </Card>
            </Section>
          ) : null}

          {count === 0 && !data.waiting.length && !data.newInfo.length ? (
            <Empty
              title="Noch keine Post"
              text="Fotografiere deinen ersten Brief oder verbinde Paperless, dann sortiert Dokufy automatisch."
              action={<Button icon="camera" label="Brief erfassen" onPress={() => nav.go('/scannen')} />}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
