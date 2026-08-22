import { containsUnsafeText, redactText, stableStringify } from "./contracts.js";

/**
 * Server-owned Gemini safety policy. Browser requests and model output never
 * participate in selecting these values.
 */
export const GEMINI_SAFETY_SETTINGS = Object.freeze([
  Object.freeze({ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }),
  Object.freeze({ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" }),
  Object.freeze({ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }),
  Object.freeze({ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }),
]);

export const GEMINI_SAFETY_POLICY = Object.freeze({
  request_timeout_ms: 12_000,
  run_deadline_ms: 90_000,
  max_calls_per_run: 2,
  max_repairs_per_run: 1,
  max_input_chars: 32_000,
  max_output_chars: 12_000,
  max_output_tokens: 768,
  max_request_bytes: 256 * 1024,
  rate_limit_per_minute: 60,
  rate_limit_key_capacity: 1_000,
  text: Object.freeze({ max_chars: 32_000 }),
  multimodal: Object.freeze({ max_parts: 4, max_bytes: 2 * 1024 * 1024, allowed_media_types: Object.freeze(["image/jpeg", "image/png", "image/webp"]) }),
});

export const SAFETY_ERROR_CODES = Object.freeze([
  "semantic_invalid",
  "schema_invalid",
  "call_budget_exceeded",
  "rate_limit",
  "request_too_large",
  "deadline_exceeded",
  "safety_blocked",
]);

const SENSITIVE_KEY = /token|secret|password|credential|authorization|cookie|api[_ -]?key|private[_ -]?key|bearer/i;
const RAW_KEY = /^(?:prompt|response|raw|content|reasoning|source|transcript|body|question|problem|excerpt|text|private|document|row)(?:_|$)/i;

function safeString(value, maxStringLength) {
  let result = String(value);
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "[redacted]");
  result = result.replace(/(?:api[_ -]?key|secret|password|token|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  result = result.replace(/(?:https?|ftp):\/\/[^\s"']+/gi, "[redacted-url]");
  result = result.replace(/<\/?[a-z][^>]*>/gi, "[redacted-markup]");
  result = redactText(result, maxStringLength);
  return result.slice(0, maxStringLength);
}

/** Deterministically redact structured values before they enter an audit sink. */
export function redactForAudit(value, { maxStringLength = 240, depth = 0 } = {}) {
  if (depth > 3) return "[bounded]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeString(value, maxStringLength);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactForAudit(item, { maxStringLength, depth: depth + 1 }));
  if (typeof value !== "object") return undefined;
  const result = {};
  for (const key of Object.keys(value).sort().slice(0, 30)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (RAW_KEY.test(key) && !/^(?:prompt_id|prompt_hash|source_id|source_label)$/i.test(key)) {
      result[key] = "[omitted]";
      continue;
    }
    result[key] = redactForAudit(value[key], { maxStringLength, depth: depth + 1 });
  }
  return result;
}

export function requestByteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : stableStringify(value), "utf8");
}

export function assertRequestWithinLimits(value, { maxBytes = GEMINI_SAFETY_POLICY.max_request_bytes } = {}) {
  const bytes = requestByteLength(value);
  if (bytes > maxBytes) {
    const error = new Error("Model request exceeded the configured safety limit");
    error.code = "request_too_large";
    error.kind = "request_too_large";
    error.retryable = false;
    throw error;
  }
  return bytes;
}

export function assertMultimodalInput(parts, { policy = GEMINI_SAFETY_POLICY.multimodal } = {}) {
  if (!Array.isArray(parts) || parts.length > policy.max_parts) {
    const error = new Error("Multimodal input exceeded the configured safety limit");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  for (const part of parts) {
    if (!part || typeof part !== "object" || typeof part.media_type !== "string" || !policy.allowed_media_types.includes(part.media_type)) {
      const error = new Error("Multimodal input contains an unsupported media part");
      error.code = "semantic_invalid";
      throw error;
    }
    if (typeof part.data !== "string") {
      const error = new Error("Multimodal input must use bounded encoded data");
      error.code = "semantic_invalid";
      throw error;
    }
    bytes += Buffer.byteLength(part.data, "base64");
    if (bytes > policy.max_bytes) {
      const error = new Error("Multimodal input exceeded the configured safety limit");
      error.code = "request_too_large";
      throw error;
    }
  }
  return true;
}

export class RateLimiter {
  constructor({ limit = GEMINI_SAFETY_POLICY.rate_limit_per_minute, windowMs = 60_000, maxKeys = GEMINI_SAFETY_POLICY.rate_limit_key_capacity, clock = Date } = {}) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.windowMs = Math.max(1_000, Math.trunc(windowMs));
    this.maxKeys = Math.max(1, Math.trunc(maxKeys));
    this.clock = clock;
    this.windows = new Map();
  }

  allow(key = "unscoped") {
    const currentTime = new this.clock();
    const now = currentTime.getTime();
    const safeKey = String(key).slice(0, 160) || "unscoped";
    let window = this.windows.get(safeKey);
    if (!window || now - window.startedAt >= this.windowMs) window = { startedAt: now, count: 0 };
    window.count += 1;
    this.windows.set(safeKey, window);
    if (this.windows.size > this.maxKeys) {
      const oldest = [...this.windows.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt)[0]?.[0];
      if (oldest) this.windows.delete(oldest);
    }
    return window.count <= this.limit;
  }
}

export function safeErrorProjection(error) {
  const code = SAFETY_ERROR_CODES.includes(error?.code) ? error.code : "model_request_failed";
  const messages = {
    semantic_invalid: "The model proposal was rejected by the safety boundary.",
    schema_invalid: "The model proposal did not match the approved contract.",
    call_budget_exceeded: "The model call budget was exhausted.",
    rate_limit: "The model request rate limit was reached.",
    request_too_large: "The model request exceeded the configured size limit.",
    deadline_exceeded: "The model request exceeded its deadline.",
    safety_blocked: "The model provider blocked the request under the configured safety policy.",
    model_request_failed: "The model request could not be completed safely.",
  };
  return { code, message: messages[code], retryable: Boolean(error?.retryable), status: Number.isInteger(error?.status) ? error.status : undefined };
}

export function isSafetyBlock(error) {
  return SAFETY_ERROR_CODES.includes(error?.code) || containsUnsafeText(error?.message || "");
}
