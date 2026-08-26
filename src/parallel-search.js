import Parallel, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "parallel-web";
import { PRODUCER_PACKET_SCHEMA } from "./producer-consolidation.js";
import { hashValue, stableStringify } from "./contracts.js";

// Bounded, credential-gated Parallel Search seam. This module never presents a Parallel finding as a
// legal conclusion, an approval, a booking, or a verified fact: every row it produces is labelled
// `externally_researched_fact` / `externally_researched_not_verified` and cites the exact Parallel
// result URL, matching MovieInator's existing evidence-state model (docs/prd.md section 5). The feature
// is OFF by default; it only activates when `PARALLEL_API_KEY` is configured (see readParallelConfig).

export const PARALLEL_SEARCH_MODES = Object.freeze(["turbo", "fast", "basic", "advanced"]);
export const PARALLEL_ERROR_CODES = Object.freeze([
  "missing_configuration",
  "auth_denied",
  "timeout",
  "rate_limit",
  "server_failure",
  "malformed_response",
  "canceled",
]);
export const PARALLEL_EXTERNAL_CLASSIFICATION = "externally_researched_fact";
export const PARALLEL_EXTERNAL_EVIDENCE_STATE = "externally_researched_not_verified";
export const PARALLEL_EXTERNAL_CITATION_MEDIA_TYPE = "text/html";
export const PARALLEL_EXTERNAL_SOURCE_KIND = "external_research";
export const PARALLEL_PROVIDER_ID = "parallel-web";

const MAX_TOPICS_DEFAULT = 2;
const MAX_RESULTS_PER_TOPIC_DEFAULT = 3;
const MAX_QUERIES_PER_TOPIC = 3;
const MAX_OBJECTIVE_CHARS = 600;
const MAX_EXCERPT_CHARS = 900;
const MAX_TITLE_CHARS = 180;

export class ParallelSearchError extends Error {
  constructor(code, message, { status, retryable = false, cause } = {}) {
    super(message);
    this.name = "ParallelSearchError";
    this.code = PARALLEL_ERROR_CODES.includes(code) ? code : "server_failure";
    this.status = Number.isInteger(status) ? status : null;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function boundedText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Read only process-owned Parallel configuration. The raw API key is intentionally never included in
 * the returned object so it cannot leak into audit records or provenance; callers that need to
 * construct a live client must read `env.PARALLEL_API_KEY` (or resolve a secret reference) separately,
 * mirroring the boundary already used for other credentials in `src/secrets.js`.
 */
export function readParallelConfig(env = process.env) {
  const configured = text(env.PARALLEL_API_KEY).length > 0;
  const explicitDisable = text(env.PARALLEL_ENABLED).toLowerCase() === "false";
  const enabled = configured && !explicitDisable;
  const mode = PARALLEL_SEARCH_MODES.includes(text(env.PARALLEL_SEARCH_MODE)) ? text(env.PARALLEL_SEARCH_MODE) : "advanced";
  return Object.freeze({
    schema_version: "parallel-search-config@1",
    enabled,
    configured,
    mode,
    timeoutMs: boundedNumber(env.PARALLEL_TIMEOUT_MS, 8_000, 1_000, 30_000),
    maxTopics: boundedNumber(env.PARALLEL_MAX_TOPICS, MAX_TOPICS_DEFAULT, 1, 4),
    maxResultsPerTopic: boundedNumber(env.PARALLEL_MAX_RESULTS_PER_TOPIC, MAX_RESULTS_PER_TOPIC_DEFAULT, 1, 5),
  });
}

/** Read the raw API key. Kept separate from readParallelConfig so the config object above stays safe
 * to log or embed in provenance/audit records without ever carrying a credential value. */
export function readParallelApiKey(env = process.env) {
  return text(env.PARALLEL_API_KEY) || undefined;
}

function mapParallelSdkError(error, { signal } = {}) {
  if (error instanceof ParallelSearchError) return error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  // A caller-supplied signal aborting is an explicit cancellation, never a Parallel service failure. An
  // `APIUserAbortError` with no caller-signal abort came from the SDK's own request timeout instead.
  if (signal?.aborted) return new ParallelSearchError("canceled", "Parallel Search request was canceled", { retryable: false, cause: error });
  if (error instanceof APIUserAbortError) return new ParallelSearchError("timeout", "Parallel Search request timed out", { retryable: true, cause: error });
  if (error instanceof APIConnectionTimeoutError) return new ParallelSearchError("timeout", "Parallel Search request timed out", { retryable: true, status, cause: error });
  if (error instanceof APIConnectionError) return new ParallelSearchError("server_failure", "Parallel Search transport failed", { retryable: true, status, cause: error });
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError || status === 401 || status === 403) return new ParallelSearchError("auth_denied", "Parallel Search authorization was denied", { status, cause: error });
  if (error instanceof RateLimitError || status === 429) return new ParallelSearchError("rate_limit", "Parallel Search rate limit reached", { retryable: true, status, cause: error });
  if (typeof status === "number" && status >= 500) return new ParallelSearchError("server_failure", "Parallel Search service failed", { retryable: true, status, cause: error });
  return new ParallelSearchError("server_failure", "Parallel Search request failed", { retryable: true, status, cause: error });
}

function normalizeQueries(queries) {
  const list = Array.isArray(queries) ? queries : [];
  const bounded = list.map((query) => boundedText(query, 80)).filter(Boolean).slice(0, MAX_QUERIES_PER_TOPIC);
  if (!bounded.length) throw new ParallelSearchError("malformed_response", "Parallel Search requires at least one keyword query");
  return bounded;
}

function normalizeSearchResponse(response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  return {
    searchId: typeof response?.search_id === "string" ? response.search_id : null,
    results: results.map((result) => ({
      url: typeof result?.url === "string" ? result.url : "",
      title: typeof result?.title === "string" ? result.title : "",
      excerpts: Array.isArray(result?.excerpts) ? result.excerpts.filter((excerpt) => typeof excerpt === "string") : [],
    })),
  };
}

/**
 * Thin, injectable wrapper around the real `parallel-web` SDK. Production code always imports and
 * constructs the real `Parallel` client (`new Parallel({ apiKey })`) and calls `client.search(...)`.
 * Tests inject `client` (any object exposing an async `search(body, options)` method) so the enrichment
 * path is exercised end to end with zero live network calls.
 */
export class ParallelSearchClient {
  constructor({ config, client, apiKey, clock = Date } = {}) {
    this.config = config || readParallelConfig();
    this.injectedClient = client;
    this.apiKey = apiKey;
    this.clock = clock;
    this.realClient = null;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  #resolveClient() {
    if (this.injectedClient) return this.injectedClient;
    if (!this.apiKey) throw new ParallelSearchError("missing_configuration", "Parallel Search API key is not configured");
    if (!this.realClient) this.realClient = new Parallel({ apiKey: this.apiKey, timeout: this.config.timeoutMs });
    return this.realClient;
  }

