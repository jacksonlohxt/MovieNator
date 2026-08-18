import crypto from "node:crypto";

export const PARTNER_CAPABILITY_SCHEMA = "partner-capability@1";
export const PARTNER_READINESS_SCHEMA = "partner-readiness@1";
export const PARTNER_EVENT_SCHEMA = "partner-event@1";
export const PARTNER_PROJECTION_SCHEMA = "partner-projection@1";
export const PARTNER_PROVENANCE_SCHEMA = "partner-provenance@1";

export const PARTNER_ENVIRONMENTS = Object.freeze(["local", "staging", "production", "unknown"]);
export const PARTNER_AUTH_MODES = Object.freeze([
  "none",
  "none_synthetic",
  "oauth2_client_credentials",
  "oauth2_delegated",
  "api_key_reference",
  "adc",
  "injected_reference",
  "mtls_reference",
]);
export const PARTNER_DATA_CLASSES = Object.freeze([
  "synthetic_asset",
  "metadata",
  "quality",
  "governance",
  "lineage",
  "search",
  "telemetry",
]);
export const PARTNER_HEALTH_STATES = Object.freeze(["unknown", "healthy", "degraded", "unavailable", "denied", "misconfigured", "stale", "circuit_open"]);
export const PARTNER_READINESS_STATES = Object.freeze(["unknown", "ready", "not_configured", "missing_auth", "stale", "degraded", "unavailable", "denied", "disabled", "circuit_open"]);

// This is the complete semantic operation vocabulary for this workflow. It is
// intentionally finite. A provider cannot add a tool at runtime.
export const PARTNER_OPERATIONS = Object.freeze([
  "resolve_asset",
  "describe_asset",
  "read_metadata",
  "read_quality",
  "read_governance",
  "read_lineage",
  "search_metadata",
  "search_governance",
  "search_lineage",
  "read_telemetry",
]);
export const READ_ONLY_PARTNER_OPERATIONS = new Set(PARTNER_OPERATIONS);

const CAPABILITY_FIELDS = new Set([
  "schema_version",
  "provider",
  "environment",
  "endpoint_ref",
  "auth_mode",
  "credential_ref",
  "scope_ref",
  "allowed_operations",
  "data_classes",
  "health",
  "redacted_provenance",
  "manifest_hash",
  "enabled",
  "limits",
]);
const PROVIDER_FIELDS = new Set(["provider_id", "display_name", "product_ref", "confirmation_state"]);
const HEALTH_FIELDS = new Set(["state", "checked_at", "detail"]);
const PROVENANCE_FIELDS = new Set(["schema_version", "provider_id", "backend", "environment", "endpoint_ref", "auth_mode", "manifest_hash", "operation", "observed_at", "response_hash", "redacted"]);
const OPERATION_FIELDS = new Set(["operation", "tool_ref", "read_only", "data_class", "input_schema_hash", "output_schema_hash"]);
const LIMIT_FIELDS = new Set(["timeout_ms", "max_attempts", "max_response_bytes", "max_items"]);
const PRIVATE_KEY = /(?:access[_ -]?token|authorization|api[_ -]?key|client[_ -]?secret|credential|password|private[_ -]?key|raw(?:_| )?(?:payload|request|response)|secret|token)/i;
const SECRET_TEXT = /(?:bearer\s+|api[_ -]?key\s*[:=]|client[_ -]?secret\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])[^\s,;]+/gi;

export class PartnerContractError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = "PartnerContractError";
    this.code = code;
    this.field = field;
  }
}

