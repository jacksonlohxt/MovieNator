import { createHash } from "node:crypto";
import { ModelGateway } from "./model-gateway.js";
import { GROUNDED_BRIEF_SCHEMA, SCRIPT_BRIEF_SCHEMA, SCRIPT_BRIEF_PROMPT_ID } from "./grounding-contracts.js";
import {
  GEMINI_SAFETY_POLICY,
  GEMINI_SAFETY_SETTINGS,
  RateLimiter,
  assertRequestWithinLimits,
  isSafetyBlock,
  safeErrorProjection,
} from "./safety.js";
import { SCRIPT_BRIEF_SYSTEM_PROMPT, validateGroundedBriefProposal, validateScriptBriefProposal } from "./grounding.js";
import { PRODUCT_DISPLAY_NAME, PRODUCT_IDENTIFIER } from "./product-identity.js";
import {
  DRAFT_SCHEMA,
  PLAN_SCHEMA,
  REQUIRED_EVIDENCE,
  WORKFLOW,
  containsUnsafeText,
  hashValue,
  isPlainObject,
  stableStringify,
  validateDraft,
  validatePlan,
} from "./contracts.js";

export const GEMINI_READINESS_STATES = Object.freeze([
  "disabled",
  "not_set",
  "not_run",
  "passed",
  "failed",
  "unknown",
]);

export const GEMINI_ERROR_CODES = Object.freeze([
  "missing_configuration",
  "not_ready",
  "auth_denied",
  "timeout",
  "rate_limit",
  "server_failure",
  "malformed_response",
  "schema_invalid",
  "semantic_invalid",
  "canceled",
  "call_budget_exceeded",
  "request_too_large",
  "deadline_exceeded",
]);

const DEFAULTS = Object.freeze({
  modelBackend: "fake",
  apiVersion: "v1",
  publisher: "google",
  timeoutMs: GEMINI_SAFETY_POLICY.request_timeout_ms,
  maxCallsPerRun: GEMINI_SAFETY_POLICY.max_calls_per_run,
  maxRepairsPerRun: GEMINI_SAFETY_POLICY.max_repairs_per_run,
  maxInputChars: GEMINI_SAFETY_POLICY.max_input_chars,
  maxOutputChars: GEMINI_SAFETY_POLICY.max_output_chars,
  maxOutputTokens: GEMINI_SAFETY_POLICY.max_output_tokens,
  maxRequestBytes: GEMINI_SAFETY_POLICY.max_request_bytes,
  rateLimitPerMinute: GEMINI_SAFETY_POLICY.rate_limit_per_minute,
  temperature: 0,
});

