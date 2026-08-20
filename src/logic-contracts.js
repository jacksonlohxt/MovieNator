import crypto from "node:crypto";

export const WORKFLOW_STATE_SCHEMA = "workflow-state@1";
export const BRANCH_SCHEMA = "workflow-branch@1";
export const CHECKPOINT_SCHEMA = "workflow-checkpoint@1";
export const LEASE_SCHEMA = "workflow-lease@1";
export const TERMINAL_OUTCOME_SCHEMA = "terminal-outcome@1";
export const TOOL_MANIFEST_SCHEMA = "tool-manifest@1";
export const TOOL_CALL_PROPOSAL_SCHEMA = "tool-call-proposal@1";
export const TOOL_EXECUTION_RESULT_SCHEMA = "tool-execution-result@1";

export const WORKFLOW_BRANCH_STATES = Object.freeze(["pending", "running", "succeeded", "failed", "timed_out", "canceled", "skipped"]);
export const CHECKPOINT_KINDS = Object.freeze(["accepted", "plan", "resolution", "branch", "policy", "composition", "validation", "terminal"]);
export const TERMINAL_OUTCOMES = Object.freeze(["succeeded", "needs_input", "failed", "canceled", "expired"]);
export const TOOL_OUTCOMES = Object.freeze(["succeeded", "unavailable", "rejected", "timed_out", "budget_exhausted", "canceled"]);

