import { getDb } from "./db";

/** Small key/value state kept in the local database (not user configuration). */
export function getSetting<T>(key: string): T | null {
  const raw = getDb().get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function putSetting(key: string, value: unknown) {
  if (value === null || value === undefined) getDb().run("DELETE FROM settings WHERE key = ?", key);
  else getDb().run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
}