export class GeminiRestError extends Error {
  constructor(code, message, { status, retryable = false, cause } = {}) {
    super(message);
    this.name = "GeminiRestError";
    this.code = code;
    this.kind = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function boundedFloat(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function validReadiness(value) {
  return GEMINI_READINESS_STATES.includes(value) ? value : "unknown";
}

function missingFields(config) {
  return ["projectId", "location", "modelId", "authMode"].filter((field) => !asText(config[field]).trim());
}

/** Read server environment only. Browser payloads are never merged into this object. */
export function readGeminiConfig(env = process.env) {
  const enabled = env.GOOGLE_GEMINI_ENABLED === "true";
  const config = {
    enabled,
    modelBackend: asText(env.MODEL_BACKEND).trim() || DEFAULTS.modelBackend,
    projectId: asText(env.GOOGLE_PROJECT_ID).trim() || undefined,
    location: asText(env.GOOGLE_LOCATION).trim() || undefined,
    modelId: asText(env.GOOGLE_MODEL_ID).trim() || undefined,
    publisher: asText(env.GOOGLE_PUBLISHER).trim() || DEFAULTS.publisher,
    endpoint: asText(env.GOOGLE_ENDPOINT).trim() || undefined,
    apiVersion: asText(env.GOOGLE_REST_API_VERSION).trim() || DEFAULTS.apiVersion,
    sdkVersion: asText(env.GOOGLE_SDK_VERSION).trim() || undefined,
    authMode: asText(env.GOOGLE_AUTH_MODE).trim() || undefined,
    timeoutMs: boundedNumber(env.GOOGLE_TIMEOUT_MS, DEFAULTS.timeoutMs, 100, 120_000),
    maxCallsPerRun: boundedNumber(env.GOOGLE_MAX_CALLS_PER_RUN, DEFAULTS.maxCallsPerRun, 1, 2),
    maxRepairsPerRun: boundedNumber(env.GOOGLE_MAX_REPAIRS_PER_RUN, DEFAULTS.maxRepairsPerRun, 0, 1),
    maxInputChars: boundedNumber(env.GOOGLE_MAX_INPUT_CHARS, DEFAULTS.maxInputChars, 100, 32_000),
    maxOutputChars: boundedNumber(env.GOOGLE_MAX_OUTPUT_CHARS, DEFAULTS.maxOutputChars, 100, 12_000),
    maxOutputTokens: boundedNumber(env.GOOGLE_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens, 64, 2_048),
    maxRequestBytes: boundedNumber(env.GOOGLE_MAX_REQUEST_BYTES, DEFAULTS.maxRequestBytes, 4_096, 256 * 1024),
    rateLimitPerMinute: boundedNumber(env.GOOGLE_RATE_LIMIT_PER_MINUTE, DEFAULTS.rateLimitPerMinute, 1, 600),
    temperature: boundedFloat(env.GOOGLE_TEMPERATURE, DEFAULTS.temperature, 0, 1),
  };
  const missing = missingFields(config);
  const configured = missing.length === 0;
  let readiness = "disabled";
  if (enabled) readiness = configured ? validReadiness(env.GOOGLE_GEMINI_READINESS || "not_run") : "not_set";
  return Object.freeze({ ...config, configured, missing, readiness });
}

export function normalizeGeminiConfig(input = {}) {
  const config = {
    ...DEFAULTS,
    ...(isPlainObject(input) ? input : {}),
  };
  config.enabled = config.enabled === true;
  const requestedModelBackend = isPlainObject(input) && Object.hasOwn(input, "modelBackend") ? input.modelBackend : undefined;
  config.modelBackend = asText(requestedModelBackend).trim() || (config.enabled ? "google_rest" : DEFAULTS.modelBackend);
  config.projectId = asText(config.projectId).trim() || undefined;
  config.location = asText(config.location).trim() || undefined;
  config.modelId = asText(config.modelId).trim() || undefined;
  config.publisher = asText(config.publisher).trim() || DEFAULTS.publisher;
  config.apiVersion = asText(config.apiVersion).trim() || DEFAULTS.apiVersion;
  config.authMode = asText(config.authMode).trim() || undefined;
  config.endpoint = asText(config.endpoint).trim() || undefined;
  config.sdkVersion = asText(config.sdkVersion).trim() || undefined;
  config.timeoutMs = boundedNumber(config.timeoutMs, DEFAULTS.timeoutMs, 100, 120_000);
  config.maxCallsPerRun = boundedNumber(config.maxCallsPerRun, DEFAULTS.maxCallsPerRun, 1, 2);
  config.maxRepairsPerRun = boundedNumber(config.maxRepairsPerRun, DEFAULTS.maxRepairsPerRun, 0, 1);
  config.maxInputChars = boundedNumber(config.maxInputChars, DEFAULTS.maxInputChars, 100, 32_000);
  config.maxOutputChars = boundedNumber(config.maxOutputChars, DEFAULTS.maxOutputChars, 100, 12_000);
  config.maxOutputTokens = boundedNumber(config.maxOutputTokens, DEFAULTS.maxOutputTokens, 64, 2_048);
  config.maxRequestBytes = boundedNumber(config.maxRequestBytes, DEFAULTS.maxRequestBytes, 4_096, 256 * 1024);
  config.rateLimitPerMinute = boundedNumber(config.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute, 1, 600);
  config.temperature = boundedFloat(config.temperature, DEFAULTS.temperature, 0, 1);
  config.missing = missingFields(config);
  config.configured = config.missing.length === 0;
  config.readiness = config.enabled ? (config.configured ? validReadiness(config.readiness || "not_run") : "not_set") : "disabled";
  return Object.freeze(config);
}

export function googleServiceEndpoint(config) {
  const normalized = normalizeGeminiConfig(config);
  if (!normalized.location || !/^[a-z0-9-]+$/i.test(normalized.location)) return undefined;
  if (normalized.endpoint) {
    try {
      const endpoint = new URL(normalized.endpoint);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !/(^|[.-])aiplatform\.googleapis\.com$/i.test(endpoint.hostname)) return undefined;
      return endpoint.origin;
    } catch {
      return undefined;
    }
  }
  if (normalized.location.toLowerCase() === "global") return "https://aiplatform.googleapis.com";
  return `https://${normalized.location}-aiplatform.googleapis.com`;
}

/** Build the path from server configuration. No request value participates. */
export function buildGenerateContentUrl(config) {
  const normalized = normalizeGeminiConfig(config);
  const endpoint = googleServiceEndpoint(normalized);
  if (!endpoint || !normalized.projectId || !normalized.modelId) return undefined;
  return `${endpoint}/${normalized.apiVersion}/projects/${encodeURIComponent(normalized.projectId)}/locations/${encodeURIComponent(normalized.location)}/publishers/${encodeURIComponent(normalized.publisher)}/models/${encodeURIComponent(normalized.modelId)}:generateContent`;
}

async function defaultTransport({ url, method, headers, body, signal }) {
  const response = await fetch(url, { method, headers, body, signal });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
}

async function defaultTokenProvider() {
  throw new GeminiRestError("auth_denied", "Google authentication is not configured for this server");
}

function providerToken(provider) {
  if (typeof provider === "function") return provider;
  if (provider && typeof provider.getToken === "function") return provider.getToken.bind(provider);
  return defaultTokenProvider;
}

function safeToken(value) {
  if (typeof value === "string") return value.trim();
  if (isPlainObject(value)) return asText(value.token || value.access_token).trim();
  return "";
}

function responseBody(response) {
  if (typeof response === "string") return response;
  if (response && typeof response.body === "string") return response.body;
  if (response && isPlainObject(response.body)) return JSON.stringify(response.body);
  return "";
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 200;
}

function mapHttpError(status) {
  if (status === 401 || status === 403) return new GeminiRestError("auth_denied", "Google authorization was denied", { status });
  if (status === 408 || status === 504) return new GeminiRestError("timeout", "Google model request timed out", { status, retryable: true });
  if (status === 429) return new GeminiRestError("rate_limit", "Google model rate limit reached", { status, retryable: true });
  if (status >= 500) return new GeminiRestError("server_failure", "Google model service failed", { status, retryable: true });
  return new GeminiRestError("server_failure", "Google model request was rejected", { status });
}

function extractCandidateText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new GeminiRestError("malformed_response", "Google response did not contain content parts");
  if (parts.some((part) => part && part.functionCall)) throw new GeminiRestError("semantic_invalid", "Google response requested an unsupported tool call");
  const text = parts.filter((part) => typeof part?.text === "string").map((part) => part.text).join("").trim();
  if (!text) throw new GeminiRestError("malformed_response", "Google response did not contain JSON text");
  return text;
}

function parseResponse(response, maxOutputChars) {
  const status = responseStatus(response);
  if (status < 200 || status >= 300) throw mapHttpError(status);
  let payload;
  try {
    payload = JSON.parse(responseBody(response));
  } catch (error) {
    throw new GeminiRestError("malformed_response", "Google response was not valid JSON", { cause: error });
  }
  let text;
  try {
    text = extractCandidateText(payload);
  } catch (error) {
    if (error instanceof GeminiRestError) throw error;
    throw new GeminiRestError("malformed_response", "Google response content was malformed", { cause: error });
  }
  if (text.length > maxOutputChars) throw new GeminiRestError("schema_invalid", "Google model output exceeded the configured limit");
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    throw new GeminiRestError("malformed_response", "Google model content was not valid JSON", { cause: error });
  }
}

