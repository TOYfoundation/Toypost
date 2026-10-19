import { useColorScheme } from 'react-native';
import { useMemo } from 'react';

/**
 * Gestaltung: Tinte auf Papier.
 * Kühles, ruhiges Papierweiß, tintenblaue Schrift, Stempelblau für Handlungen.
 * Einziges lautes Element ist der Fristen-Stempel; seine Farbe zeigt die Dringlichkeit.
 */

export interface Palette {
  paper: string;
  surface: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  line: string;
  stamp: string;
  stampSoft: string;
  onStamp: string;
  overdue: string;
  overdueSoft: string;
  soon: string;
  soonSoft: string;
  done: string;
  doneSoft: string;
  scrim: string;
}

const light: Palette = {
  paper: '#F3F5F7',
  surface: '#FFFFFF',
  ink: '#17233D',
  inkSoft: '#46526B',
  inkMuted: '#6E7A90',
  line: '#DDE2EA',
  stamp: '#2F5BEA',
  stampSoft: '#E8EEFD',
  onStamp: '#FFFFFF',
  overdue: '#B42318',
  overdueSoft: '#FDECEA',
  soon: '#A15C07',
  soonSoft: '#FEF2D6',
  done: '#1E7A55',
  doneSoft: '#E3F4EC',
  scrim: 'rgba(23, 35, 61, 0.45)',
};

const dark: Palette = {
  paper: '#0E1524',
  surface: '#162038',
  ink: '#E7ECF5',
  inkSoft: '#B4BED1',
  inkMuted: '#8A95AB',
  line: '#26314B',
  stamp: '#7D9BFF',
  stampSoft: '#1E2C52',
  onStamp: '#0E1524',
  overdue: '#FF8A7A',
  overdueSoft: '#3A1D1F',
  soon: '#F2B65A',
  soonSoft: '#3A2C14',
  done: '#5FD3A2',
  doneSoft: '#15322A',
  scrim: 'rgba(0, 0, 0, 0.6)',
};

export const font = {
  regular: 'SchibstedGrotesk_400Regular',
  medium: 'SchibstedGrotesk_500Medium',
  bold: 'SchibstedGrotesk_700Bold',
} as const;

/** Klassische Stufen nach Bringhurst: 12, 14, 16, 18, 21, 24, 30, 36 */
export const type = {
  caption: { fontFamily: font.medium, fontSize: 12, lineHeight: 16 },
  small: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
  label: { fontFamily: font.medium, fontSize: 16, lineHeight: 22 },
  title: { fontFamily: font.bold, fontSize: 18, lineHeight: 24 },
  heading: { fontFamily: font.bold, fontSize: 24, lineHeight: 30 },
  display: { fontFamily: font.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.4 },
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Karten 14, Bedienelemente 10, Chips rund: Rundung folgt der Hierarchie. */
export const radius = { control: 10, card: 14, pill: 999 } as const;

/** Inhaltsbreite auf großen Bildschirmen, damit Zeilen lesbar bleiben. */
export const MAX_CONTENT_WIDTH = 760;
export const WIDE_BREAKPOINT = 900;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Erzeugt Stile aus der aktuellen Palette, neu nur beim Wechsel hell/dunkel. */
export function useStyles<T>(factory: (p: Palette) => T): T {
  const p = usePalette();
  return useMemo(() => factory(p), [p, factory]);
}

export type Urgency = 'overdue' | 'soon' | 'upcoming' | 'later' | 'none';

export function urgencyOf(days: number | null): Urgency {
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 3) return 'soon';
  if (days <= 14) return 'upcoming';
  return 'later';
}

export function urgencyColors(p: Palette, u: Urgency): { fg: string; bg: string } {
  switch (u) {
    case 'overdue':
      return { fg: p.overdue, bg: p.overdueSoft };
    case 'soon':
      return { fg: p.soon, bg: p.soonSoft };
    case 'upcoming':
      return { fg: p.stamp, bg: p.stampSoft };
    default:
      return { fg: p.inkMuted, bg: p.surface };
  }
}