  async search({ objective, searchQueries, mode, signal } = {}) {
    if (!this.isEnabled()) throw new ParallelSearchError("missing_configuration", "Parallel Search is not enabled");
    const boundedObjective = boundedText(objective, MAX_OBJECTIVE_CHARS);
    const queries = normalizeQueries(searchQueries);
    const client = this.#resolveClient();
    try {
      const response = await client.search(
        { objective: boundedObjective || undefined, search_queries: queries, mode: PARALLEL_SEARCH_MODES.includes(mode) ? mode : this.config.mode },
        { signal, timeout: this.config.timeoutMs },
      );
      return normalizeSearchResponse(response);
    } catch (error) {
      throw mapParallelSdkError(error, { signal });
    }
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function locationLabelFromPacket(packet) {
  const scene = packet.scene_index?.[0];
  const label = firstNonEmpty(scene?.setting, scene?.scene_heading, scene?.scene_reference);
  return label ? boundedText(label, 120) : undefined;
}

function hasMinorCastDemand(packet) {
  return (packet.cast_role_demands || []).some((item) => /\bminors?\b|\bchild(?:ren)?\b|\bkid\b|\bteen(?:ager)?s?\b/i.test(item.text || item.value || ""));
}

function hasStuntElement(packet) {
  return (packet.production_elements || []).some((item) => item.category === "stunts");
}

function hasBudgetInput(packet) {
  return (packet.budget_inputs || []).length > 0;
}

// Priority-ordered, deterministic topic detectors. Each topic is a bounded, real-world research
// question genuinely relevant to production planning (permit lead time, union minor/stunt rules, and
// vendor day-rate ranges), matching the PRD's evidence-routing model: Parallel findings are additive
// cited evidence, never an authority that resolves a conflict or approves anything.
const PARALLEL_EVIDENCE_TOPICS = Object.freeze([
  {
    topic: "location_permit",
    detect: (packet) => Boolean(locationLabelFromPacket(packet)),
    buildRequest: (packet) => {
      const location = locationLabelFromPacket(packet);
      return {
        objective: `Research real-world film production permit lead times and jurisdiction requirements for a scene described in the script as: ${location}. The uploaded bundle does not establish a confirmed permit status; find general guidance on typical lead time and the filing process.`,
        searchQueries: ["film location permit lead time", "location filming permit requirements", "film shoot permit application process"],
      };
    },
  },
  {
    topic: "minor_labor_rules",
    detect: (packet) => hasMinorCastDemand(packet),
    buildRequest: () => ({
      objective: "Research SAG-AFTRA and applicable state child labor rules for minors working on a film or TV production, including work-hour limits and required on-set supervision, because the supplied cast or role demands reference a minor.",
      searchQueries: ["SAG-AFTRA minor performer rules", "child actor work hour limits", "film set minor labor law"],
    }),
  },
  {
    topic: "stunt_turnaround",
    detect: (packet) => hasStuntElement(packet),
    buildRequest: () => ({
      objective: "Research SAG-AFTRA and IATSE stunt safety and shoot-day turnaround time rules for a film production involving a stunt or physical-action element identified in the script.",
      searchQueries: ["SAG-AFTRA stunt safety rules", "IATSE crew turnaround time rules", "film stunt coordinator requirements"],
    }),
  },
  {
    topic: "vendor_day_rate",
    detect: (packet) => hasBudgetInput(packet),
    buildRequest: () => ({
      objective: "Research typical vendor and day-rate ranges for independent film production location access, equipment rental, or crew day rates in the United States, to help evaluate a supplied budget figure.",
      searchQueries: ["film location access day rate", "independent film crew day rate", "production vendor rate ranges"],
    }),
  },
]);

/** Deterministically select and build up to `maxTopics` Parallel Search requests relevant to a packet.
 * Selection order is fixed (never random) so the same bundle always produces the same requests. */
export function buildParallelEnrichmentRequests(packet, { maxTopics = MAX_TOPICS_DEFAULT } = {}) {
  const requests = [];
  for (const definition of PARALLEL_EVIDENCE_TOPICS) {
    if (requests.length >= maxTopics) break;
    if (!definition.detect(packet)) continue;
    const request = definition.buildRequest(packet);
    requests.push({ topic: definition.topic, objective: boundedText(request.objective, MAX_OBJECTIVE_CHARS), searchQueries: request.searchQueries.slice(0, MAX_QUERIES_PER_TOPIC) });
  }
  return requests;
}

function safeResultUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Map one Parallel Search response for one topic into cited, clearly-labelled canonical evidence rows
 * plus citation records. Nothing here is ever upgraded past `externally_researched_fact`. */
export function mapParallelResultsToEvidence({ topic, objective, searchQueries, response, maxResultsPerTopic = MAX_RESULTS_PER_TOPIC_DEFAULT }) {
  const evidenceItems = [];
  const citations = [];
  for (const result of (response?.results || []).slice(0, maxResultsPerTopic)) {
    const url = safeResultUrl(result.url);
    if (!url) continue;
    const title = boundedText(result.title || url, MAX_TITLE_CHARS);
    const excerpt = boundedText((result.excerpts || []).join(" ").trim() || "Parallel did not return an excerpt for this result.", MAX_EXCERPT_CHARS);
    const citationId = `pcite_ext_${hashValue(stableStringify({ topic, url })).slice(0, 32)}`;
    citations.push({
      schema_version: "producer-citation@1",
      citation_id: citationId,
      source_id: "external-research",
      document_id: `external:${url}`,
      filename: title,
      media_type: PARALLEL_EXTERNAL_CITATION_MEDIA_TYPE,
      source_kind: PARALLEL_EXTERNAL_SOURCE_KIND,
      source_label: "External research (Parallel Search)",
      source_locations: [{ kind: "url", section: url }],
      excerpt,
    });
    evidenceItems.push({
      element_id: `extev_${hashValue(stableStringify({ topic, url })).slice(0, 32)}`,
      category: "external_evidence",
      field: topic,
      value: boundedText(`${title} — ${excerpt}`, 700),
      text: boundedText(`${title} — ${excerpt}`, 700),
      classification: PARALLEL_EXTERNAL_CLASSIFICATION,
      evidence_state: PARALLEL_EXTERNAL_EVIDENCE_STATE,
      department: null,
      source_ids: [],
      citation_ids: [citationId],
      next_action: "Route to the responsible producer or department lead to independently verify this externally researched finding before relying on it.",
      provenance: { provider: PARALLEL_PROVIDER_ID, query_objective: objective, search_queries: searchQueries, url, title },
      limitations: [
        "This finding was retrieved from an external web search (Parallel) and is not verified against the user's own uploaded sources.",
        "This is not a legal conclusion, an approval, a booking, or a safety clearance.",
      ],
    });
  }
  return { evidenceItems, citations };
}

function unavailableEvidenceRow(topic, error) {
  const reasonId = `extev_unavailable_${hashValue(stableStringify({ topic, code: error.code })).slice(0, 32)}`;
  return {
    element_id: reasonId,
    category: "external_evidence",
    field: topic,
    value: boundedText(`External research for "${topic.replaceAll("_", " ")}" is unavailable (${error.code}). Verify this topic manually.`, 700),
    text: boundedText(`External research for "${topic.replaceAll("_", " ")}" is unavailable (${error.code}). Verify this topic manually.`, 700),
    classification: "open_question",
    evidence_state: "unavailable",
    department: null,
    source_ids: [],
    citation_ids: [],
    next_action: "Route to the responsible producer or department lead for manual research; the automated external research call did not complete.",
    provenance: { provider: PARALLEL_PROVIDER_ID, error_class: error.code },
    limitations: ["No provider fallback was used; this row only records that the external research attempt did not complete."],
  };
}

/**
 * Enrich an already-built strict Producer Intake Decision Packet (`producer-intake-decision-packet@1`)
 * with bounded, cited, externally-researched evidence rows. This function is read-only and additive: it
 * never mutates a fact, conflict, or decision the deterministic pipeline already established, and it
 * never runs at all for the legacy compatibility packet contract or when Parallel is not configured.
 * A Parallel failure degrades to a single `unavailable` evidence row rather than failing the whole
 * packet build, matching the fail-closed, human-routed posture used elsewhere in this contract.
 */
export async function enrichProducerPacketWithParallelEvidence(packet, { client, config, signal } = {}) {
  if (!packet || packet.schema_version !== PRODUCER_PACKET_SCHEMA) return packet;
  const resolvedConfig = config || client?.config || readParallelConfig();
  if (!resolvedConfig.enabled) {
    return {
      ...packet,
      external_evidence: packet.external_evidence || [],
      provenance: { ...packet.provenance, external_evidence_enabled: false, external_evidence_provider: null },
    };
  }
  const searchClient = client instanceof ParallelSearchClient ? client : new ParallelSearchClient({ config: resolvedConfig, client });
  const requests = buildParallelEnrichmentRequests(packet, { maxTopics: resolvedConfig.maxTopics });
  const evidenceItems = [];
  const newCitations = [];
  for (const request of requests) {
    try {
      const response = await searchClient.search({ objective: request.objective, searchQueries: request.searchQueries, signal });
      const mapped = mapParallelResultsToEvidence({ ...request, response, maxResultsPerTopic: resolvedConfig.maxResultsPerTopic });
      evidenceItems.push(...mapped.evidenceItems);
      newCitations.push(...mapped.citations);
    } catch (error) {
      const mapped = error instanceof ParallelSearchError ? error : mapParallelSdkError(error, { signal });
      evidenceItems.push(unavailableEvidenceRow(request.topic, mapped));
    }
  }
  const citationIds = newCitations.map((citation) => citation.citation_id);
  return {
    ...packet,
    external_evidence: evidenceItems,
    citations: [...(packet.citations || []), ...newCitations],
    cited_citation_ids: [...new Set([...(packet.cited_citation_ids || []), ...citationIds])],
    provenance: { ...packet.provenance, external_evidence_enabled: true, external_evidence_provider: PARALLEL_PROVIDER_ID },
    limitations: [
      ...(packet.limitations || []),
      "External evidence rows are researched by Parallel Search, not the user's own uploaded sources; verify each one before relying on it.",
    ].slice(0, 8),
  };
}

/** Compose a producer packet builder that runs the deterministic bundle builder and then, when
 * configured, the Parallel enrichment step above. This is the default builder wired into
 * `ProducerPacketEngine` by `createApp`; a caller may still fully override it via `producerBuilder`. */
export function createParallelEnrichedProducerBuilder({ baseBuilder, parallelClient, parallelConfig } = {}) {
  return async function build(sources, options) {
    const packet = baseBuilder(sources, options);
    return enrichProducerPacketWithParallelEvidence(packet, { client: parallelClient, config: parallelConfig });
  };
}