function safePromptObject(value) {
  if (!isPlainObject(value)) return {};
  return value;
}

function boundedPrompt(value, max) {
  const text = typeof value === "string" ? value : stableStringify(value);
  if (text.length > max) throw new GeminiRestError("semantic_invalid", "Model input exceeded the configured limit");
  return text;
}

function assertTextSafe(value) {
  const serialized = JSON.stringify(value);
  if (containsUnsafeText(serialized) || /\b(?:publish|submit|purchase|deploy|mutate|export|execute|approve|delete)\b/i.test(serialized)) throw new GeminiRestError("semantic_invalid", "Model output contained unsafe or side-effect content");
}

function validatePlanOutput(value) {
  try {
    validatePlan(value);
  } catch (error) {
    throw new GeminiRestError("schema_invalid", "Google model plan did not match the approved schema", { cause: error });
  }
  if (value.clarification !== null) {
    if (!isPlainObject(value.clarification) || Object.keys(value.clarification).some((key) => !["question", "candidates"].includes(key))) throw new GeminiRestError("semantic_invalid", "Google model clarification exceeded the approved scope");
    if (typeof value.clarification.question !== "string" || value.clarification.question.length > 600) throw new GeminiRestError("semantic_invalid", "Google model clarification was not bounded");
  }
  return value;
}

