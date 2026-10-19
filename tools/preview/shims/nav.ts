/** Vorschau-Ersatz für src/nav.ts: Navigation über den URL-Hash. */
import { useEffect, useState } from 'react';

export type Route = string;

export function useNav() {
  return {
    go: (to: Route) => (window.location.hash = to),
    replace: (to: Route) => window.location.replace(`#${to}`),
    back: () => window.history.back(),
  };
}

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function useParam(name: string): string {
  const route = useHashRoute();
  return name === 'id' ? decodeURIComponent(route.split('/')[2] ?? '') : '';
}
