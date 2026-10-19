/** Schlanker Client für die REST-API von Paperless-ngx (Token-Authentifizierung). */

export interface PaperlessConfig {
  url: string;
  token: string;
}

export interface PaperlessDocument {
  id: number;
  title: string;
  content: string;
  created: string;
  correspondentName?: string;
}

export class PaperlessClient {
  private readonly base: string;
  private readonly token: string;

  constructor(cfg: PaperlessConfig) {
    this.base = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Token ${this.token}`, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Paperless antwortete mit ${res.status} auf ${path}`);
    return res;
  }

  async test(): Promise<void> {
    await this.req('/api/documents/?page_size=1');
  }

  async getDocument(id: number): Promise<PaperlessDocument> {
    const doc = (await (await this.req(`/api/documents/${id}/`)).json()) as {
      id: number;
      title: string;
      content: string;
      created: string;
      correspondent: number | null;
    };
    let correspondentName: string | undefined;
    if (doc.correspondent) {
      const c = (await (await this.req(`/api/correspondents/${doc.correspondent}/`)).json()) as { name: string };
      correspondentName = c.name;
    }
    return { id: doc.id, title: doc.title, content: doc.content, created: doc.created, correspondentName };
  }

  /** Lädt eine Datei in die Verarbeitung (Consumer). Gibt die Task-ID zurück. */
  async upload(file: { name: string; data: Buffer; mime: string }, meta: { title?: string; created?: string } = {}): Promise<string> {
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
    if (meta.title) form.append('title', meta.title);
    if (meta.created) form.append('created', meta.created);
    const res = await this.req('/api/documents/post_document/', { method: 'POST', body: form });
    return (await res.text()).replace(/"/g, '');
  }

  /** Setzt das Custom Field "Vorgang", damit Paperless und ToyPost dieselbe Zuordnung kennen. */
  async setCaseField(documentId: number, fieldId: number, caseId: string): Promise<void> {
    await this.req(`/api/documents/${documentId}/`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom_fields: [{ field: fieldId, value: caseId }] }),
    });
  }
}