function validateDraftOutput(value) {
  try {
    validateDraft(value);
  } catch (error) {
    throw new GeminiRestError("schema_invalid", "Google model draft did not match the approved schema", { cause: error });
  }
  assertTextSafe(value);
  return value;
}

function validateGroundedBriefOutput(value, knownCitationIds) {
  try {
    if (value?.schema_version === SCRIPT_BRIEF_SCHEMA) validateScriptBriefProposal(value, new Set(knownCitationIds));
    else validateGroundedBriefProposal(value, new Set(knownCitationIds));
  } catch (error) {
    throw new GeminiRestError("schema_invalid", "Google model Script Brief did not match the approved schema", { cause: error });
  }
  assertTextSafe(value);
  return value;
}

function hashPrompt(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class GeminiRestBackend extends ModelGateway {
  constructor({ config, transport = defaultTransport, tokenProvider, clock = Date, audit } = {}) {
    super();
    this.config = normalizeGeminiConfig(config);
    this.transport = transport;
    this.tokenProvider = providerToken(tokenProvider);
    this.clock = clock;
    this.audit = audit;
    this.rateLimiter = new RateLimiter({ limit: this.config.rateLimitPerMinute, maxKeys: GEMINI_SAFETY_POLICY.rate_limit_key_capacity, clock });
    this.metricsByRun = new Map();
    this.lastProvenance = null;
  }

  readiness() {
    return { state: this.config.readiness, configured: this.config.configured, missing: [...this.config.missing] };
  }

  provenance() {
    return this.lastProvenance || {
      backend: "google_rest",
      model_id: this.config.modelId || null,
      location: this.config.location || null,
      api_version: this.config.apiVersion,
      prompt_id: null,
      prompt_hash: null,
      schema_version: null,
      schema_hash: null,
      generation_config_hash: hashValue({ maxOutputTokens: this.config.maxOutputTokens, temperature: this.config.temperature, safetySettings: GEMINI_SAFETY_SETTINGS, maxRequestBytes: this.config.maxRequestBytes }),
      metrics: { call_count: 0, repair_count: 0, latency_ms: 0, input_chars: 0, output_chars: 0, response_hash: null, error_class: null },
    };
  }

  #budget(runId, repair, rateLimitKey) {
    const key = runId || "unscoped";
    if (!this.rateLimiter.allow(rateLimitKey || key)) throw new GeminiRestError("rate_limit", "Google model request rate limit reached", { retryable: true });
    const metrics = this.metricsByRun.get(key) || { callCount: 0, repairCount: 0 };
    if (metrics.callCount >= this.config.maxCallsPerRun) throw new GeminiRestError("call_budget_exceeded", "Google model call budget was exceeded");
    if (repair && metrics.repairCount >= this.config.maxRepairsPerRun) throw new GeminiRestError("call_budget_exceeded", "Google model repair budget was exceeded");
    metrics.callCount += 1;
    if (repair) metrics.repairCount += 1;
    this.metricsByRun.set(key, metrics);
    return metrics;
  }

  #recordFailure(error, stage, runId) {
    const safe = safeErrorProjection(error);
    this.audit?.record({
      type: isSafetyBlock(error) ? "safety_block" : "operator_failure",
      outcome: isSafetyBlock(error) ? "blocked" : "failed",
      mode: "google_rest",
      runId,
      code: safe.code,
      provenance: this.provenance(),
      attributes: { stage, retryable: safe.retryable, status: safe.status },
    });
  }

  #assertReady(signal, context = {}) {
    if (signal?.aborted) throw new GeminiRestError("canceled", "Google model request was canceled");
    if (context.deadline_at && Date.parse(context.deadline_at) <= Date.now()) throw new GeminiRestError("deadline_exceeded", "Google model request exceeded its deadline", { retryable: true });
    if (!this.config.enabled || this.config.readiness === "disabled") throw new GeminiRestError("missing_configuration", "Google model backend is disabled");
    if (!this.config.configured) throw new GeminiRestError("missing_configuration", "Google model configuration is incomplete");
    if (this.config.readiness !== "passed") throw new GeminiRestError("not_ready", "Google model readiness has not passed");
    const url = buildGenerateContentUrl(this.config);
    if (!url) throw new GeminiRestError("missing_configuration", "Google model endpoint configuration is invalid");
    return url;
  }

  #requestFor(stage, input) {
    const isPlan = stage === "planner";
    const isGroundedBrief = stage === "grounded_brief";
    const isScriptBrief = isGroundedBrief && input?.schema_version === SCRIPT_BRIEF_SCHEMA;
    const schemaVersion = isPlan ? PLAN_SCHEMA : isGroundedBrief ? (isScriptBrief ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA) : DRAFT_SCHEMA;
    const safeInput = isPlan
      ? {
          schema_version: input?.schema_version,
          problem_statement: input?.problem_statement,
          asset_hint: input?.asset_hint,
          container_hint: input?.container_hint,
          purpose: input?.purpose,
          time_window: input?.time_window,
          media_context: input?.media_context,
        }
      : isGroundedBrief
        ? {
            schema_version: schemaVersion,
            ...(isScriptBrief ? { request_intent: input?.request_intent, source_coverage: safePromptObject(input?.source_coverage), source_chunk_count: input?.source_chunk_count } : { question: input?.question }),
            excerpts: Array.isArray(input?.excerpts) ? input.excerpts.slice(0, 24).map((excerpt) => ({ citation_id: excerpt?.citation_id, text: excerpt?.text, source_locations: excerpt?.source_locations, source_ordinal: excerpt?.source_ordinal })) : [],
          }
        : {
            schema_version: schemaVersion,
            policy_decision: safePromptObject(input?.policy_decision),
            evidence_bundle: safePromptObject(input?.evidence_bundle),
          };
    const prompt = boundedPrompt(safeInput, this.config.maxInputChars);
    const systemInstruction = isPlan
      ? `You are the bounded Request Interpreter. Return exactly one JSON object with only these keys: schema_version, workflow, asset_query, container_query, purpose, time_window, required_evidence, clarification. Use schema_version="${PLAN_SCHEMA}", workflow="audience_data_readiness", required_evidence=["asset","quality","governance","lineage"], and clarification=null unless the request is genuinely missing required information. Use time_window only as an object with start and end strings. Never return readiness_question, asset_hints, or any other key. Never select a provider, tool, endpoint, project, location, model, threshold, credential, or side effect.`
      : isGroundedBrief
        ? (isScriptBrief ? `${SCRIPT_BRIEF_SYSTEM_PROMPT} Use schema_version="${SCRIPT_BRIEF_SCHEMA}" and do not add fields.` : `You are the bounded ${PRODUCT_DISPLAY_NAME} Script Grounding Writer. Return exactly one JSON object with only these keys: schema_version, title, summary, key_points, cited_citation_ids. Use schema_version="${GROUNDED_BRIEF_SCHEMA}". Use only the supplied excerpts. Every key point must cite one or more supplied citation_id values. Never invent a source, citation, filmmaker claim, provider, tool, endpoint, model, threshold, credential, or side effect. Video, audio, image, music, and VFX generation are not available.`)
        : `You are the bounded Brief Writer. Return exactly one JSON object with only these keys: schema_version, headline, summary, summary_evidence_ids, risks, recommendations, cited_evidence_ids. Use schema_version="${DRAFT_SCHEMA}". Each risk must contain only severity (low, medium, or high), kind, text, and evidence_ids. Cite only supplied evidence IDs. Never change policy, select providers or tools, create evidence, or request a side effect.`;
    return {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxOutputTokens,
        responseMimeType: "application/json",
      },
      safetySettings: GEMINI_SAFETY_SETTINGS.map((setting) => ({ ...setting })),
    };
  }

  async #generate(stage, input, context = {}) {
    let url;
    let metrics;
    let request;
    try {
      url = this.#assertReady(context.signal, context);
      const repair = context.repair === true;
      metrics = this.#budget(context.run_id, repair, context.rate_limit_key);
      request = this.#requestFor(stage, input);
      assertRequestWithinLimits(request, { maxBytes: this.config.maxRequestBytes });
    } catch (error) {
      const mapped = error instanceof GeminiRestError ? error : new GeminiRestError(error.code || "server_failure", error.message || "Google model request failed", { retryable: false, cause: error });
      this.#recordFailure(mapped, stage, context.run_id);
      throw mapped;
    }
    const promptText = stableStringify(request.contents);
    const schemaHash = hashValue(stage === "planner" ? PLAN_SCHEMA : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA) : DRAFT_SCHEMA);
    const started = new this.clock();
    let response;
    try {
      let tokenValue;
      try {
        tokenValue = await this.tokenProvider({ scope: "https://www.googleapis.com/auth/cloud-platform", signal: context.signal });
      } catch (error) {
        if (context.signal?.aborted) throw new GeminiRestError("canceled", "Google model request was canceled");
        if (error instanceof GeminiRestError) throw error;
        throw new GeminiRestError("auth_denied", "Google authentication was unavailable");
      }
      const token = safeToken(tokenValue);
      if (!token) throw new GeminiRestError("auth_denied", "Google authentication did not return an access token");
      const remainingMs = context.deadline_at ? Date.parse(context.deadline_at) - Date.now() : this.config.timeoutMs;
      if (remainingMs <= 0) throw new GeminiRestError("deadline_exceeded", "Google model request exceeded its deadline", { retryable: true });
      const controller = new AbortController();
      let timedOut = false;
      const abortParent = () => controller.abort();
      if (context.signal) {
        if (context.signal.aborted) throw new GeminiRestError("canceled", "Google model request was canceled");
        context.signal.addEventListener("abort", abortParent, { once: true });
      }
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(this.config.timeoutMs, remainingMs));
      try {
        response = await this.transport({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        if (context.signal?.aborted) throw new GeminiRestError("canceled", "Google model request was canceled", { cause: error });
        if (timedOut || error?.name === "AbortError") throw new GeminiRestError("timeout", "Google model request timed out", { retryable: true, cause: error });
        throw new GeminiRestError("server_failure", "Google model transport failed", { retryable: true, cause: error });
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abortParent);
      }
      const parsed = parseResponse(response, this.config.maxOutputChars);
      const knownCitationIds = stage === "grounded_brief" ? (input?.excerpts || []).map((excerpt) => excerpt?.citation_id).filter(Boolean) : [];
      const value = stage === "planner" ? validatePlanOutput(parsed.value) : stage === "grounded_brief" ? validateGroundedBriefOutput(parsed.value, knownCitationIds) : validateDraftOutput(parsed.value);
      const elapsed = Math.max(0, new this.clock() - started);
      this.lastProvenance = {
        backend: "google_rest",
        model_id: this.config.modelId,
        location: this.config.location,
        api_version: this.config.apiVersion,
        prompt_id: stage === "planner" ? "request-interpreter@1" : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_PROMPT_ID : `${PRODUCT_IDENTIFIER}-script-grounding@1`) : "brief-writer@1",
        prompt_hash: hashPrompt(promptText),
        schema_version: stage === "planner" ? PLAN_SCHEMA : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA) : DRAFT_SCHEMA,
        schema_hash: `sha256:${schemaHash}`,
        generation_config_hash: `sha256:${hashValue({ ...request.generationConfig, safetySettings: GEMINI_SAFETY_SETTINGS, maxRequestBytes: this.config.maxRequestBytes })}`,
        metrics: {
          call_count: Math.min(metrics.callCount, this.config.maxCallsPerRun),
          repair_count: Math.min(metrics.repairCount, this.config.maxRepairsPerRun),
          latency_ms: Math.min(elapsed, this.config.timeoutMs),
          input_chars: Math.min(promptText.length, this.config.maxInputChars),
          output_chars: Math.min(parsed.text.length, this.config.maxOutputChars),
          response_hash: `sha256:${hashValue(parsed.text)}`,
          error_class: null,
        },
      };
      return value;
    } catch (error) {
      const mapped = error instanceof GeminiRestError ? error : new GeminiRestError("server_failure", "Google model request failed", { retryable: true, cause: error });
      const elapsed = Math.max(0, new this.clock() - started);
      const key = context.run_id || "unscoped";
      const metricsNow = this.metricsByRun.get(key) || { callCount: 0, repairCount: 0 };
      this.lastProvenance = {
        backend: "google_rest",
        model_id: this.config.modelId || null,
        location: this.config.location || null,
        api_version: this.config.apiVersion,
        prompt_id: stage === "planner" ? "request-interpreter@1" : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_PROMPT_ID : `${PRODUCT_IDENTIFIER}-script-grounding@1`) : "brief-writer@1",
        prompt_hash: null,
        schema_version: stage === "planner" ? PLAN_SCHEMA : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA) : DRAFT_SCHEMA,
        schema_hash: `sha256:${hashValue(stage === "planner" ? PLAN_SCHEMA : stage === "grounded_brief" ? (input?.schema_version === SCRIPT_BRIEF_SCHEMA ? SCRIPT_BRIEF_SCHEMA : GROUNDED_BRIEF_SCHEMA) : DRAFT_SCHEMA)}`,
        generation_config_hash: `sha256:${hashValue({ maxOutputTokens: this.config.maxOutputTokens, temperature: this.config.temperature, safetySettings: GEMINI_SAFETY_SETTINGS, maxRequestBytes: this.config.maxRequestBytes })}`,
        metrics: { call_count: Math.min(metricsNow.callCount, this.config.maxCallsPerRun), repair_count: Math.min(metricsNow.repairCount, this.config.maxRepairsPerRun), latency_ms: Math.min(elapsed, this.config.timeoutMs), input_chars: 0, output_chars: 0, response_hash: null, error_class: mapped.code },
      };
      this.#recordFailure(mapped, stage, context.run_id);
      throw mapped;
    }
  }

  async plan(request, context = {}) {
    return this.#generate("planner", request, context);
  }

  async draft(input, context = {}) {
    return this.#generate("writer", input, context);
  }

  async groundedBrief(input, context = {}) {
    return this.#generate("grounded_brief", input, context);
  }

  async write(planOrInput, evidenceBundleOrContext = {}, policyDecision, context) {
    if (policyDecision !== undefined) {
      return this.draft({ plan: planOrInput, evidence_bundle: evidenceBundleOrContext, policy_decision: policyDecision }, context || {});
    }
    return this.draft(planOrInput, evidenceBundleOrContext);
  }
}

export function isGeminiReady(config) {
  const normalized = normalizeGeminiConfig(config);
  return normalized.modelBackend === "google_rest" && normalized.enabled && normalized.configured && normalized.readiness === "passed";
}
