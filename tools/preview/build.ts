/**
 * Baut die Vorschau mit Bun: `bun tools/preview/build.ts`
 * Ersetzt react-native, Expo-Module und den Router durch die Shims in ./shims.
 */
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = import.meta.dir;
const root = resolve(here, '../..');
const out = resolve(here, 'out');
const REACT_DIR = process.env.REACT_DIR ?? resolve(root, 'node_modules');

const map: Record<string, string> = {
  'react-native': resolve(here, 'shims/react-native.tsx'),
  'react-native-safe-area-context': resolve(here, 'shims/expo.tsx'),
  '@expo/vector-icons': resolve(here, 'shims/expo.tsx'),
  'expo-clipboard': resolve(here, 'shims/expo.tsx'),
  'expo-image-picker': resolve(here, 'shims/expo.tsx'),
  'expo-document-picker': resolve(here, 'shims/expo.tsx'),
  'expo-web-browser': resolve(here, 'shims/expo.tsx'),
  'expo-secure-store': resolve(here, 'shims/expo.tsx'),
  'expo-constants': resolve(here, 'shims/constants.ts'),
  'react-native-qrcode-svg': resolve(here, 'shims/qrcode.ts'),
  '@dokufy/shared': resolve(root, 'packages/shared/src/index.ts'),
};

const result = await Bun.build({
  entrypoints: [resolve(here, 'main.tsx')],
  outdir: out,
  target: 'browser',
  minify: false,
  define: { 'process.env.EXPO_PUBLIC_API_URL': 'undefined', 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'dokufy-preview-shims',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (map[args.path]) return { path: map[args.path] };
          if (args.path.endsWith('/nav.ts') && args.importer.includes('apps/mobile/src')) return { path: resolve(here, 'shims/nav.ts') };
          if (/^react(-dom)?(\/.*)?$/.test(args.path) || args.path.startsWith('react-icons')) {
            return { path: Bun.resolveSync(args.path, REACT_DIR) };
          }
          return undefined;
        });
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(
  resolve(out, 'index.html'),
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dokufy Vorschau</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<style>html,body,#root{margin:0;height:100%;}body{-webkit-font-smoothing:antialiased;font-family:'Schibsted Grotesk',system-ui,sans-serif}@keyframes rn-spin{to{transform:rotate(360deg)}}input,textarea{font:inherit}</style>
</head><body><div id="root"></div><script src="./main.js"></script></body></html>`,
);
console.log(`Vorschau gebaut: ${out}/index.html`);
