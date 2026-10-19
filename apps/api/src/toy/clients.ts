/**
 * Clients for the Toy ecosystem. Read-only: ToyPost never holds keys and never sends TOY.
 *
 * ToyChain node: Ethereum-compatible JSON-RPC subset plus toy_ methods (toycoin docs/03, M7; docs/05, section 3).
 * ToyScan: open API /api/v1/… (toycoin docs/05, section 8).
 * Both are specified but not built yet (M7, M11). Field names in answers are therefore read tolerantly
 * (German and English) and the exact format is proposed in toycoin docs/spaeter/10-toypost-schnittstelle.md.
 */

type Fetch = typeof fetch;

export class ToyChainRpc {
  private id = 0;
  private readonly url: string;
  private readonly f: Fetch;
  constructor(url: string, f: Fetch = fetch) {
    this.url = url;
    this.f = f;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.f(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ToyChain-Knoten antwortete mit ${res.status}`);
    const data = (await res.json()) as { result?: T; error?: { message: string } };
    if (data.error) throw new Error(`ToyChain-Knoten: ${data.error.message}`);
    return data.result as T;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_chainId')));
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.call<string>('eth_blockNumber')));
  }

  /** Balance in smallest units. */
  async balance(address: string): Promise<bigint> {
    return BigInt(await this.call<string>('eth_getBalance', [address, 'latest']));
  }

  supply() {
    return this.call<Record<string, unknown>>('toy_getSupply');
  }
  epoch() {
    return this.call<Record<string, unknown>>('toy_getEpoch');
  }
  bootstrap() {
    return this.call<Record<string, unknown>>('toy_getBootstrap');
  }
  constitution() {
    return this.call<Record<string, unknown>>('toy_getConstitution');
  }
}

export type AmpelColor = 'gruen' | 'gelb' | 'rot' | 'unbekannt';

export interface AmpelState {
  color: AmpelColor;
  bigRedLamp: boolean;
  criteria: { id: string; color: AmpelColor; note?: string }[];
}

function color(v: unknown): AmpelColor {
  const s = String(v ?? '').toLowerCase();
  if (['gruen', 'grün', 'green'].includes(s)) return 'gruen';
  if (['gelb', 'yellow'].includes(s)) return 'gelb';
  if (['rot', 'red'].includes(s)) return 'rot';
  return 'unbekannt';
}

/** Reads /api/v1/ampel: overall colour, the big red lamp (A1, A2 or A5 red) and each criterion A1–A9. */
export function parseAmpel(o: any): AmpelState {
  const list = (o?.kriterien ?? o?.criteria ?? []) as any[];
  const criteria = Array.isArray(list)
    ? list.map((k) => ({ id: String(k.nr ?? k.id ?? '?'), color: color(k.farbe ?? k.color), note: k.hinweis ?? k.note ?? k.beleg ?? undefined }))
    : [];
  const lampFromCriteria = criteria.some((k) => ['A1', 'A2', 'A5'].includes(k.id) && k.color === 'rot');
  let overall = color(o?.farbe ?? o?.color ?? o?.gesamt);
  if (overall === 'unbekannt' && criteria.length) {
    overall = criteria.some((k) => k.color === 'rot') ? 'rot' : criteria.some((k) => k.color === 'gelb') ? 'gelb' : 'gruen';
  }
  return { color: overall, bigRedLamp: Boolean(o?.grosseRoteLampe ?? o?.bigRedLamp ?? lampFromCriteria), criteria };
}

export class ToyScanClient {
  private readonly base: string;
  private readonly f: Fetch;
  constructor(base: string, f: Fetch = fetch) {
    this.base = base.replace(/\/$/, '');
    this.f = f;
  }

  private async get(path: string): Promise<any> {
    const res = await this.f(`${this.base}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ToyScan antwortete mit ${res.status} für ${path}`);
    return res.json();
  }

  async ampel(): Promise<AmpelState> {
    return parseAmpel(await this.get('/api/v1/ampel'));
  }

  supply(): Promise<any> {
    return this.get('/api/v1/supply');
  }

  /** Account on ToyChain plus other chains; recent transfers under "transaktionen" or "transactions". */
  async address(address: string): Promise<{ raw: any; transfers: any[] }> {
    const raw = await this.get(`/api/v1/address/${address}`);
    const list = raw?.transaktionen ?? raw?.transactions ?? raw?.toychain?.transaktionen ?? [];
    return { raw, transfers: Array.isArray(list) ? list : [] };
  }

  /** Network data in EIP-3085 format, e.g. chainId for "Anmelden mit Adresse". */
  network(): Promise<any> {
    return this.get('/api/v1/netzwerk');
  }
}

// ---------- GitHub: project progress of the Toy projects ----------

export interface Milestone {
  id: string;
  title: string;
  status: string;
  done: boolean;
}

/** Reads the milestone table of toycoin docs/STATUS.md ("| M2 | Kryptografie … | ✅ fertig |"). */
export function parseMilestones(markdown: string): Milestone[] {
  const out: Milestone[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const id = cells[1];
    if (!/^(M\d+[a-z]?|Start)$/.test(id)) continue;
    if (out.some((m) => m.id === id)) continue;
    const status = cells[3].replace(/\*\*/g, '');
    out.push({ id, title: cells[2].replace(/\*\*/g, '').replace(/`/g, ''), status, done: /✅|fertig|done/i.test(status) });
  }
  return out;
}

