import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { MAX_CONTENT_WIDTH, radius, space, type, usePalette, useStyles, type Palette } from '../theme.ts';

export type IconName = keyof typeof Feather.glyphMap;

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color?: string }) {
  const p = usePalette();
  return <Feather name={name} size={size} color={color ?? p.ink} />;
}

// ---------- Bildschirm ----------

const screenStyles = (p: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.paper },
    scroll: { flexGrow: 1 },
    column: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', paddingHorizontal: space.lg },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: space.sm },
    back: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm, paddingRight: space.md },
    backText: { ...type.label, color: p.stamp },
    title: { ...type.heading, color: p.ink, marginBottom: space.lg },
  });

export function Screen({
  children,
  title,
  onBack,
  right,
  scroll = true,
}: {
  children: ReactNode;
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
  scroll?: boolean;
}) {
  const s = useStyles(screenStyles);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const body = (
    <View style={[s.column, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + 96 }]}>
      {(onBack || right) && (
        <View style={s.header}>
          {onBack ? (
            <Pressable accessibilityRole="button" onPress={onBack} style={s.back} hitSlop={8}>
              <Icon name="chevron-left" color={p.stamp} />
              <Text style={s.backText}>Zurück</Text>
            </Pressable>
          ) : (
            <View />
          )}
          {right}
        </View>
      )}
      {title ? (
        <Text accessibilityRole="header" style={s.title}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
  return (
    <View style={s.root}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

// ---------- Knöpfe ----------

const buttonStyles = (p: Palette) =>
  StyleSheet.create({
    base: {
      minHeight: 44,
      paddingHorizontal: space.lg,
      borderRadius: radius.control,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.sm,
    },
    primary: { backgroundColor: p.stamp },
    secondary: { backgroundColor: p.surface, borderWidth: 1, borderColor: p.line },
    quiet: { backgroundColor: 'transparent', paddingHorizontal: space.sm },
    danger: { backgroundColor: p.surface, borderWidth: 1, borderColor: p.overdue },
    textPrimary: { ...type.label, color: p.onStamp },
    textSecondary: { ...type.label, color: p.ink },
    textQuiet: { ...type.label, color: p.stamp },
    textDanger: { ...type.label, color: p.overdue },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
    small: { minHeight: 36, paddingHorizontal: space.md },
  });

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  busy,
  disabled,
  small,
  style,
  hint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  style?: ViewStyle;
  /** zusätzlicher Hinweis rechts, z. B. "5 Credits" */
  hint?: string;
}) {
  const s = useStyles(buttonStyles);
  const p = usePalette();
  const textStyle = { primary: s.textPrimary, secondary: s.textSecondary, quiet: s.textQuiet, danger: s.textDanger }[variant];
  const color = { primary: p.onStamp, secondary: p.ink, quiet: p.stamp, danger: p.overdue }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      accessibilityHint={hint}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.base, s[variant], small && s.small, pressed && s.pressed, (disabled || busy) && s.disabled, style]}
    >
      {busy ? <ActivityIndicator color={color} size="small" /> : icon ? <Icon name={icon} size={18} color={color} /> : null}
      <Text style={textStyle}>{label}</Text>
      {hint ? <Text style={[type.caption, { color, opacity: 0.8 }]}>{hint}</Text> : null}
    </Pressable>
  );
}

// ---------- Karten, Abschnitte, Hinweise ----------

const blockStyles = (p: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: p.surface, borderRadius: radius.card, borderWidth: 1, borderColor: p.line, padding: space.lg },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.xl, marginBottom: space.md },
    sectionTitle: { ...type.title, color: p.ink },
    sectionMeta: { ...type.small, color: p.inkMuted },
    notice: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.control, alignItems: 'flex-start' },
    noticeText: { ...type.small, flex: 1 },
    empty: { alignItems: 'flex-start', paddingVertical: space.xl, gap: space.md },
    emptyTitle: { ...type.title, color: p.ink },
    emptyText: { ...type.body, color: p.inkSoft },
    label: { ...type.caption, color: p.inkSoft, marginBottom: space.xs },
    input: {
      ...type.body,
      color: p.ink,
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.line,
      borderRadius: radius.control,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      minHeight: 44,
    },
    inputError: { borderColor: p.overdue },
    fieldError: { ...type.small, color: p.overdue, marginTop: space.xs },
    fieldHint: { ...type.small, color: p.inkMuted, marginTop: space.xs },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md, gap: space.md },
    rowLabel: { ...type.body, color: p.ink, flexShrink: 1 },
    rowValue: { ...type.body, color: p.inkSoft, textAlign: 'right', flexShrink: 0, maxWidth: '58%' },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: p.line },
    chip: { paddingHorizontal: space.md, minHeight: 36, borderRadius: radius.pill, borderWidth: 1, justifyContent: 'center' },
    chipText: { ...type.small, fontFamily: type.label.fontFamily },
  });

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const s = useStyles(blockStyles);
  return <View style={[s.card, style]}>{children}</View>;
}

export function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  const s = useStyles(blockStyles);
  return (
    <View>
      <View style={s.sectionHead}>
        <Text accessibilityRole="header" style={s.sectionTitle}>
          {title}
        </Text>
        {meta ? <Text style={s.sectionMeta}>{meta}</Text> : null}
      </View>
      <View style={{ gap: space.md }}>{children}</View>
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const s = useStyles(blockStyles);
  const p = usePalette();
  const map = {
    info: { fg: p.stamp, bg: p.stampSoft, icon: 'info' as IconName },
    error: { fg: p.overdue, bg: p.overdueSoft, icon: 'alert-circle' as IconName },
    success: { fg: p.done, bg: p.doneSoft, icon: 'check-circle' as IconName },
    warning: { fg: p.soon, bg: p.soonSoft, icon: 'alert-triangle' as IconName },
  }[tone];
  return (
    <View accessibilityRole={tone === 'error' ? 'alert' : undefined} style={[s.notice, { backgroundColor: map.bg }]}>
      <Icon name={map.icon} size={18} color={map.fg} />
      <Text style={[s.noticeText, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  const s = useStyles(blockStyles);
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyText}>{text}</Text>
      {action}
    </View>
  );
}

export function Field({
  label,
  error,
  hint,
  ...input
}: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const s = useStyles(blockStyles);
  const p = usePalette();
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={p.inkMuted}
        style={[s.input, input.multiline && { minHeight: 120, textAlignVertical: 'top' }, error ? s.inputError : null]}
        {...input}
      />
      {error ? <Text style={s.fieldError}>{error}</Text> : hint ? <Text style={s.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const s = useStyles(blockStyles);
  const p = usePalette();
  const content = (
    <>
      <Text style={[s.rowLabel, { flex: 1 }]}>{label}</Text>
      {value ? <Text style={s.rowValue}>{value}</Text> : null}
      {onPress ? <Icon name="chevron-right" size={18} color={p.inkMuted} /> : null}
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}>
      {content}
    </Pressable>
  ) : (
    <View style={s.row}>{content}</View>
  );
}

export function Divider() {
  const s = useStyles(blockStyles);
  return <View style={s.divider} />;
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  const s = useStyles(blockStyles);
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={[s.chip, { backgroundColor: active ? p.ink : p.surface, borderColor: active ? p.ink : p.line }]}
    >
      <Text style={[s.chipText, { color: active ? p.paper : p.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function Loading() {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: space.xxl, alignItems: 'center' }}>
      <ActivityIndicator color={p.stamp} />
    </View>
  );
}
