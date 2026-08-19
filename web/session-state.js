export const SESSION_KEYS = Object.freeze({
  readinessRun: "movie-inator-readiness-run-id",
  groundingDocument: "movie-inator-grounding-document-id",
  groundingRun: "movie-inator-grounding-run-id",
});

// The readiness key is the only legacy browser key from the pre-rename app.
// Keep this one bounded alias until old sessions have naturally expired.
export const LEGACY_SESSION_KEYS = Object.freeze({
  readinessRun: Object.freeze(["gemini-agents-run-id"]),
  groundingDocument: Object.freeze([]),
  groundingRun: Object.freeze([]),
});

export function readMigratedSessionValue(storage, key, legacyKeys = []) {
  const current = storage.getItem(key);
  if (current) return current;
  for (const legacyKey of legacyKeys) {
    const legacy = storage.getItem(legacyKey);
    if (!legacy) continue;
    storage.setItem(key, legacy);
    return legacy;
  }
  return null;
}

export function writeSessionValue(storage, key, value) {
  storage.setItem(key, value);
}
