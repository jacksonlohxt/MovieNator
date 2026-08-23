export const SESSION_KEYS = Object.freeze({
  readinessRun: "movieinator-readiness-run-id",
  groundingDocument: "movieinator-grounding-document-id",
  groundingRun: "movieinator-grounding-run-id",
});

// Keep both previously shipped key families readable while old sessions expire.
// New writes use only the MovieNator keys above and never delete legacy values.
export const RUNTIME_STATUS_STATES = Object.freeze(["not-yet-checked", "mock", "live-gemini", "unavailable"]);

const RUNTIME_STATUS_COPY = Object.freeze({
  "not-yet-checked": {
    label: "Runtime status not yet checked",
    trustLabel: "Checking runtime",
    trustCopy: "Checking server evidence before describing this brief.",
    disclosure: "Runtime status is being checked. The browser does not receive credentials.",
  },
  mock: {
    label: "Mock mode",
    trustLabel: "Synthetic and deterministic",
    trustCopy: "This brief uses local mock logic and synthetic evidence. No live model is active.",
    disclosure: "Local mock mode uses synthetic, deterministic evidence. No credentials or external calls are needed.",
  },
  "live-gemini": {
    label: "Live Gemini",
    trustLabel: "Live model configured",
    trustCopy: "The server reports a ready Gemini model. Result provenance and any fallback are shown with each brief.",
    disclosure: "The server reports a ready Gemini model. The browser does not receive credentials or internal prompts.",
  },
  unavailable: {
    label: "Runtime unavailable",
    trustLabel: "Runtime unavailable",
    trustCopy: "The server could not confirm a usable model. The local flow remains available, but no live success is claimed.",
    disclosure: "Runtime readiness could not be confirmed. You can still use the local flow; no live result is claimed.",
  },
});

function runtimeCopy(state) {
  return { state, ...RUNTIME_STATUS_COPY[state] };
}

export function runtimeStatusFromReadiness(projection, { httpStatus = 200 } = {}) {
  if (projection === undefined) return runtimeCopy("not-yet-checked");
  if (!projection || !Number.isInteger(httpStatus)) return runtimeCopy("unavailable");
  if (projection.ok === false || httpStatus < 200 || httpStatus >= 300) return runtimeCopy("unavailable");
  if (projection.mode === "mock-only" && projection.runtime_mode === "mock" && projection.google?.state === "disabled" && projection.model_backend !== "google_rest") return runtimeCopy("mock");
  if (projection.mode === "google_rest" && projection.google?.state === "passed" && projection.google?.configured === true) return runtimeCopy("live-gemini");
  return runtimeCopy("unavailable");
}

export function modelResultStatus({ backend, fallback = false } = {}) {
  if (fallback) return { state: "deterministic-fallback", copy: "Deterministic fallback used: the live model was unavailable or returned an unusable response. The API supplied this verified result, so it is shown." };
  if (backend === "google_rest") return { state: "live-gemini", copy: "Live Gemini result: the API reports a Gemini-backed brief. Any fallback is called out here." };
  if (backend === "fake") return { state: "mock", copy: "Mock result: synthetic and deterministic. No live model success is claimed." };
  return { state: "unavailable", copy: "The API did not provide usable model provenance, so no live success is claimed." };
}

export function partnerStatusFromProjection(projection, { requestFailed = false } = {}) {
  if (requestFailed || !projection || typeof projection !== "object") return { state: "unavailable", label: "Partner unavailable", detail: "The safe partner projection could not be checked." };
  const provider = projection.provider || {};
  const readiness = projection.readiness || {};
  const providerName = provider.display_name || "registered partner";
  if (readiness.state === "ready") {
    const synthetic = provider.provider_id === "mock-provider" || (projection.environment === "local" && projection.auth_mode === "none_synthetic");
    return {
      state: "ready",
      label: synthetic ? "Synthetic partner ready" : "Partner ready",
      detail: synthetic ? "Mock provider - synthetic evidence only." : `${providerName} is ready for its registered read-only projection.`,
    };
  }
  const reason = readiness.state ? readiness.state.replaceAll("_", " ") : "not confirmed";
  return { state: "unavailable", label: "Partner unavailable", detail: `${providerName}: ${reason}. No partner evidence is claimed.` };
}

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
