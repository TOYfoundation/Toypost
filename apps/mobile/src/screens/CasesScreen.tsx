import { useState } from 'react';
import { View } from 'react-native';
import { todayIso, type CaseStatus } from '@dokufy/shared';
import { Card, Chip, Divider, Empty, Field, Loading, Notice, Screen } from '../components/base.tsx';
import { CaseRow } from '../components/case.tsx';
import { useNav } from '../nav.ts';
import { useLoad } from '../session.tsx';
import { space } from '../theme.ts';

const FILTERS: { key: CaseStatus | 'all'; label: string }[] = [
  { key: 'action', label: 'Offen' },
  { key: 'waiting', label: 'Wartet' },
  { key: 'info', label: 'Info' },
  { key: 'done', label: 'Erledigt' },
  { key: 'all', label: 'Alle' },
];

export function CasesScreen() {
  const nav = useNav();
  const [filter, setFilter] = useState<CaseStatus | 'all'>('action');
  const [q, setQ] = useState('');
  const { data, loading, error } = useLoad((a) => a.cases(filter === 'all' ? undefined : filter, q.trim() || undefined), [filter, q]);
  const today = todayIso();

  return (
    <Screen title="Vorgänge">
      <Field label="Filtern" placeholder="Absender, Titel oder Aktenzeichen" value={q} onChangeText={setQ} returnKeyType="search" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md, marginBottom: space.lg }}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </View>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading && !data ? <Loading /> : null}
      {data && data.length ? (
        <Card style={{ paddingVertical: 0 }}>
          {data.map((c, i) => (
            <View key={c.id}>
              {i > 0 ? <Divider /> : null}
              <CaseRow c={c} today={today} onOpen={() => nav.go(`/vorgang/${c.id}`)} />
            </View>
          ))}
        </Card>
      ) : null}
      {data && !data.length ? (
        <Empty
          title={q ? 'Nichts gefunden' : 'Hier ist nichts'}
          text={q ? 'Versuche einen anderen Begriff oder wähle „Alle“.' : 'Vorgänge mit diesem Status erscheinen hier.'}
        />
      ) : null}
    </Screen>
  );
}
