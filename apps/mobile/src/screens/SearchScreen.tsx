import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { todayIso, type CaseSummary } from '@toypost/shared';
import { Button, Card, Divider, Empty, Field, Notice, Screen, Section } from '../components/base.tsx';
import { CaseRow } from '../components/case.tsx';
import { useNav } from '../nav.ts';
import { useSession } from '../session.tsx';
import { space, type, usePalette } from '../theme.ts';

export function SearchScreen() {
  const nav = useNav();
  const p = usePalette();
  const { api, touch } = useSession();
  const [q, setQ] = useState('');
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; sources: { id: string; caseId: string; title: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayIso();

  useEffect(() => {
    if (q.trim().length < 2) {
      setCases(null);
      return;
    }
    const t = setTimeout(() => {
      api.search(q.trim()).then((r) => setCases(r.cases)).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q, api]);

  const ask = async () => {
    if (question.trim().length < 5) {
      setError('Stelle eine vollständige Frage, z. B. „Wann läuft mein Handyvertrag aus?“');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.ask(question.trim()));
      touch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Suche">
      <Field label="Suchen" placeholder="Absender, Betreff, Nummer oder Text" value={q} onChangeText={setQ} autoFocus returnKeyType="search" hint="Suchen ist immer kostenlos." />
      {cases ? (
        cases.length ? (
          <Section title="Vorgänge" meta={`${cases.length}`}>
            <Card style={{ paddingVertical: 0 }}>
              {cases.map((c, i) => (
                <View key={c.id}>
                  {i > 0 ? <Divider /> : null}
                  <CaseRow c={c} today={today} onOpen={() => nav.go(`/vorgang/${c.id}`)} />
                </View>
              ))}
            </Card>
          </Section>
        ) : (
          <Empty title="Nichts gefunden" text="Probier es mit einem Teil des Absenders oder einer Nummer aus dem Brief." />
        )
      ) : null}

      <Section title="Frag dein Archiv" meta="3 Credits">
        <Card>
          <Field label="Deine Frage" placeholder="Wann läuft mein Handyvertrag aus?" value={question} onChangeText={setQuestion} />
          <Button label="Fragen" hint="3 Credits" icon="message-circle" busy={busy} style={{ marginTop: space.md, alignSelf: 'flex-start' }} onPress={ask} />
          {answer ? (
            <View style={{ marginTop: space.lg, gap: space.sm }}>
              <Text style={[type.body, { color: p.ink }]}>{answer.answer}</Text>
              {answer.sources.map((s) => (
                <Button key={s.id} variant="quiet" small icon="file-text" label={s.title} onPress={() => nav.go(`/vorgang/${s.caseId}`)} style={{ alignSelf: 'flex-start' }} />
              ))}
            </View>
          ) : null}
        </Card>
      </Section>
      {error ? (
        <View style={{ marginTop: space.md }}>
          <Notice tone="error">{error}</Notice>
        </View>
      ) : null}
    </Screen>
  );
}