export class LogicContractError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = "LogicContractError";
    this.code = code;
    this.field = field;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rejectUnknownFields(value, allowed, scope) {
  if (!isRecord(value)) throw new LogicContractError("INVALID_OBJECT", `${scope} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new LogicContractError("UNKNOWN_FIELD", `${scope} contains unknown field: ${key}`, key);
  }
}

export function boundedString(value, field, { min = 0, max = 240, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new LogicContractError("REQUIRED_FIELD", `${field} is required`, field);
    return undefined;
  }
  if (typeof value !== "string") throw new LogicContractError("INVALID_TYPE", `${field} must be a string`, field);
  const result = value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (result.length < min) throw new LogicContractError("TOO_SHORT", `${field} is too short`, field);
  if (result.length > max) throw new LogicContractError("TOO_LONG", `${field} exceeds ${max} characters`, field);
  return result;
}

export function boundedInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new LogicContractError("REQUIRED_FIELD", `${field} is required`, field);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new LogicContractError("INVALID_INTEGER", `${field} must be an integer between ${min} and ${max}`, field);
  return value;
}

export function isoTimestamp(value, field, { required = false } = {}) {
  const text = boundedString(value, field, { min: 1, max: 40, required });
  if (text === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new LogicContractError("INVALID_TIME", `${field} must be a UTC ISO-8601 timestamp`, field);
  }
  return new Date(text).toISOString();
}

export function hashContract(value) {
  const serialized = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function safeClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const SENSITIVE_KEY = /token|secret|password|credential|api[_ -]?key|authorization|cookie|private[_ -]?row|raw[_ -]?payload/i;
const UNSAFE_TEXT = /<\/?[a-z][^>]*>|javascript\s*:|data\s*:|(?:https?|ftp):\/\/|www\.|(?:bearer|api[_ -]?key|secret|password|token)\s*[:=]/i;

export function containsSensitiveKey(value) {
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => SENSITIVE_KEY.test(key));
}

export function containsUnsafeValue(value, depth = 0) {
  if (depth > 5) return true;
  if (typeof value === "string") return UNSAFE_TEXT.test(value);
  if (Array.isArray(value)) return value.some((item) => containsUnsafeValue(item, depth + 1));
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => SENSITIVE_KEY.test(key) || containsUnsafeValue(item, depth + 1));
  return false;
}

export function redactValue(value, depth = 0) {
  if (depth > 3) return "[bounded]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "[redacted]")
      .replace(/(api[_ -]?key|secret|password|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .slice(0, 600);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (isRecord(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key] = redactValue(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

export function parseCheckpoint(value) {
  rejectUnknownFields(value, new Set(["schema_version", "checkpoint_id", "run_id", "kind", "phase", "sequence", "input_hash", "output_hash", "status", "created_at", "payload"]), "checkpoint");
  if (value.schema_version !== CHECKPOINT_SCHEMA) throw new LogicContractError("INVALID_SCHEMA_VERSION", `checkpoint schema must be ${CHECKPOINT_SCHEMA}`);
  const kind = boundedString(value.kind, "checkpoint.kind", { min: 1, max: 40, required: true });
  if (!CHECKPOINT_KINDS.includes(kind)) throw new LogicContractError("INVALID_CHECKPOINT_KIND", `Unknown checkpoint kind: ${kind}`);
  const status = boundedString(value.status, "checkpoint.status", { min: 1, max: 32, required: true });
  const checkpoint = {
    schema_version: CHECKPOINT_SCHEMA,
    checkpoint_id: boundedString(value.checkpoint_id, "checkpoint.checkpoint_id", { min: 1, max: 160, required: true }),
    run_id: boundedString(value.run_id, "checkpoint.run_id", { min: 1, max: 160, required: true }),
    kind,
    phase: boundedString(value.phase, "checkpoint.phase", { min: 1, max: 80, required: true }),
    sequence: boundedInteger(value.sequence, "checkpoint.sequence", { min: 1, max: 100000, required: true }),
    input_hash: boundedString(value.input_hash, "checkpoint.input_hash", { min: 1, max: 160, required: true }),
    output_hash: boundedString(value.output_hash, "checkpoint.output_hash", { min: 1, max: 160 }),
    status,
    created_at: isoTimestamp(value.created_at, "checkpoint.created_at", { required: true }),
    payload: redactValue(value.payload || {}),
  };
  if (containsSensitiveKey(checkpoint.payload) || containsUnsafeValue(checkpoint.payload)) throw new LogicContractError("UNSAFE_CHECKPOINT", "checkpoint payload is not safe to persist");
  return checkpoint;
}

export function parseLease(value) {
  if (value === null || value === undefined) return null;
  rejectUnknownFields(value, new Set(["schema_version", "lease_id", "owner_id", "acquired_at", "expires_at", "heartbeat_at"]), "lease");
  if (value.schema_version !== LEASE_SCHEMA) throw new LogicContractError("INVALID_SCHEMA_VERSION", `lease schema must be ${LEASE_SCHEMA}`);
  const lease = {
    schema_version: LEASE_SCHEMA,
    lease_id: boundedString(value.lease_id, "lease.lease_id", { min: 1, max: 160, required: true }),
    owner_id: boundedString(value.owner_id, "lease.owner_id", { min: 1, max: 160, required: true }),
    acquired_at: isoTimestamp(value.acquired_at, "lease.acquired_at", { required: true }),
    expires_at: isoTimestamp(value.expires_at, "lease.expires_at", { required: true }),
    heartbeat_at: isoTimestamp(value.heartbeat_at, "lease.heartbeat_at", { required: true }),
  };
  if (Date.parse(lease.expires_at) <= Date.parse(lease.acquired_at)) throw new LogicContractError("INVALID_LEASE", "lease must expire after acquisition");
  return lease;
}

export function parseTerminalOutcome(value) {
  if (value === null || value === undefined) return null;
  rejectUnknownFields(value, new Set(["schema_version", "outcome", "reason_code", "message", "at", "result_hash", "recoverable"]), "terminal outcome");
  if (value.schema_version !== TERMINAL_OUTCOME_SCHEMA) throw new LogicContractError("INVALID_SCHEMA_VERSION", `terminal outcome schema must be ${TERMINAL_OUTCOME_SCHEMA}`);
  const outcome = boundedString(value.outcome, "terminal outcome.outcome", { min: 1, max: 32, required: true });
  if (!TERMINAL_OUTCOMES.includes(outcome)) throw new LogicContractError("INVALID_TERMINAL_OUTCOME", `Unknown terminal outcome: ${outcome}`);
  return {
    schema_version: TERMINAL_OUTCOME_SCHEMA,
    outcome,
    reason_code: boundedString(value.reason_code, "terminal outcome.reason_code", { min: 1, max: 80, required: true }),
    message: boundedString(value.message, "terminal outcome.message", { min: 1, max: 300, required: true }),
    at: isoTimestamp(value.at, "terminal outcome.at", { required: true }),
    result_hash: boundedString(value.result_hash, "terminal outcome.result_hash", { max: 160 }),
    recoverable: Boolean(value.recoverable),
  };
}

export function validateWorkflowState(value) {
  rejectUnknownFields(value, new Set(["schema_version", "run_id", "state", "phase", "checkpoint_id", "branch_ids", "lease", "retry", "cancellation", "terminal_outcome", "updated_at"]), "workflow state");
  if (value.schema_version !== WORKFLOW_STATE_SCHEMA) throw new LogicContractError("INVALID_SCHEMA_VERSION", `workflow state schema must be ${WORKFLOW_STATE_SCHEMA}`);
  const state = boundedString(value.state, "workflow state.state", { min: 1, max: 64, required: true });
  const branchIds = Array.isArray(value.branch_ids) ? value.branch_ids.map((item) => boundedString(item, "workflow state.branch_ids", { min: 1, max: 100, required: true })) : [];
  if (!Array.isArray(value.branch_ids)) throw new LogicContractError("INVALID_TYPE", "workflow state.branch_ids must be an array");
  if (new Set(branchIds).size !== branchIds.length) throw new LogicContractError("DUPLICATE_BRANCH", "workflow state.branch_ids must be unique");
  if (!isRecord(value.retry)) throw new LogicContractError("INVALID_RETRY", "workflow state.retry must be an object");
  const retry = { attempt: boundedInteger(value.retry.attempt, "workflow state.retry.attempt", { min: 0, max: 100, required: true }), max_attempts: boundedInteger(value.retry.max_attempts, "workflow state.retry.max_attempts", { min: 1, max: 100, required: true }), last_error: redactValue(value.retry.last_error || null) };
  if (retry.attempt > retry.max_attempts) throw new LogicContractError("INVALID_RETRY", "retry attempt cannot exceed max_attempts");
  if (!isRecord(value.cancellation)) throw new LogicContractError("INVALID_CANCELLATION", "workflow state.cancellation must be an object");
  const cancellation = { requested: Boolean(value.cancellation.requested), requested_at: isoTimestamp(value.cancellation.requested_at, "workflow state.cancellation.requested_at"), confirmed_at: isoTimestamp(value.cancellation.confirmed_at, "workflow state.cancellation.confirmed_at") };
  return {
    schema_version: WORKFLOW_STATE_SCHEMA,
    run_id: boundedString(value.run_id, "workflow state.run_id", { min: 1, max: 160, required: true }),
    state,
    phase: boundedString(value.phase, "workflow state.phase", { min: 1, max: 80, required: true }),
    checkpoint_id: boundedString(value.checkpoint_id, "workflow state.checkpoint_id", { max: 160 }) || null,
    branch_ids: branchIds,
    lease: parseLease(value.lease),
    retry,
    cancellation,
    terminal_outcome: parseTerminalOutcome(value.terminal_outcome),
    updated_at: isoTimestamp(value.updated_at, "workflow state.updated_at", { required: true }),
  };
}

export function safeUnavailable(code, message, { retryable = true, tool_id = null, operation = null } = {}) {
  return {
    schema_version: TOOL_EXECUTION_RESULT_SCHEMA,
    status: "unavailable",
    outcome: code === "TOOL_TIMEOUT" ? "timed_out" : "unavailable",
    error: { code: String(code).slice(0, 80), message: String(message).slice(0, 240), retryable: Boolean(retryable) },
    tool_id,
    operation,
  };
}
