import crypto from "node:crypto";

export const REQUEST_SCHEMA = "run-request@1";
export const PLAN_SCHEMA = "readiness-plan@1";
export const BUNDLE_SCHEMA = "evidence-bundle@1";
export const DECISION_SCHEMA = "policy-decision@1";
export const DRAFT_SCHEMA = "brief-draft@1";
export const RESULT_SCHEMA = "readiness-brief@1";
export const EVENT_SCHEMA = "run-event@1";

export const WORKFLOW = "audience_data_readiness";
export const POLICY_VERSION = "readiness-policy@1.0.0";
export const PROVIDER_MODE = "mock";
export const MODEL_MODE = "fake";
export const PROVENANCE = Object.freeze({
  model: "Deterministic mock",
  provider: "Demo evidence",
  label: "Deterministic mock / Demo evidence",
});

export const RUN_STATES = Object.freeze([
  "accepted",
  "queued",
  "planning",
  "resolving_asset",
  "evidence_pending",
  "evidence_partial",
  "composing",
  "validating",
  "needs_input",
  "succeeded",
  "cancel_requested",
  "canceled",
  "expired",
  "failed",
]);

export const TERMINAL_STATES = new Set([
  "needs_input",
  "succeeded",
  "canceled",
  "expired",
  "failed",
]);

export const ACTIVE_STATES = new Set([
  "accepted",
  "queued",
  "planning",
  "resolving_asset",
  "evidence_pending",
  "evidence_partial",
  "composing",
  "validating",
  "cancel_requested",
]);

export const DECISIONS = Object.freeze(["READY", "REVIEW", "BLOCKED", "UNKNOWN"]);
export const EVIDENCE_STATUSES = Object.freeze([
  "complete",
  "missing",
  "denied",
  "stale",
  "timed_out",
  "unavailable",
  "invalid",
  "skipped",
]);
export const CHECK_KINDS = Object.freeze(["asset", "quality", "governance", "lineage"]);
export const REQUIRED_EVIDENCE = Object.freeze([...CHECK_KINDS]);
export const RETRYABLE_PROVIDER_ERRORS = new Set(["timeout", "unavailable", "connection_reset", "rate_limited", "bad_gateway"]);
export const MAX_ATTEMPTS = 2;
export const MAX_RECOMMENDATIONS = 3;
export const MAX_EVENTS_PER_RUN = 250;
export const MAX_EVIDENCE_FACTS = 20;
export const MOCK_OBSERVED_AT = "2026-08-14T14:00:00.000Z";
export const MOCK_FRESH_UNTIL = "2026-08-21T14:00:00.000Z";

const REQUEST_FIELDS = new Set([
  "schema_version",
  "problem_statement",
  "asset_hint",
  "container_hint",
  "purpose",
  "time_window",
  "media_context",
]);
const TIME_WINDOW_FIELDS = new Set(["start", "end"]);
const MEDIA_FIELDS = new Set(["show_or_campaign", "asset_type"]);
const PLAN_FIELDS = new Set([
  "schema_version",
  "workflow",
  "asset_query",
  "container_query",
  "purpose",
  "time_window",
  "required_evidence",
  "clarification",
]);
const DRAFT_FIELDS = new Set([
  "schema_version",
  "headline",
  "summary",
  "summary_evidence_ids",
  "risks",
  "recommendations",
  "cited_evidence_ids",
]);

export class ContractError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.field = field;
  }
}

