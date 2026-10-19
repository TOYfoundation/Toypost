import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { formatDateDe, formatEuro, pricePerCreditCents } from '@toypost/shared';
import { Card, Divider, Loading, Notice, Row, Screen, Section } from '../components/base.tsx';
import { useNav } from '../nav.ts';
import { useLoad, useSession } from '../session.tsx';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

const styles = (p: Palette) =>
  StyleSheet.create({
    total: { ...type.display, fontSize: 36, lineHeight: 42, color: p.ink },
    sub: { ...type.small, color: p.inkSoft, marginTop: space.xs },
    packs: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
    pack: {
      flexGrow: 1,
      flexBasis: 150,
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.line,
      padding: space.lg,
      gap: 2,
    },
    packCredits: { ...type.heading, color: p.ink },
    packPrice: { ...type.label, color: p.stamp },
    packNote: { ...type.small, color: p.inkMuted },
    ledgerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm, gap: space.md },
    ledgerLabel: { ...type.small, color: p.ink, flex: 1 },
    ledgerDate: { ...type.small, color: p.inkMuted, width: 70 },
    plus: { ...type.label, color: p.done },
    minus: { ...type.label, color: p.inkSoft },
  });

export function CreditsScreen() {
  const s = useStyles(styles);
  const nav = useNav();
  const { api, refresh } = useSession();
  const credits = useLoad((a) => a.credits());
  const catalog = useLoad((a) => a.catalog());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const buy = async (pack: 'S' | 'M' | 'L') => {
    setBusy(pack);
    setMessage(null);
    try {
      const r = await api.checkout({ type: 'credits', pack });
      if (r.url) {
        if (Platform.OS === 'web') await Linking.openURL(r.url);
        else await WebBrowser.openBrowserAsync(r.url);
      }
      await refresh();
      setMessage({ tone: 'success', text: `${r.description} gutgeschrieben.` });
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const b = credits.data?.balance;
  return (
    <Screen title="Credits" onBack={nav.back}>
      {!b ? <Loading /> : null}
      {b ? (
        <Card>
          <Text style={s.total}>{b.total.toLocaleString('de-DE')}</Text>
          <Text style={s.sub}>
            {b.plan.toLocaleString('de-DE')} aus dem Monatskontingent (setzt sich am {formatDateDe(b.planResetsOn)} auf {b.monthlyGrant.toLocaleString('de-DE')} zurück)
            {b.purchased ? ` und ${b.purchased.toLocaleString('de-DE')} gekaufte, 24 Monate gültig` : ''}.
          </Text>
        </Card>
      ) : null}
      {message ? (
        <View style={{ marginTop: space.md }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </View>
      ) : null}

      <Section title="Credits kaufen">
        <View style={s.packs}>
          {catalog.data?.creditPacks.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={`${p.credits} Credits für ${formatEuro(p.priceCents)} kaufen`}
              disabled={!!busy}
              onPress={() => buy(p.id)}
              style={({ pressed }) => [s.pack, pressed && { opacity: 0.75 }, busy === p.id && { opacity: 0.5 }]}
            >
              <Text style={s.packCredits}>{p.credits.toLocaleString('de-DE')}</Text>
              <Text style={s.packPrice}>{formatEuro(p.priceCents)}</Text>
              <Text style={s.packNote}>{pricePerCreditCents(p).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ct je Credit</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      <Section title="Was kostet was">
        <Card style={{ paddingVertical: 0 }}>
          {catalog.data?.creditCosts.map((c, i) => (
            <View key={c.action}>
              {i > 0 ? <Divider /> : null}
              <Row label={c.label} value={`${c.credits.toLocaleString('de-DE')} ${c.credits === 1 ? 'Credit' : 'Credits'}`} />
            </View>
          ))}
          <Divider />
          <Row label="Regel-Treffer, Suche, Erinnerungen, Export" value="kostenlos" />
        </Card>
      </Section>

      <Section title="Verlauf">
        <Card>
          {credits.data?.ledger.length ? (
            credits.data.ledger.slice(0, 30).map((e, i) => (
              <View key={i} style={s.ledgerRow}>
                <Text style={s.ledgerDate}>{formatDateDe(e.at.slice(0, 10), false)}</Text>
                <Text style={s.ledgerLabel}>{e.label}</Text>
                <Text style={e.credits > 0 ? s.plus : s.minus}>
                  {e.credits > 0 ? '+' : '−'}
                  {Math.abs(e.credits).toLocaleString('de-DE')}
                </Text>
              </View>
            ))
          ) : (
            <Text style={s.sub}>Noch keine Buchungen.</Text>
          )}
        </Card>
      </Section>
    </Screen>
  );
}
