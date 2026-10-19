import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';
import { Icon, type IconName } from './base.tsx';

export type TabKey = 'index' | 'vorgaenge' | 'scannen' | 'suche' | 'konto';

export const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: 'index', label: 'Heute', icon: 'sun' },
  { key: 'vorgaenge', label: 'Vorgänge', icon: 'layers' },
  { key: 'scannen', label: 'Erfassen', icon: 'plus' },
  { key: 'suche', label: 'Suche', icon: 'search' },
  { key: 'konto', label: 'Konto', icon: 'user' },
];

const styles = (p: Palette) =>
  StyleSheet.create({
    bottom: {
      flexDirection: 'row',
      backgroundColor: p.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.line,
      paddingTop: space.sm,
    },
    side: {
      width: 232,
      backgroundColor: p.surface,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: p.line,
      paddingTop: space.xl,
      paddingHorizontal: space.md,
      gap: space.xs,
    },
    brand: { ...type.heading, color: p.ink, paddingHorizontal: space.md, marginBottom: space.xl },
    item: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: space.xs },
    sideItem: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, minHeight: 44, borderRadius: radius.control },
    label: { ...type.caption },
    sideLabel: { ...type.label },
    capture: { width: 48, height: 48, borderRadius: 24, backgroundColor: p.stamp, alignItems: 'center', justifyContent: 'center', marginTop: -28 },
  });

/** Unten auf dem Telefon, links als Seitenleiste auf breiten Bildschirmen. "Erfassen" ist die zentrale Handlung. */
export function TabBar({ active, onSelect, vertical }: { active: TabKey; onSelect: (k: TabKey) => void; vertical: boolean }) {
  const s = useStyles(styles);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  if (vertical) {
    return (
      <View style={[s.side, { paddingTop: insets.top + space.xl }]} accessibilityRole="tablist">
        <Text style={s.brand}>Dokufy</Text>
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => onSelect(t.key)}
              style={[s.sideItem, on && { backgroundColor: p.stampSoft }]}
            >
              <Icon name={t.icon} color={on ? p.stamp : p.inkSoft} />
              <Text style={[s.sideLabel, { color: on ? p.stamp : p.inkSoft }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, space.sm) }]} accessibilityRole="tablist">
      {TABS.map((t) => {
        const on = t.key === active;
        if (t.key === 'scannen') {
          return (
            <Pressable key={t.key} accessibilityRole="tab" accessibilityLabel="Post erfassen" accessibilityState={{ selected: on }} onPress={() => onSelect(t.key)} style={s.item}>
              <View style={s.capture}>
                <Icon name="plus" size={26} color={p.onStamp} />
              </View>
              <Text style={[s.label, { color: on ? p.stamp : p.inkMuted }]}>{t.label}</Text>
            </Pressable>
          );
        }
        return (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onSelect(t.key)} style={s.item}>
            <Icon name={t.icon} color={on ? p.stamp : p.inkMuted} />
            <Text style={[s.label, { color: on ? p.stamp : p.inkMuted }]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
