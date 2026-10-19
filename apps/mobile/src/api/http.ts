import type { Api, IntegrationKind } from './types.ts';
import { ApiError } from './types.ts';

/** Verbindung zur ToyPost-API. */
export class HttpApi implements Api {
  readonly mode = 'live' as const;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  static async login(baseUrl: string, email: string, password: string): Promise<{ token: string }> {
    return request(baseUrl, 'POST', '/v1/auth/login', undefined, { email, password });
  }

  static async register(baseUrl: string, name: string, email: string, password: string): Promise<{ token: string }> {
    return request(baseUrl, 'POST', '/v1/auth/register', undefined, { name, email, password });
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(this.baseUrl, method, path, this.token, body);
  }

  me = () => this.call<any>('GET', '/v1/me');
  today = () => this.call<any>('GET', '/v1/today');
  cases = (status?: string, q?: string) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (q) qs.set('q', q);
    return this.call<any>('GET', `/v1/cases${qs.toString() ? `?${qs}` : ''}`);
  };
  caseDetail = (id: string) => this.call<any>('GET', `/v1/cases/${encodeURIComponent(id)}`);
  updateCase = (id: string, patch: object) => this.call<any>('PATCH', `/v1/cases/${encodeURIComponent(id)}`, patch);
  markPaid = (id: string) => this.call<any>('POST', `/v1/cases/${encodeURIComponent(id)}/paid`, {});
  giroCode = (id: string) => this.call<any>('GET', `/v1/cases/${encodeURIComponent(id)}/girocode`);
  createDraft = (id: string, input: object) => this.call<any>('POST', `/v1/cases/${encodeURIComponent(id)}/draft`, input);
  sendDraft = (draftId: string, channelId?: string) =>
    this.call<any>('POST', `/v1/drafts/${encodeURIComponent(draftId)}/send`, channelId === undefined ? {} : { channelId });
  upload = (input: object) => this.call<any>('POST', '/v1/documents', input);
  search = (q: string) => this.call<any>('GET', `/v1/search?q=${encodeURIComponent(q)}`);
  ask = (question: string) => this.call<any>('POST', '/v1/ask', { question });
  catalog = () => this.call<any>('GET', '/v1/billing/catalog');
  credits = () => this.call<any>('GET', '/v1/billing/credits');
  checkout = (input: object) => this.call<any>('POST', '/v1/billing/checkout', input);
  integrations = () => this.call<any>('GET', '/v1/integrations');
  saveIntegration = (kind: IntegrationKind, config: Record<string, string>) => this.call<any>('PUT', `/v1/integrations/${kind}`, config);
  // ToyPost
  messages = (filter: { direction?: 'in' | 'out' } = {}) => this.call<any>('GET', `/v1/messages${filter.direction ? `?direction=${filter.direction}` : ''}`);
  contacts = (q?: string) => this.call<any>('GET', `/v1/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  channels = () => this.call<any>('GET', '/v1/channels');
  createChannel = (input: object) => this.call<any>('POST', '/v1/channels', input);
  testChannel = (id: string, to?: string) => this.call<any>('POST', `/v1/channels/${encodeURIComponent(id)}/test`, to ? { to } : {});
  toyOverview = () => this.call<any>('GET', '/v1/toy/overview');
  broadcasts = () => this.call<any>('GET', '/v1/broadcasts');
  previewBroadcast = (id: string, lang: string) => this.call<any>('GET', `/v1/broadcasts/${encodeURIComponent(id)}/preview?lang=${encodeURIComponent(lang)}`);
  sendBroadcast = (id: string) => this.call<any>('POST', `/v1/broadcasts/${encodeURIComponent(id)}/send`, {});
  discardBroadcast = (id: string) => this.call<any>('POST', `/v1/broadcasts/${encodeURIComponent(id)}/discard`, {});
  createInvoice = (input: object) => this.call<any>('POST', '/v1/toy/invoices', input);
  checkText = (text: string) => this.call<any>('POST', '/v1/toy/check', { text });
  automations = () => this.call<any>('GET', '/v1/automations');
  installPreset = (id: string, ids: object) => this.call<any>('POST', `/v1/automations/presets/${encodeURIComponent(id)}`, ids);
}

async function request<T>(baseUrl: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Keine Verbindung zum Server. Prüfe deine Internetverbindung.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as any).error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Fehler ${res.status}`, e.details);
  }
  return data as T;
}
