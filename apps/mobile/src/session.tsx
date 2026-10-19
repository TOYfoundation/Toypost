import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Constants from 'expo-constants';
import type { Api, Me } from './api/types.ts';
import { HttpApi } from './api/http.ts';
import { DemoApi } from './api/demo.ts';
import { storage } from './storage.ts';

const TOKEN_KEY = 'toypost.token';
const MODE_KEY = 'toypost.mode';

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:8787';

type Status = 'loading' | 'signedOut' | 'ready';

interface Session {
  status: Status;
  api: Api;
  me: Me | null;
  /** Zähler, der nach jeder Änderung steigt; Bildschirme laden dann neu */
  version: number;
  refresh: () => Promise<void>;
  touch: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  startDemo: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children, initialApi }: { children: ReactNode; initialApi?: Api }) {
  const [status, setStatus] = useState<Status>(initialApi ? 'ready' : 'loading');
  const [api, setApi] = useState<Api>(() => initialApi ?? new DemoApi());
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async (next: Api) => {
    setApi(next);
    const account = await next.me();
    setMe(account);
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (initialApi) {
      initialApi.me().then(setMe);
      return;
    }
    (async () => {
      const mode = await storage.get(MODE_KEY);
      const token = await storage.get(TOKEN_KEY);
      try {
        if (mode === 'demo') return await load(new DemoApi());
        if (mode === 'live' && token) return await load(new HttpApi(API_URL, token));
      } catch {
        await storage.remove(TOKEN_KEY);
      }
      setStatus('signedOut');
    })();
  }, [initialApi, load]);

  const value = useMemo<Session>(
    () => ({
      status,
      api,
      me,
      version,
      refresh: async () => {
        setMe(await api.me());
        setVersion((v) => v + 1);
      },
      touch: () => {
        setVersion((v) => v + 1);
        api.me().then(setMe).catch(() => {});
      },
      signIn: async (email, password) => {
        const { token } = await HttpApi.login(API_URL, email, password);
        await storage.set(TOKEN_KEY, token);
        await storage.set(MODE_KEY, 'live');
        await load(new HttpApi(API_URL, token));
      },
      register: async (name, email, password) => {
        const { token } = await HttpApi.register(API_URL, name, email, password);
        await storage.set(TOKEN_KEY, token);
        await storage.set(MODE_KEY, 'live');
        await load(new HttpApi(API_URL, token));
      },
      startDemo: async () => {
        await storage.set(MODE_KEY, 'demo');
        await load(new DemoApi());
      },
      signOut: async () => {
        await storage.remove(TOKEN_KEY);
        await storage.remove(MODE_KEY);
        setMe(null);
        setStatus('signedOut');
      },
    }),
    [status, api, me, version, load],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession außerhalb von SessionProvider');
  return s;
}

/** Lädt Daten und lädt neu, sobald sich etwas geändert hat. */
export function useLoad<T>(fn: (api: Api) => Promise<T>, deps: unknown[] = []) {
  const { api, version } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn(api));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, version, ...deps]);

  useEffect(() => {
    run();
  }, [run]);

  return { data, error, loading, reload: run };
}
