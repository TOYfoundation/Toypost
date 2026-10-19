/**
 * RSS 2.0, Atom and JSON Feed, read without an XML library: only the few elements ToyPost needs.
 * Typical sources: GitHub release feeds, project blogs, authority announcements, status pages, ToyScan RSS alarms.
 */

export interface FeedItem {
  /** stable key for "already seen": guid, id or link */
  key: string;
  title: string;
  link?: string;
  text: string;
  date?: string;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Removes HTML tags from feed content and condenses whitespace. */
export function stripHtml(s: string): string {
  return decodeXml(
    decodeXml(s)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : undefined;
}

function atomLink(xml: string): string | undefined {
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/.test(a)) ?? links.find((a) => !/rel=/.test(a)) ?? links[0];
  return pick ? /href=["']([^"']+)["']/.exec(pick)?.[1] : undefined;
}

export function parseFeed(body: string): Feed {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    if (!Array.isArray(j.items)) throw new Error('JSON Feed ohne "items".');
    return {
      title: String(j.title ?? 'Feed'),
      items: j.items.map((it: any) => ({
        key: String(it.id ?? it.url ?? it.title),
        title: String(it.title ?? '').trim() || '(ohne Titel)',
        link: it.url,
        text: it.content_text ?? stripHtml(String(it.content_html ?? it.summary ?? '')),
        date: it.date_published ?? it.date_modified,
      })),
    };
  }
  if (/<feed[\s>]/i.test(trimmed)) {
    const head = trimmed.split(/<entry[\s>]/i)[0];
    return {
      title: stripHtml(tag(head, 'title') ?? 'Feed'),
      items: [...trimmed.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => {
        const e = m[0];
        const link = atomLink(e);
        return {
          key: decodeXml(tag(e, 'id') ?? link ?? tag(e, 'title') ?? ''),
          title: stripHtml(tag(e, 'title') ?? '') || '(ohne Titel)',
          link: link ? decodeXml(link) : undefined,
          text: stripHtml(tag(e, 'content') ?? tag(e, 'summary') ?? ''),
          date: tag(e, 'updated') ?? tag(e, 'published'),
        };
      }),
    };
  }
  if (/<rss[\s>]|<rdf:RDF/i.test(trimmed)) {
    const channel = tag(trimmed, 'channel') ?? trimmed;
    const head = channel.split(/<item[\s>]/i)[0];
    return {
      title: stripHtml(tag(head, 'title') ?? 'Feed'),
      items: [...trimmed.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => {
        const it = m[0];
        const link = tag(it, 'link');
        return {
          key: decodeXml(tag(it, 'guid') ?? link ?? tag(it, 'title') ?? ''),
          title: stripHtml(tag(it, 'title') ?? '') || '(ohne Titel)',
          link: link ? decodeXml(link) : undefined,
          text: stripHtml(tag(it, 'content:encoded') ?? tag(it, 'description') ?? ''),
          date: tag(it, 'pubDate') ?? tag(it, 'dc:date'),
        };
      }),
    };
  }
  throw new Error('Unbekanntes Feed-Format (erwartet RSS, Atom oder JSON Feed).');
}
