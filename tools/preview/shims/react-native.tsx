/**
 * Minimaler Ersatz für react-native auf Basis von react-dom.
 * Nur für die Vorschau-Screenshots im Repository-Werkzeug; die echte App nutzt react-native / react-native-web.
 */
import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

type Style = Record<string, any> | null | undefined | false | Style[];

const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'fontWeight', 'aspectRatio']);
const FONT_WEIGHT: Record<string, number> = {
  SchibstedGrotesk_400Regular: 400,
  SchibstedGrotesk_500Medium: 500,
  SchibstedGrotesk_700Bold: 700,
};

function flatten(style: Style): Record<string, any> {
  if (!style) return {};
  if (Array.isArray(style)) return style.reduce<Record<string, any>>((acc, s) => ({ ...acc, ...flatten(s) }), {});
  return style as Record<string, any>;
}

export function toCss(style: Style): CSSProperties {
  const s = flatten(style);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) continue;
    switch (k) {
      case 'paddingHorizontal':
        out.paddingLeft = out.paddingRight = px(v);
        break;
      case 'paddingVertical':
        out.paddingTop = out.paddingBottom = px(v);
        break;
      case 'marginHorizontal':
        out.marginLeft = out.marginRight = px(v);
        break;
      case 'marginVertical':
        out.marginTop = out.marginBottom = px(v);
        break;
      case 'transform':
        out.transform = (v as Record<string, string>[]).map((t) => Object.entries(t).map(([fn, val]) => `${fn}(${val})`).join(' ')).join(' ');
        break;
      case 'fontFamily':
        out.fontFamily = "'Schibsted Grotesk', system-ui, sans-serif";
        if (FONT_WEIGHT[v] && s.fontWeight === undefined) out.fontWeight = FONT_WEIGHT[v];
        break;
      case 'textAlignVertical':
      case 'shadowColor':
      case 'shadowOpacity':
      case 'shadowRadius':
      case 'shadowOffset':
      case 'elevation':
        break;
      default:
        if (/^border(Top|Bottom|Left|Right)?Width$/.test(k)) {
          out[k] = px(v);
          out[k.replace('Width', 'Style')] = 'solid';
        } else {
          out[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v;
        }
    }
  }
  return out as CSSProperties;
}

const px = (v: unknown) => (typeof v === 'number' ? `${v}px` : v);

const VIEW_BASE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  position: 'relative',
  flexShrink: 0,
  minWidth: 0,
  borderStyle: 'solid',
  borderWidth: 0,
};

function a11y(props: any) {
  return {
    role: props.accessibilityRole === 'header' ? 'heading' : props.accessibilityRole,
    'aria-label': props.accessibilityLabel,
    'aria-selected': props.accessibilityState?.selected,
    'aria-disabled': props.accessibilityState?.disabled,
  };
}

export function View({ style, children, ...props }: any) {
  return (
    <div style={{ ...VIEW_BASE, ...toCss(style) }} {...a11y(props)}>
      {children}
    </div>
  );
}

const InText = createContext(false);
export function Text({ style, children, numberOfLines, ...props }: any) {
  const nested = useContext(InText);
  const css: CSSProperties = {
    ...(nested ? { display: 'inline' } : { display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }),
    ...toCss(style),
    ...(numberOfLines === 1 ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
  };
  return (
    <InText.Provider value>
      <span style={css} {...a11y(props)}>
        {children}
      </span>
    </InText.Provider>
  );
}

export function Pressable({ style, children, onPress, disabled, ...props }: any) {
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
  return (
    <div
      role={props.accessibilityRole ?? 'button'}
      aria-label={props.accessibilityLabel}
      tabIndex={0}
      onClick={disabled ? undefined : onPress}
      style={{ ...VIEW_BASE, cursor: disabled ? 'default' : 'pointer', ...toCss(resolved) }}
    >
      {children}
    </div>
  );
}
export const TouchableOpacity = Pressable;

export function ScrollView({ style, contentContainerStyle, children }: any) {
  return (
    <div style={{ ...VIEW_BASE, flex: 1, overflowY: 'auto', ...toCss(style) }}>
      <div style={{ ...VIEW_BASE, ...toCss(contentContainerStyle) }}>{children}</div>
    </div>
  );
}

export function TextInput({ style, value, onChangeText, placeholder, secureTextEntry, multiline, onSubmitEditing, autoFocus, ...props }: any) {
  const css = { ...toCss(style), outline: 'none', boxSizing: 'border-box' as const, width: '100%' };
  if (multiline) {
    return <textarea aria-label={props.accessibilityLabel} style={css} value={value} placeholder={placeholder} onChange={(e) => onChangeText?.(e.target.value)} />;
  }
  return (
    <input
      aria-label={props.accessibilityLabel}
      style={css}
      value={value}
      placeholder={placeholder}
      type={secureTextEntry ? 'password' : 'text'}
      autoFocus={false && autoFocus}
      onChange={(e) => onChangeText?.(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onSubmitEditing?.()}
    />
  );
}

export function Switch({ value, onValueChange, trackColor }: any) {
  return (
    <div
      role="switch"
      aria-checked={!!value}
      onClick={() => onValueChange?.(!value)}
      style={{ width: 46, height: 28, borderRadius: 14, background: value ? trackColor?.true : trackColor?.false, position: 'relative', cursor: 'pointer', flexShrink: 0 }}
    >
      <div style={{ position: 'absolute', top: 3, left: value ? 21 : 3, width: 22, height: 22, borderRadius: 11, background: '#fff', transition: 'left .15s' }} />
    </div>
  );
}

export function ActivityIndicator({ color }: any) {
  return (
    <div
      aria-label="Lädt"
      style={{ width: 18, height: 18, borderRadius: 9, border: `2px solid ${color}`, borderTopColor: 'transparent', animation: 'rn-spin .8s linear infinite', alignSelf: 'center' }}
    />
  );
}

export const StyleSheet = {
  create: <T,>(s: T) => s,
  hairlineWidth: 1,
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  flatten,
};

export const Platform = { OS: 'web', select: (o: any) => o.web ?? o.default };
export const Linking = { openURL: async (u: string) => void window.open(u, '_blank') };
export const Alert = { alert: (t: string, m?: string) => window.alert(`${t}\n${m ?? ''}`) };

export function useWindowDimensions() {
  const [d, setD] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const on = () => setD({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return d;
}

export function useColorScheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export type ViewStyle = Record<string, any>;
export type TextInputProps = Record<string, any>;
export type ReactNodeType = ReactNode;
