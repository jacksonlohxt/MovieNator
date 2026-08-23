export const SESSION_KEYS = Object.freeze({
  readinessRun: "movieinator-readiness-run-id",
  groundingDocument: "movieinator-grounding-document-id",
  groundingRun: "movieinator-grounding-run-id",
});

// Keep both previously shipped key families readable while old sessions expire.
// New writes use only the MovieNator keys above and never delete legacy values.
export const LEGACY_SESSION_KEYS = Object.freeze({
  readinessRun: Object.freeze(["movie-inator-readiness-run-id", "gemini-agents-run-id"]),
  groundingDocument: Object.freeze(["movie-inator-grounding-document-id", "gemini-agents-grounding-document-id"]),
  groundingRun: Object.freeze(["movie-inator-grounding-run-id", "gemini-agents-grounding-run-id"]),
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