export class PartnerError extends Error {
  constructor(kind, message, { retryable = false, status = undefined, cause = undefined } = {}) {
    super(message, { cause });
    this.name = "PartnerError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, allowed, scope) {
  if (!isPlainObject(value)) throw new PartnerContractError("INVALID_OBJECT", `${scope} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PartnerContractError("UNKNOWN_FIELD", `${scope} contains unknown field: ${key}`, key);
  }
}

function boundedString(value, field, { min = 1, max = 240, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new PartnerContractError("REQUIRED_FIELD", `${field} is required`, field);
  }
  if (typeof value !== "string") throw new PartnerContractError("INVALID_TYPE", `${field} must be a string`, field);
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (normalized.length < min) throw new PartnerContractError("TOO_SHORT", `${field} is too short`, field);
  if (normalized.length > max) throw new PartnerContractError("TOO_LONG", `${field} exceeds ${max} characters`, field);
  return normalized;
}

function enumValue(value, field, values) {
  if (!values.includes(value)) throw new PartnerContractError("INVALID_VALUE", `${field} is not supported`, field);
  return value;
}

function isoTimestamp(value, field, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  const timestamp = boundedString(value, field, { max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new PartnerContractError("INVALID_TIME", `${field} must be a UTC ISO-8601 timestamp`, field);
  }
  return new Date(timestamp).toISOString();
}

function opaqueReference(value, field, { optional = false } = {}) {
  const reference = boundedString(value, field, { max: 300, optional });
  if (reference === undefined) return undefined;
  if (!/^(?:local|config|secret):\/\/[A-Za-z0-9._~:/-]+$/.test(reference)) {
    throw new PartnerContractError("INVALID_REFERENCE", `${field} must be an opaque local, config, or secret reference`, field);
  }
  return reference;
}

function hashReference(value, field, { optional = false } = {}) {
  const reference = boundedString(value, field, { max: 180, optional });
  if (reference === undefined) return undefined;
  if (!/^(?:sha256:)?[a-f0-9]{16,128}$/i.test(reference) && !/^sha256:[A-Za-z0-9._-]{8,180}$/.test(reference)) {
    throw new PartnerContractError("INVALID_HASH", `${field} must be a bounded hash reference`, field);
  }
  return reference.startsWith("sha256:") ? reference : `sha256:${reference}`;
}

function parseProvider(value) {
  rejectUnknown(value, PROVIDER_FIELDS, "provider");
  const providerId = boundedString(value.provider_id, "provider.provider_id", { max: 100 }).toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(providerId)) throw new PartnerContractError("INVALID_PROVIDER_ID", "provider.provider_id must be a stable opaque identifier", "provider.provider_id");
  const result = {
    provider_id: providerId,
    display_name: boundedString(value.display_name, "provider.display_name", { max: 160 }),
    confirmation_state: enumValue(value.confirmation_state || "confirmed", "provider.confirmation_state", ["confirmed", "pending"]),
  };
  const productRef = boundedString(value.product_ref, "provider.product_ref", { max: 180, optional: true });
  if (productRef) result.product_ref = productRef;
  return result;
}

function parseOperation(value, index) {
  const operation = typeof value === "string" ? { operation: value } : value;
  rejectUnknown(operation, OPERATION_FIELDS, `allowed_operations[${index}]`);
  const name = boundedString(operation.operation, `allowed_operations[${index}].operation`, { max: 80 });
  assertReadOnlyOperation(name);
  const result = {
    operation: name,
    tool_ref: boundedString(operation.tool_ref || name, `allowed_operations[${index}].tool_ref`, { max: 160 }),
    read_only: operation.read_only === undefined ? true : operation.read_only,
  };
  if (result.read_only !== true) throw new PartnerContractError("MUTATING_OPERATION", `${name} is not read-only`, `allowed_operations[${index}]`);
  const dataClass = operation.data_class || dataClassForOperation(name);
  result.data_class = enumValue(dataClass, `allowed_operations[${index}].data_class`, PARTNER_DATA_CLASSES);
  const inputHash = hashReference(operation.input_schema_hash, `allowed_operations[${index}].input_schema_hash`, { optional: true });
  const outputHash = hashReference(operation.output_schema_hash, `allowed_operations[${index}].output_schema_hash`, { optional: true });
  if (inputHash) result.input_schema_hash = inputHash;
  if (outputHash) result.output_schema_hash = outputHash;
  return result;
}

function parseHealth(value) {
  rejectUnknown(value, HEALTH_FIELDS, "health");
  return {
    state: enumValue(value.state || "unknown", "health.state", PARTNER_HEALTH_STATES),
    ...(value.checked_at === undefined ? {} : { checked_at: isoTimestamp(value.checked_at, "health.checked_at") }),
    ...(value.detail === undefined ? {} : { detail: boundedString(value.detail, "health.detail", { max: 240 }) }),
  };
}

function parseProvenance(value, capability) {
  rejectUnknown(value, PROVENANCE_FIELDS, "redacted_provenance");
  const result = {
    schema_version: value.schema_version || PARTNER_PROVENANCE_SCHEMA,
    provider_id: boundedString(value.provider_id || capability.provider.provider_id, "redacted_provenance.provider_id", { max: 100 }),
    backend: boundedString(value.backend || "partner-adapter", "redacted_provenance.backend", { max: 100 }),
    environment: enumValue(value.environment || capability.environment, "redacted_provenance.environment", PARTNER_ENVIRONMENTS),
    endpoint_ref: opaqueReference(value.endpoint_ref || capability.endpoint_ref, "redacted_provenance.endpoint_ref"),
    auth_mode: enumValue(value.auth_mode || capability.auth_mode, "redacted_provenance.auth_mode", PARTNER_AUTH_MODES),
    manifest_hash: hashReference(value.manifest_hash || capability.manifest_hash, "redacted_provenance.manifest_hash"),
    redacted: true,
  };
  if (value.redacted !== undefined && value.redacted !== true) throw new PartnerContractError("PROVENANCE_NOT_REDACTED", "Partner provenance must be redacted", "redacted_provenance.redacted");
  for (const field of ["operation", "observed_at", "response_hash"]) {
    if (value[field] !== undefined) result[field] = field === "observed_at" ? isoTimestamp(value[field], `redacted_provenance.${field}`) : field === "response_hash" ? hashReference(value[field], `redacted_provenance.${field}`) : boundedString(value[field], `redacted_provenance.${field}`, { max: 100 });
  }
  return result;
}

function parseLimits(value) {
  if (value === undefined) return { timeout_ms: 8_000, max_attempts: 2, max_response_bytes: 64_000, max_items: 100 };
  rejectUnknown(value, LIMIT_FIELDS, "limits");
  const result = {};
  for (const [field, fallback, max] of [["timeout_ms", 8_000, 120_000], ["max_attempts", 2, 2], ["max_response_bytes", 64_000, 1_000_000], ["max_items", 100, 1_000]]) {
    const number = value[field] === undefined ? fallback : value[field];
    if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new PartnerContractError("INVALID_LIMIT", `${field} is outside the supported bound`, `limits.${field}`);
    result[field] = number;
  }
  return result;
}

/**
 * Parse the server-owned partner capability contract. It rejects unknown
 * provider fields and mutating or unlisted operations before an adapter can be
 * invoked.
 */
export function parsePartnerCapability(value) {
  rejectUnknown(value, CAPABILITY_FIELDS, "partner capability");
  if (value.schema_version !== PARTNER_CAPABILITY_SCHEMA) throw new PartnerContractError("INVALID_SCHEMA_VERSION", `schema_version must be ${PARTNER_CAPABILITY_SCHEMA}`, "schema_version");
  const provider = parseProvider(value.provider);
  const environment = enumValue(value.environment, "environment", PARTNER_ENVIRONMENTS);
  const endpointRef = opaqueReference(value.endpoint_ref, "endpoint_ref");
  const authMode = enumValue(value.auth_mode, "auth_mode", PARTNER_AUTH_MODES);
  const scopeRef = boundedString(value.scope_ref, "scope_ref", { max: 240, optional: true });
  const credentialRef = opaqueReference(value.credential_ref, "credential_ref", { optional: true });
  if (authMode !== "none" && authMode !== "none_synthetic" && !credentialRef) {
    // The capability can describe a not-yet-configured live seam, but it may
    // never claim readiness or make a network call without this reference.
  }
  if (!Array.isArray(value.allowed_operations) || value.allowed_operations.length < 1 || value.allowed_operations.length > PARTNER_OPERATIONS.length) throw new PartnerContractError("INVALID_OPERATIONS", "allowed_operations must contain an explicit bounded allowlist", "allowed_operations");
  const operationMap = new Map();
  for (const [index, operation] of value.allowed_operations.entries()) {
    const parsed = parseOperation(operation, index);
    if (operationMap.has(parsed.operation)) throw new PartnerContractError("DUPLICATE_OPERATION", `allowed_operations contains ${parsed.operation} more than once`, "allowed_operations");
    operationMap.set(parsed.operation, parsed);
  }
  if (!Array.isArray(value.data_classes) || value.data_classes.length < 1 || value.data_classes.length > PARTNER_DATA_CLASSES.length) throw new PartnerContractError("INVALID_DATA_CLASSES", "data_classes must be an explicit bounded list", "data_classes");
  const dataClasses = [...new Set(value.data_classes.map((item, index) => enumValue(item, `data_classes[${index}]`, PARTNER_DATA_CLASSES)))];
  const parsed = {
    schema_version: PARTNER_CAPABILITY_SCHEMA,
    provider,
    environment,
    endpoint_ref: endpointRef,
    auth_mode: authMode,
    ...(credentialRef ? { credential_ref: credentialRef } : {}),
    ...(scopeRef ? { scope_ref: scopeRef } : {}),
    allowed_operations: [...operationMap.values()],
    data_classes: dataClasses,
    health: parseHealth(value.health || { state: "unknown" }),
    manifest_hash: hashReference(value.manifest_hash, "manifest_hash"),
    enabled: value.enabled === undefined ? true : value.enabled,
    limits: parseLimits(value.limits),
  };
  if (typeof parsed.enabled !== "boolean") throw new PartnerContractError("INVALID_TYPE", "enabled must be a boolean", "enabled");
  parsed.redacted_provenance = parseProvenance(value.redacted_provenance || {}, parsed);
  return parsed;
}

export function createPartnerCapability({ provider, environment, endpointRef, authMode, credentialRef, scopeRef, allowedOperations, dataClasses, health, manifestHash, enabled = true, limits } = {}) {
  const manifest = manifestHash || `sha256:${crypto.createHash("sha256").update(JSON.stringify({ provider, environment, endpointRef, authMode, allowedOperations, dataClasses })).digest("hex")}`;
  return parsePartnerCapability({
    schema_version: PARTNER_CAPABILITY_SCHEMA,
    provider,
    environment,
    endpoint_ref: endpointRef,
    auth_mode: authMode,
    ...(credentialRef ? { credential_ref: credentialRef } : {}),
    ...(scopeRef ? { scope_ref: scopeRef } : {}),
    allowed_operations: allowedOperations,
    data_classes: dataClasses,
    health: health || { state: "unknown" },
    manifest_hash: manifest,
    enabled,
    limits,
    redacted_provenance: {
      schema_version: PARTNER_PROVENANCE_SCHEMA,
      provider_id: provider.provider_id,
      backend: "partner-adapter",
      environment,
      endpoint_ref: endpointRef,
      auth_mode: authMode,
      manifest_hash: manifest,
      redacted: true,
    },
  });
}

export function dataClassForOperation(operation) {
  if (operation === "read_quality") return "quality";
  if (operation.includes("governance")) return "governance";
  if (operation.includes("lineage")) return "lineage";
  if (operation.includes("telemetry")) return "telemetry";
  if (operation.includes("search")) return "search";
  return "metadata";
}

export function assertReadOnlyOperation(operation) {
  if (typeof operation !== "string" || !READ_ONLY_PARTNER_OPERATIONS.has(operation)) {
    throw new PartnerContractError("UNKNOWN_CAPABILITY", `Partner operation is not explicitly registered: ${String(operation)}`, "operation");
  }
  if (/\b(?:write|create|update|delete|mutate|publish|submit|send|purchase|deploy|export|execute|run)\b/i.test(operation)) {
    throw new PartnerContractError("MUTATING_OPERATION", `Partner operation is not read-only: ${operation}`, "operation");
  }
  return operation;
}

export function safePartnerHash(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, Object.keys(value || {}).sort());
  return `sha256:${crypto.createHash("sha256").update(serialized || "").digest("hex")}`;
}

export function redactPartnerText(value, max = 600) {
  if (typeof value !== "string") return "";
  return value.replace(SECRET_TEXT, "[redacted]").replace(/<[^>]*>/g, "[redacted]").slice(0, max);
}

/** Remove raw payloads, credentials, headers, and secret-like fields recursively. */
export function redactPartnerValue(value, depth = 0) {
  if (depth > 3) return "[bounded]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactPartnerText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactPartnerValue(item, depth + 1));
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (PRIVATE_KEY.test(key)) continue;
    result[key.slice(0, 100)] = redactPartnerValue(item, depth + 1);
  }
  return result;
}

export function partnerProvenance({ capability, operation, observedAt, responseHash } = {}) {
  const provenance = capability?.redacted_provenance || {};
  return {
    schema_version: PARTNER_PROVENANCE_SCHEMA,
    provider_id: capability?.provider?.provider_id || provenance.provider_id || null,
    backend: provenance.backend || "partner-adapter",
    environment: capability?.environment || provenance.environment || "unknown",
    endpoint_ref: capability?.endpoint_ref || provenance.endpoint_ref || null,
    auth_mode: capability?.auth_mode || provenance.auth_mode || null,
    manifest_hash: capability?.manifest_hash || provenance.manifest_hash || null,
    ...(operation ? { operation } : {}),
    ...(observedAt ? { observed_at: observedAt } : {}),
    ...(responseHash ? { response_hash: responseHash } : {}),
    redacted: true,
  };
}

export function partnerReadiness({ capability, state = "unknown", checkedAt, reasonCodes = [], circuit = undefined, errorClass = undefined } = {}) {
  const readinessState = enumValue(state, "state", PARTNER_READINESS_STATES);
  return {
    schema_version: PARTNER_READINESS_SCHEMA,
    provider_id: capability?.provider?.provider_id || null,
    provider_display_name: capability?.provider?.display_name || null,
    environment: capability?.environment || "unknown",
    endpoint_ref: capability?.endpoint_ref || null,
    auth_mode: capability?.auth_mode || null,
    scope_ref: capability?.scope_ref || null,
    state: readinessState,
    health: capability?.health?.state || "unknown",
    checked_at: checkedAt || capability?.health?.checked_at || null,
    reason_codes: [...new Set(reasonCodes)].slice(0, 12),
    ...(errorClass ? { error_class: String(errorClass).slice(0, 80) } : {}),
    ...(circuit ? { circuit: redactPartnerValue(circuit) } : {}),
    provenance: partnerProvenance({ capability }),
  };
}

export function safePartnerProjection({ capability, readiness, operation = undefined } = {}) {
  const operations = (capability?.allowed_operations || []).map((item) => typeof item === "string" ? item : item.operation);
  return {
    schema_version: PARTNER_PROJECTION_SCHEMA,
    provider: capability?.provider || null,
    environment: capability?.environment || "unknown",
    endpoint_ref: capability?.endpoint_ref || null,
    auth_mode: capability?.auth_mode || null,
    scope_ref: capability?.scope_ref || null,
    allowed_operations: operations,
    data_classes: capability?.data_classes || [],
    enabled: capability?.enabled === true,
    health: capability?.health || { state: "unknown" },
    readiness: readiness || partnerReadiness({ capability }),
    provenance: partnerProvenance({ capability, operation }),
  };
}

export function createPartnerEvent({ providerId, eventType, operation, attempt = 0, state, deliveryId, errorClass, payload = {}, occurredAt = new Date().toISOString() } = {}) {
  return {
    schema_version: PARTNER_EVENT_SCHEMA,
    event_id: `pe_${crypto.randomUUID().replaceAll("-", "")}`,
    provider_id: providerId || null,
    event_type: boundedString(eventType || "partner.operation", "event_type", { max: 100 }),
    operation: operation || null,
    attempt: Number.isSafeInteger(attempt) ? Math.max(0, Math.min(2, attempt)) : 0,
    state: state || "unknown",
    ...(deliveryId ? { delivery_id_hash: safePartnerHash(deliveryId) } : {}),
    ...(errorClass ? { error_class: String(errorClass).slice(0, 80) } : {}),
    payload: redactPartnerValue(payload) || {},
    occurred_at: occurredAt,
    redacted: true,
  };
}

export function isRetryablePartnerError(error) {
  return Boolean(error?.retryable) || new Set(["timeout", "unavailable", "connection_reset", "rate_limited", "bad_gateway", "temporarily_unavailable"]).has(error?.kind);
}

export function mapPartnerError(error) {
  if (error instanceof PartnerError) return error;
  return new PartnerError("unavailable", "Partner operation did not complete", { retryable: true, cause: error });
}
