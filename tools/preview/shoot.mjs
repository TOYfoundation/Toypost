// Screenshots der Vorschau: node tools/preview/shoot.mjs [ausgabeordner]
// Braucht Playwright mit Chromium (PLAYWRIGHT_MODULE zeigt bei Bedarf auf eine globale Installation).
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(new URL(import.meta.url).pathname);
const outDir = resolve(process.argv[2] ?? resolve(here, 'out/shots'));
mkdirSync(outDir, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const page_url = pathToFileURL(resolve(here, 'out/index.html')).href;

const shots = [
  { name: 'heute-mobil', route: '/', w: 390, h: 844 },
  { name: 'heute-mobil-lang', route: '/', w: 390, h: 1700 },
  { name: 'heute-dunkel', route: '/', w: 390, h: 844, dark: true },
  { name: 'vorgang-steuer', route: '/vorgang/demo_steuer', w: 390, h: 2300 },
  { name: 'vorgaenge', route: '/vorgaenge', w: 390, h: 844 },
  { name: 'erfassen', route: '/scannen', w: 390, h: 1100 },
  { name: 'suche', route: '/suche', w: 390, h: 844 },
  { name: 'konto', route: '/konto', w: 390, h: 1000 },
  { name: 'tarife-desktop', route: '/tarife', w: 1280, h: 1500 },
  { name: 'credits', route: '/credits', w: 390, h: 1500 },
  { name: 'verbindungen', route: '/integrationen', w: 390, h: 1500 },
  { name: 'anmelden', route: '/anmelden', w: 390, h: 844 },
  { name: 'heute-desktop', route: '/', w: 1280, h: 900 },
];

const browser = await chromium.launch();
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, colorScheme: s.dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${page_url}#${s.route}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(outDir, `${s.name}.png`) });
  console.log(`${s.name}${errors.length ? '  FEHLER: ' + errors.join(' | ') : ''}`);
  await ctx.close();
}
await browser.close();
