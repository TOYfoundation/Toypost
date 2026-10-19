/** Ersatzmodule für Expo-Pakete in der Vorschau. */
import { createElement } from 'react';
import * as Fi from 'react-icons/fi';

// @expo/vector-icons
function pascal(name: string) {
  return 'Fi' + name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
export function Feather({ name, size = 20, color }: { name: string; size?: number; color?: string }) {
  const Cmp = (Fi as Record<string, any>)[pascal(name)] ?? Fi.FiCircle;
  return createElement(Cmp, { size, color, 'aria-hidden': true, style: { flexShrink: 0, display: 'block' } });
}
(Feather as any).glyphMap = {};

// react-native-safe-area-context
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const SafeAreaProvider = ({ children }: any) => children;

// expo-clipboard
export const setStringAsync = async (s: string) => navigator.clipboard?.writeText(s);

// expo-image-picker / expo-document-picker / expo-web-browser / expo-secure-store
export const requestCameraPermissionsAsync = async () => ({ granted: true });
export const launchCameraAsync = async () => ({ canceled: true, assets: [] });
export const getDocumentAsync = async () => ({ canceled: true, assets: [] });
export const openBrowserAsync = async (u: string) => window.open(u, '_blank');
export const getItemAsync = async () => null;
export const setItemAsync = async () => undefined;
export const deleteItemAsync = async () => undefined;


// react-native-qrcode-svg: in der Vorschau ein Platzhalter mit Suchmustern
export function QRCode({ size = 160 }: { size?: number; value: string }) {
  const n = 25;
  const cell = size / n;
  const cells: any[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const finder = (x: number, y: number) => x < 7 && y < 7;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const inFinder = finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
      let on = rnd() > 0.52;
      if (inFinder) {
        const fx = x < 7 ? x : n - 1 - x;
        const fy = y < 7 ? y : n - 1 - y;
        on = fx === 0 || fy === 0 || fx === 6 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4);
      }
      if (on) cells.push(createElement('rect', { key: `${x}-${y}`, x: x * cell, y: y * cell, width: cell, height: cell, fill: '#000' }));
    }
  return createElement('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, cells);
}