export class ProviderError extends Error {
  constructor(kind, message, { retryable = false, status = undefined } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Cancellation requested");
    this.name = "CancellationError";
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, allowed, scope) {
  if (!isPlainObject(value)) {
    throw new ContractError("INVALID_OBJECT", `${scope} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractError("UNKNOWN_FIELD", `${scope} contains unknown field: ${key}`, key);
    }
  }
}

export function normalizeText(value, field, { min = 0, max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ContractError("REQUIRED_FIELD", `${field} is required`, field);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ContractError("INVALID_TYPE", `${field} must be a string`, field);
  }
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (normalized.length < min) throw new ContractError("TOO_SHORT", `${field} is too short`, field);
  if (normalized.length > max) throw new ContractError("TOO_LONG", `${field} exceeds ${max} characters`, field);
  return normalized;
}

function parseIso(value, field) {
  const text = normalizeText(value, field, { min: 1, max: 40, required: true });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ContractError("INVALID_TIME", `${field} must be a UTC ISO-8601 timestamp`, field);
  }
  return new Date(text).toISOString();
}

function parseTimeWindow(value) {
  if (value === undefined) return undefined;
  rejectUnknown(value, TIME_WINDOW_FIELDS, "time_window");
  const start = parseIso(value.start, "time_window.start");
  const end = parseIso(value.end, "time_window.end");
  const span = Date.parse(end) - Date.parse(start);
  if (!(span > 0)) throw new ContractError("INVALID_TIME_WINDOW", "time_window.start must be before end", "time_window");
  if (span > 366 * 24 * 60 * 60 * 1000) throw new ContractError("TIME_WINDOW_TOO_LARGE", "time_window cannot exceed 366 days", "time_window");
  return { start, end };
}

function parseMediaContext(value) {
  if (value === undefined) return undefined;
  rejectUnknown(value, MEDIA_FIELDS, "media_context");
  const result = {};
  if (value.show_or_campaign !== undefined) result.show_or_campaign = normalizeText(value.show_or_campaign, "media_context.show_or_campaign", { max: 200 });
  if (value.asset_type !== undefined) result.asset_type = normalizeText(value.asset_type, "media_context.asset_type", { max: 200 });
  if (Object.keys(result).length === 0) throw new ContractError("EMPTY_OBJECT", "media_context must contain a supported hint", "media_context");
  return result;
}

/** @typedef {{start: string, end: string}} TimeWindow */
/** @typedef {{show_or_campaign?: string, asset_type?: string}} MediaContext */
/** @typedef {{schema_version: "run-request@1", problem_statement: string, asset_hint?: string, container_hint?: string, purpose?: string, time_window?: TimeWindow, media_context?: MediaContext}} RunRequest */

/**
 * Validate the only client-controlled run contract. Server authority fields intentionally do not appear here.
 * @param {unknown} value
 * @returns {RunRequest}
 */
export function parseRunRequest(value) {
  rejectUnknown(value, REQUEST_FIELDS, "run request");
  if (value.schema_version !== REQUEST_SCHEMA) {
    throw new ContractError("INVALID_SCHEMA_VERSION", `schema_version must be ${REQUEST_SCHEMA}`, "schema_version");
  }
  const request = {
    schema_version: REQUEST_SCHEMA,
    problem_statement: normalizeText(value.problem_statement, "problem_statement", { min: 1, max: 8000, required: true }),
  };
  if (value.asset_hint !== undefined) request.asset_hint = normalizeText(value.asset_hint, "asset_hint", { max: 200 });
  if (value.container_hint !== undefined) request.container_hint = normalizeText(value.container_hint, "container_hint", { max: 200 });
  if (value.purpose !== undefined) request.purpose = normalizeText(value.purpose, "purpose", { max: 120 });
  const timeWindow = parseTimeWindow(value.time_window);
  if (timeWindow) request.time_window = timeWindow;
  const mediaContext = parseMediaContext(value.media_context);
  if (mediaContext) request.media_context = mediaContext;
  return request;
}

export function parseIdempotencyKey(value) {
  if (typeof value !== "string") throw new ContractError("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
  const key = value.normalize("NFKC").trim();
  if (key.length < 1 || key.length > 128 || /[\u0000-\u001F\u007F]/.test(key)) {
    throw new ContractError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1 to 128 safe characters");
  }
  return key;
}

export function hashValue(value) {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function safeId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function safeSourceLink(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.port) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function containsUnsafeText(value) {
  if (typeof value !== "string") return false;
  return /<\/?[a-z][^>]*>|javascript\s*:|data\s*:|(?:https?|ftp):\/\/|www\./i.test(value) || /(?:bearer|api[_ -]?key|secret|password)\s*[:=]/i.test(value);
}

export function redactText(value, max = 1200) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "[redacted]")
    .replace(/(api[_ -]?key|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, max);
}

export function assertRunState(state) {
  if (!RUN_STATES.includes(state)) throw new ContractError("INVALID_RUN_STATE", `Unknown run state: ${state}`);
}

/** @typedef {{schema_version: "readiness-plan@1", workflow: string, asset_query?: string, container_query?: string, purpose?: string, time_window?: TimeWindow, required_evidence: string[], clarification: null|object}} ReadinessPlan */
export function validatePlan(value) {
  rejectUnknown(value, PLAN_FIELDS, "readiness plan");
  if (value.schema_version !== PLAN_SCHEMA || value.workflow !== WORKFLOW) throw new ContractError("INVALID_PLAN_SCOPE", "Plan schema or workflow is not server-approved");
  if (!Array.isArray(value.required_evidence) || value.required_evidence.length !== REQUIRED_EVIDENCE.length || value.required_evidence.some((item, index) => item !== REQUIRED_EVIDENCE[index])) {
    throw new ContractError("INVALID_PLAN_EVIDENCE", "Plan must request the fixed evidence classes");
  }
  if (value.asset_query !== undefined) normalizeText(value.asset_query, "asset_query", { max: 200 });
  if (value.container_query !== undefined) normalizeText(value.container_query, "container_query", { max: 200 });
  if (value.purpose !== undefined) normalizeText(value.purpose, "purpose", { max: 120 });
  return value;
}

export function validateDraft(value) {
  rejectUnknown(value, DRAFT_FIELDS, "brief draft");
  if (value.schema_version !== DRAFT_SCHEMA) throw new ContractError("INVALID_DRAFT_SCHEMA", `Draft schema must be ${DRAFT_SCHEMA}`);
  for (const field of ["headline", "summary"]) normalizeText(value[field], field, { min: 1, max: field === "headline" ? 180 : 1200, required: true });
  if (!Array.isArray(value.summary_evidence_ids)) throw new ContractError("INVALID_DRAFT_EVIDENCE", "summary_evidence_ids must be an array");
  if (!Array.isArray(value.cited_evidence_ids)) throw new ContractError("INVALID_DRAFT_EVIDENCE", "cited_evidence_ids must be an array");
  if (!Array.isArray(value.risks) || value.risks.length > 5) throw new ContractError("INVALID_DRAFT_RISKS", "risks must contain at most five items");
  for (const risk of value.risks) {
    rejectUnknown(risk, new Set(["severity", "kind", "text", "evidence_ids"]), "risk");
    if (!["low", "medium", "high"].includes(risk.severity)) throw new ContractError("INVALID_RISK", "risk severity is invalid");
    normalizeText(risk.kind, "risk.kind", { min: 1, max: 80, required: true });
    normalizeText(risk.text, "risk.text", { min: 1, max: 600, required: true });
    if (!Array.isArray(risk.evidence_ids)) throw new ContractError("INVALID_RISK_EVIDENCE", "risk evidence_ids must be an array");
  }
  if (!Array.isArray(value.recommendations) || value.recommendations.length > MAX_RECOMMENDATIONS) throw new ContractError("INVALID_RECOMMENDATIONS", "recommendations must contain at most three items");
  for (const recommendation of value.recommendations) normalizeText(recommendation, "recommendation", { min: 1, max: 300, required: true });
  for (const id of [...value.summary_evidence_ids, ...value.cited_evidence_ids]) {
    if (typeof id !== "string" || id.length > 160) throw new ContractError("INVALID_EVIDENCE_ID", "evidence IDs must be bounded strings");
  }
  return value;
}

export function nowIso(clock = Date) {
  return new clock().toISOString();
}

export function publicStatus(state, decision) {
  if (state === "needs_input") return "NEEDS_INPUT";
  if (decision && DECISIONS.includes(decision)) return decision;
  if (state === "failed" || state === "expired" || state === "canceled") return "RECOVERY";
  return "RUNNING";
}