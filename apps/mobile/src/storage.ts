import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Zugangstoken: auf Geräten im Schlüsselbund, im Browser im localStorage. */
export const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* privater Modus: Sitzung gilt nur bis zum Neuladen */
      }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* nichts zu tun */
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
