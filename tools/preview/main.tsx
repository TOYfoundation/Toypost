/**
 * Vorschau der echten Bildschirme im Browser (Demo-Daten), für Screenshots und schnelle Design-Durchsicht.
 * Die App selbst läuft mit Expo; diese Vorschau ersetzt nur react-native und den Router durch einfache Gegenstücke.
 */
import { createRoot } from 'react-dom/client';
import { useWindowDimensions, View } from 'react-native';
import { SessionProvider } from '../../apps/mobile/src/session.tsx';
import { DemoApi } from '../../apps/mobile/src/api/demo.ts';
import { TabBar, type TabKey } from '../../apps/mobile/src/components/TabBar.tsx';
import { TodayScreen } from '../../apps/mobile/src/screens/TodayScreen.tsx';
import { CasesScreen } from '../../apps/mobile/src/screens/CasesScreen.tsx';
import { CaptureScreen } from '../../apps/mobile/src/screens/CaptureScreen.tsx';
import { SearchScreen } from '../../apps/mobile/src/screens/SearchScreen.tsx';
import { AccountScreen } from '../../apps/mobile/src/screens/AccountScreen.tsx';
import { CaseScreen } from '../../apps/mobile/src/screens/CaseScreen.tsx';
import { PlansScreen } from '../../apps/mobile/src/screens/PlansScreen.tsx';
import { CreditsScreen } from '../../apps/mobile/src/screens/CreditsScreen.tsx';
import { IntegrationsScreen } from '../../apps/mobile/src/screens/IntegrationsScreen.tsx';
import { SignInScreen } from '../../apps/mobile/src/screens/SignInScreen.tsx';
import { useHashRoute } from './shims/nav.ts';
import { WIDE_BREAKPOINT, usePalette } from '../../apps/mobile/src/theme.ts';

const TAB_ROUTES: Record<string, TabKey> = { '/': 'index', '/vorgaenge': 'vorgaenge', '/scannen': 'scannen', '/suche': 'suche', '/konto': 'konto' };
const TAB_PATH: Record<TabKey, string> = { index: '/', vorgaenge: '/vorgaenge', scannen: '/scannen', suche: '/suche', konto: '/konto' };

function Current({ route }: { route: string }) {
  if (route.startsWith('/vorgang/')) return <CaseScreen key={route} />;
  switch (route) {
    case '/vorgaenge':
      return <CasesScreen />;
    case '/scannen':
      return <CaptureScreen />;
    case '/suche':
      return <SearchScreen />;
    case '/konto':
      return <AccountScreen />;
    case '/tarife':
      return <PlansScreen />;
    case '/credits':
      return <CreditsScreen />;
    case '/integrationen':
      return <IntegrationsScreen />;
    case '/anmelden':
      return <SignInScreen />;
    default:
      return <TodayScreen />;
  }
}

function Shell() {
  const route = useHashRoute();
  const { width } = useWindowDimensions();
  const p = usePalette();
  const wide = width >= WIDE_BREAKPOINT;
  const tab = TAB_ROUTES[route] ?? (route.startsWith('/vorgang/') ? 'vorgaenge' : 'konto');
  const showTabs = route !== '/anmelden';
  const bar = showTabs ? <TabBar vertical={wide} active={tab} onSelect={(k) => (window.location.hash = TAB_PATH[k])} /> : null;
  return (
    <View style={{ height: '100vh', flexDirection: wide ? 'row' : 'column', backgroundColor: p.paper }}>
      {wide ? bar : null}
      <View style={{ flex: 1, minHeight: 0 }}>
        <Current route={route} />
      </View>
      {!wide ? bar : null}
    </View>
  );
}

createRoot(document.getElementById('root')!).render(
  <SessionProvider initialApi={new DemoApi()}>
    <Shell />
  </SessionProvider>,
);
