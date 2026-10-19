import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { formatEuro, priceFor, yearlySavingPercent, type PlanId } from '@toypost/shared';
import { Button, Chip, Icon, Loading, Notice, Screen } from '../components/base.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

const styles = (p: Palette) =>
  StyleSheet.create({
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
    plan: {
      flexGrow: 1,
      flexBasis: 320,
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.line,
      padding: space.lg,
      gap: space.sm,
    },
    current: { borderColor: p.stamp, borderWidth: 2 },
    name: { ...type.title, color: p.ink },
    tagline: { ...type.small, color: p.inkSoft },
    price: { ...type.display, color: p.ink, marginTop: space.sm },
    priceNote: { ...type.small, color: p.inkMuted },
    facts: { flexDirection: 'row', gap: space.lg, marginVertical: space.sm, flexWrap: 'wrap' },
    fact: { ...type.small, color: p.ink },
    factLabel: { ...type.caption, color: p.inkMuted },
    feature: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
    featureText: { ...type.small, color: p.ink, flex: 1 },
    seats: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm },
    seatsText: { ...type.label, color: p.ink, minWidth: 90, textAlign: 'center' },
    badge: { ...type.caption, color: p.stamp },
  });

export function PlansScreen() {
  const s = useStyles(styles);
  const p = usePalette();
  const nav = useNav();
  const { api, me, refresh } = useSession();
  const { data, loading } = useLoad((a) => a.catalog());
  const [interval, setBilling] = useState<'month' | 'year'>('year');
  const [seats, setSeats] = useState(3);
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const choose = async (plan: 'pro' | 'team') => {
    setBusy(plan);
    setMessage(null);
    try {
      const r = await api.checkout({ type: 'plan', plan, interval, seats: plan === 'team' ? seats : undefined });
      if (r.url) {
        if (Platform.OS === 'web') await Linking.openURL(r.url);
        else await WebBrowser.openBrowserAsync(r.url);
      }
      await refresh();
      setMessage({ tone: 'success', text: `${r.description} ist aktiv.` });
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title="Tarife" onBack={nav.back}>
      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
        <Chip label="Jährlich, 2 Monate gratis" active={interval === 'year'} onPress={() => setBilling('year')} />
        <Chip label="Monatlich" active={interval === 'month'} onPress={() => setBilling('month')} />
      </View>
      {message ? (
        <View style={{ marginBottom: space.md }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </View>
      ) : null}
      {loading || !data ? <Loading /> : null}
      <View style={s.grid}>
        {data?.plans.map((plan, idx) => {
          const prev = idx > 0 ? data.plans[idx - 1] : null;
          const added = prev ? plan.featureLabels.filter((f) => !prev.featureLabels.includes(f)) : plan.featureLabels;
          const isCurrent = me?.plan === plan.id;
          const price = priceFor(plan.id, interval, plan.id === 'team' ? seats : 1);
          const perMonthOfYear = Math.round(plan.priceYearlyCents / 12);
          return (
            <View key={plan.id} style={[s.plan, isCurrent && s.current]}>
              {isCurrent ? <Text style={s.badge}>Dein Tarif</Text> : null}
              <Text style={s.name}>{plan.name}</Text>
              <Text style={s.tagline}>{plan.tagline}</Text>
              <Text style={s.price}>
                {plan.id === 'free' ? '0 €' : plan.custom ? `ab ${formatEuro(plan.priceMonthlyCents)}` : formatEuro(interval === 'month' ? plan.priceMonthlyCents : perMonthOfYear)}
              </Text>
              <Text style={s.priceNote}>
                {plan.id === 'free'
                  ? 'für immer'
                  : plan.custom
                    ? `je Nutzer im Monat, netto, ab ${plan.minSeats} Nutzern, Jahresvertrag`
                    : `${plan.perSeat ? 'je Nutzer ' : ''}im Monat${interval === 'year' ? `, jährlich ${formatEuro(price)}` : ''}${plan.priceIncludesVat ? ' inkl. MwSt.' : ' zzgl. MwSt.'}${interval === 'year' ? ` · ${yearlySavingPercent(plan.id)} % gespart` : ''}`}
              </Text>
              <View style={s.facts}>
                <View>
                  <Text style={s.factLabel}>Credits</Text>
                  <Text style={s.fact}>
                    {plan.monthlyCredits.toLocaleString('de-DE')}
                    {plan.perSeat ? ' je Nutzer' : ''}/Monat
                  </Text>
                </View>
                <View>
                  <Text style={s.factLabel}>Speicher</Text>
                  <Text style={s.fact}>
                    {plan.storageGb >= 1000 ? `${plan.storageGb / 1000} TB+` : `${plan.storageGb} GB`}
                    {plan.perSeat && plan.storageGb < 1000 ? ' je Nutzer' : ''}
                  </Text>
                </View>
                <View>
                  <Text style={s.factLabel}>Nutzer</Text>
                  <Text style={s.fact}>{plan.maxSeats === null ? `ab ${plan.minSeats}` : plan.maxSeats === 2 ? '1 + Familie' : plan.maxSeats}</Text>
                </View>
              </View>
              {prev ? <Text style={[s.featureText, { color: p.inkSoft }]}>Alles aus {prev.name}, plus:</Text> : null}
              {added.map((f) => (
                <View key={f} style={s.feature}>
                  <Icon name="check" size={16} color={p.done} />
                  <Text style={s.featureText}>{f}</Text>
                </View>
              ))}
              <View style={s.feature}>
                <Icon name="life-buoy" size={16} color={p.inkMuted} />
                <Text style={s.featureText}>{plan.supportLabel}</Text>
              </View>
              {plan.id === 'team' && !isCurrent ? (
                <View style={s.seats}>
                  <Button small variant="secondary" label="−" onPress={() => setSeats((n) => Math.max(plan.minSeats, n - 1))} />
                  <Text style={s.seatsText}>{seats} Nutzer</Text>
                  <Button small variant="secondary" label="+" onPress={() => setSeats((n) => n + 1)} />
                </View>
              ) : null}
              <View style={{ marginTop: space.md }}>
                {isCurrent ? null : plan.id === 'free' ? null : plan.custom ? (
                  <Button variant="secondary" label="Angebot anfragen" onPress={() => Linking.openURL('mailto:vertrieb@toypost.app?subject=ToyPost%20Enterprise')} />
                ) : (
                  <Button label={`${plan.name} wählen`} busy={busy === plan.id} onPress={() => choose(plan.id as 'pro' | 'team')} />
                )}
              </View>
            </View>
          );
        })}
      </View>
      <Text style={[type.small, { color: p.inkMuted, marginTop: space.lg }]}>
        Monatlich kündbar. Ein Wechsel in einen kleineren Tarif löscht keine Dokumente; wird der Speicher knapp, pausieren nur neue Uploads.
      </Text>
    </Screen>
  );
}
