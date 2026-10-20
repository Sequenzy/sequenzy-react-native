import type { KeyValueStorage } from "./types";

export function createMemoryStorage(
  initial: Record<string, string> = {}
): KeyValueStorage & { snapshot(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}

/** Prefixes every key so the SDK never collides with the app's own keys. */
export function prefixedStorage(
  storage: KeyValueStorage,
  prefix = "@sequenzy/"
): KeyValueStorage {
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
  };
}

/**
 * AsyncStorage when the app has it installed, otherwise memory (state then
 * resets on every launch, which the SDK logs once).
 */
export function defaultStorage(
  warn: (message: string) => void
): KeyValueStorage {
  try {
    const module = require("@react-native-async-storage/async-storage") as {
      default?: KeyValueStorage;
    } & KeyValueStorage;
    const asyncStorage = module.default ?? module;
    if (typeof asyncStorage.getItem === "function") return asyncStorage;
  } catch {
    // Not installed.
  }
  warn(
    "@react-native-async-storage/async-storage is not installed; Sequenzy state will not survive app restarts"
  );
  return createMemoryStorage();
}
