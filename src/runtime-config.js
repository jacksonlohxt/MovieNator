import { GEMINI_SAFETY_POLICY } from "./safety.js";
import { normalizeGeminiConfig, readGeminiConfig } from "./gemini-rest.js";

export const RUNTIME_MODES = Object.freeze(["mock", "adc_local", "deployed_identity"]);
export const DEPLOYMENT_TARGETS = Object.freeze(["local", "container", "cloud_run"]);

export class RuntimeConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeConfigError";
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value) {
  return value === true || value === "true";
}

function boundedEnvNumber(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RuntimeConfigError("INVALID_CONFIGURATION", `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function parsePort(value, { defaultPort = 4173 } = {}) {
  if (value === undefined || value === "") return defaultPort;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new RuntimeConfigError("INVALID_PORT", "PORT must be an integer between 1024 and 65535");
  return port;
}

function deploymentTarget(env) {
  const explicit = text(env.DEPLOYMENT_TARGET);
  if (explicit && !DEPLOYMENT_TARGETS.includes(explicit)) throw new RuntimeConfigError("INVALID_CONFIGURATION", "DEPLOYMENT_TARGET is not supported");
  if (explicit) return explicit;
  if (text(env.K_SERVICE)) return "cloud_run";
  return "local";
}

function collectSecretReferences(env) {
  return Object.entries(env)
    .filter(([name]) => /(?:^|_)SECRET(?:_|$).*_REF$|_SECRET_REF$/.test(name))
    .map(([name, value]) => ({ name, reference: text(value) }))
    .filter(({ reference }) => reference.length > 0);
}

function assertSecretReferences(references) {
  for (const { name, reference } of references) {
    if (!/^projects\/[a-z0-9][a-z0-9-]{0,61}\/secrets\/[a-zA-Z0-9_-]{1,255}\/versions\/(?:latest|[1-9][0-9]*)$/.test(reference)) {
      throw new RuntimeConfigError("INVALID_SECRET_REFERENCE", `${name} must contain a Secret Manager resource reference, not a secret value`);
    }
  }
}

function hasGoogleIntent(env, google, explicitMode) {
  return bool(env.GOOGLE_GEMINI_ENABLED) || google.modelBackend === "google_rest" || ["adc_local", "deployed_identity"].includes(explicitMode);
}

function deriveMode({ env, target, google, explicitMode, googleIntent }) {
  if (explicitMode && !RUNTIME_MODES.includes(explicitMode)) throw new RuntimeConfigError("INVALID_CONFIGURATION", "RUNTIME_MODE is not supported");
  if (explicitMode === "mock") {
    if (googleIntent) throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "RUNTIME_MODE=mock cannot be combined with live Gemini settings");
    return "mock";
  }
  if (!googleIntent) {
    if (explicitMode) throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "A live runtime mode requires explicit Gemini configuration");
    return "mock";
  }
  if (target === "cloud_run") {
    if (explicitMode && explicitMode !== "deployed_identity") throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Cloud Run Gemini requires RUNTIME_MODE=deployed_identity");
    if (!google.configured || !google.enabled || google.modelBackend !== "google_rest" || !["workload_identity", "attached_identity"].includes(google.authMode)) {
      throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Cloud Run Gemini configuration is incomplete or does not use a deployed identity");
    }
    if (google.readiness !== "passed") throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Cloud Run Gemini configuration must have passed operator readiness");
    return "deployed_identity";
  }
  if (explicitMode && explicitMode !== "adc_local") throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Local live Gemini requires RUNTIME_MODE=adc_local");
  if (!google.enabled || google.modelBackend !== "google_rest" || !google.configured || !["adc", "injected-test-token"].includes(google.authMode)) {
    if (target === "local" && !explicitMode && bool(env.GOOGLE_GEMINI_ENABLED)) return "mock";
    throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Local Gemini requires complete ADC-backed server configuration");
  }
  if (google.readiness !== "passed") {
    if (target === "local" && !explicitMode && google.authMode === "adc") return "mock";
    throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Local Gemini readiness must be explicitly passed");
  }
  return "adc_local";
}

/**
 * Validate process-owned runtime configuration. This function intentionally
 * does not accept browser input and never reads a secret value.
 */
export function readRuntimeConfig(env = process.env, { googleConfig } = {}) {
  const target = deploymentTarget(env);
  const explicitMode = text(env.RUNTIME_MODE) || undefined;
  const google = normalizeGeminiConfig(googleConfig || readGeminiConfig(env));
  const googleIntent = hasGoogleIntent(env, google, explicitMode);
  const mode = deriveMode({ env, target, google, explicitMode, googleIntent });
  const production = env.NODE_ENV === "production" || env.RUNTIME_ENV === "production" || target === "cloud_run";
  if (production && mode === "mock" && explicitMode !== "mock") {
    throw new RuntimeConfigError("UNSAFE_CONFIGURATION", "Production mock mode must be explicit with RUNTIME_MODE=mock");
  }
  const secretReferences = collectSecretReferences(env);
  assertSecretReferences(secretReferences);
  const port = parsePort(env.PORT, { defaultPort: target === "cloud_run" ? 8080 : 4173 });
  const requestTimeoutMs = boundedEnvNumber(env.REQUEST_TIMEOUT_MS, 30_000, 1_000, 120_000, "REQUEST_TIMEOUT_MS");
  const gracefulShutdownMs = boundedEnvNumber(env.GRACEFUL_SHUTDOWN_MS, 10_000, 1_000, 60_000, "GRACEFUL_SHUTDOWN_MS");
  const maxBodyBytes = boundedEnvNumber(env.MAX_BODY_BYTES, 128 * 1024, 1_024, 8 * 1024 * 1024, "MAX_BODY_BYTES");
  const readiness = mode === "mock" ? "ready" : google.readiness === "passed" ? "ready" : "not_ready";
  return Object.freeze({
    mode,
    target,
    production,
    port,
    host: ["cloud_run", "container"].includes(target) ? "0.0.0.0" : "127.0.0.1",
    requestTimeoutMs,
    gracefulShutdownMs,
    maxBodyBytes,
    readiness,
    googleIntent,
    google: Object.freeze({
      enabled: google.enabled,
      configured: google.configured,
      readiness: google.readiness,
      authMode: google.authMode || null,
      missing: Object.freeze([...google.missing]),
    }),
    safety: GEMINI_SAFETY_POLICY,
    secretReferenceCount: secretReferences.length,
    secretReferences: Object.freeze(secretReferences.map(({ name, reference }) => Object.freeze({ name, reference }))),
  });
}

export function assertRuntimeConfig(env = process.env, options = {}) {
  return readRuntimeConfig(env, options);
}

export const validateRuntimeConfig = readRuntimeConfig;