/** Milestones that are newly done compared with the last known state. */
export function newlyDone(before: Milestone[], now: Milestone[]): Milestone[] {
  return now.filter((m) => m.done && !before.find((b) => b.id === m.id)?.done);
}

export class GitHubClient {
  private readonly repo: string;
  private readonly token?: string;
  private readonly api: string;
  private readonly f: Fetch;
  constructor(repo: string, token?: string, api = 'https://api.github.com', f: Fetch = fetch) {
    this.repo = repo;
    this.token = token;
    this.api = api.replace(/\/$/, '');
    this.f = f;
  }

  private async req(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<any> {
    const res = await this.f(`${this.api}/repos/${this.repo}${path}`, {
      method,
      headers: {
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ToyPost',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${detail.slice(0, 160)}`);
    }
    return accept.includes('raw') ? res.text() : res.json();
  }

  /** Newest commit that touched a file (sha), to notice changes without downloading the file every time. */
  async latestCommit(path: string, branch: string): Promise<string | undefined> {
    const list = (await this.req('GET', `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=1`)) as { sha: string }[];
    return list[0]?.sha;
  }

  fileText(path: string, ref: string): Promise<string> {
    return this.req('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, 'application/vnd.github.raw+json');
  }

  releases(): Promise<{ id: number; tag_name: string; name: string | null; body: string | null; html_url: string; draft: boolean }[]> {
    return this.req('GET', '/releases?per_page=5');
  }

  createIssue(title: string, body: string, labels: string[] = []): Promise<{ number: number; html_url: string }> {
    return this.req('POST', '/issues', { title, body, labels });
  }

  /** Puts one file on a new branch and opens a pull request – used for the monthly transparency report. */
  async proposeFile(input: { base: string; branch: string; path: string; content: string; message: string; title: string; body: string }): Promise<{ number: number; html_url: string }> {
    const ref = (await this.req('GET', `/git/ref/heads/${encodeURIComponent(input.base)}`)) as { object: { sha: string } };
    await this.req('POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: ref.object.sha });
    await this.req('PUT', `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}`, {
      message: input.message,
      content: Buffer.from(input.content, 'utf8').toString('base64'),
      branch: input.branch,
    });
    return this.req('POST', '/pulls', { title: input.title, head: input.branch, base: input.base, body: input.body });
  }
}
