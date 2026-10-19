import { router, useLocalSearchParams } from 'expo-router';

/**
 * Einzige Stelle, an der Bildschirme mit dem Router sprechen.
 * Dadurch bleiben die Bildschirme unabhängig von Expo Router (und lassen sich in der Vorschau rendern).
 */
export type Route =
  | '/'
  | '/vorgaenge'
  | '/scannen'
  | '/suche'
  | '/posteingang'
  | '/kanaele'
  | '/toy'
  | '/konto'
  | '/tarife'
  | '/credits'
  | '/integrationen'
  | '/anmelden'
  | `/vorgang/${string}`;

export function useNav() {
  return {
    go: (to: Route) => router.push(to as never),
    replace: (to: Route) => router.replace(to as never),
    back: () => (router.canGoBack() ? router.back() : router.replace('/' as never)),
  };
}

export function useParam(name: string): string {
  const params = useLocalSearchParams<Record<string, string>>();
  const v = params[name];
  return Array.isArray(v) ? v[0] : (v ?? '');
}
