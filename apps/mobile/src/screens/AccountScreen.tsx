import { StyleSheet, Text, View } from 'react-native';
import { PLANS, storageLimitBytes } from '@toypost/shared';
import { Button, Card, Divider, Notice, Row, Screen, Section } from '../components/base.tsx';
import { useNav } from '../nav.ts';
import { useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

const styles = (p: Palette) =>
  StyleSheet.create({
    planName: { ...type.heading, color: p.ink },
    planText: { ...type.small, color: p.inkSoft, marginTop: 2 },
    meterTrack: { height: 8, borderRadius: radius.pill, backgroundColor: p.line, overflow: 'hidden', marginTop: space.sm },
    meterFill: { height: 8, borderRadius: radius.pill },
    meterLabel: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.md },
    meterTitle: { ...type.label, color: p.ink },
    meterValue: { ...type.small, color: p.inkSoft },
  });

function Meter({ title, value, used, total, color }: { title: string; value: string; used: number; total: number; color: string }) {
  const s = useStyles(styles);
  const pct = Math.max(0, Math.min(1, total ? used / total : 0));
  return (
    <View accessible accessibilityLabel={`${title}: ${value}`}>
      <View style={s.meterLabel}>
        <Text style={s.meterTitle}>{title}</Text>
        <Text style={s.meterValue}>{value}</Text>
      </View>
      <View style={s.meterTrack}>
        <View style={[s.meterFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function gb(bytes: number) {
  return (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

export function AccountScreen() {
  const s = useStyles(styles);
  const p = usePalette();
  const nav = useNav();
  const { me, api, signOut } = useSession();
  if (!me) return <Screen title="Konto">{null}</Screen>;
  const plan = PLANS[me.plan];
  const limit = storageLimitBytes(me.plan, me.seats);
  const storagePct = me.storageUsedBytes / limit;

  return (
    <Screen title="Konto">
      <Card>
        <Text style={s.planName}>{plan.name}</Text>
        <Text style={s.planText}>
          {me.name} · {me.userName}
          {plan.perSeat ? ` · ${me.seats} Nutzer` : ''}
        </Text>
        <Meter
          title="Credits diesen Monat"
          value={`${me.credits.plan.toLocaleString('de-DE')} von ${me.credits.monthlyGrant.toLocaleString('de-DE')} übrig`}
          used={me.credits.plan}
          total={me.credits.monthlyGrant}
          color={p.stamp}
        />
        {me.credits.purchased > 0 ? <Text style={[type.small, { color: p.inkSoft, marginTop: space.xs }]}>+ {me.credits.purchased.toLocaleString('de-DE')} gekaufte Credits</Text> : null}
        <Meter
          title="Speicher"
          value={`${gb(me.storageUsedBytes)} von ${gb(limit)} GB`}
          used={me.storageUsedBytes}
          total={limit}
          color={storagePct > 0.9 ? p.overdue : storagePct > 0.75 ? p.soon : p.done}
        />
        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.lg }}>
          <Button small label="Credits kaufen" onPress={() => nav.go('/credits')} />
          <Button small variant="secondary" label="Tarif ändern" onPress={() => nav.go('/tarife')} />
        </View>
      </Card>

      {storagePct > 0.9 ? (
        <View style={{ marginTop: space.md }}>
          <Notice tone="warning">Dein Speicher ist fast voll. Alles bleibt lesbar; neue Uploads pausieren, wenn er voll ist.</Notice>
        </View>
      ) : null}

      <Section title="Einstellungen">
        <Card style={{ paddingVertical: 0 }}>
          <Row label="Verbindungen" onPress={() => nav.go('/integrationen')} />
          <Divider />
          <Row label="Credits und Verlauf" onPress={() => nav.go('/credits')} />
          <Divider />
          <Row label="Tarife vergleichen" onPress={() => nav.go('/tarife')} />
        </Card>
      </Section>

      <View style={{ marginTop: space.xl, alignItems: 'flex-start' }}>
        <Button variant="danger" icon="log-out" label={api.mode === 'demo' ? 'Demo beenden' : 'Abmelden'} onPress={signOut} />
      </View>
    </Screen>
  );
}
