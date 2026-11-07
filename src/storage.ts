/**
 * localStorage helpers that never throw: storage can be unavailable (private browsing,
 * blocked site data), in which case reads return null and writes are skipped.
 */
export function readStorageJson(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch (error) {
    console.warn(`Could not read saved "${key}".`, error);
    return null;
  }
}

export function writeStorageJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save "${key}".`, error);
  }
}

export function removeStorageItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore: a leftover entry is harmless.
  }
}
