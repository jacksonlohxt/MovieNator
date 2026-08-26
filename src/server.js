import http from "node:http";
import { TextDecoder } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  hashValue,
  stableStringify,
  isPlainObject,
  parseIdempotencyKey,
  parseRunRequest,
  redactText,
} from "./contracts.js";
import {
  DocumentContractError,
  MAX_DOCUMENT_BYTES,
  parseGroundingDocument,
  safeCitationProjection,
  safeDocumentProjection,
  validateGroundingRequest,
} from "./documents.js";
import { GroundedBriefEngine, projectGroundedRun } from "./grounding-engine.js";
import { LocalDeterministicGroundingSource } from "./grounding.js";
import { MockEngine, MockProvider, FakeModel, projectRun } from "./engine.js";
import { GEMINI_READINESS_MAX_AGE_MS, GeminiRestBackend, createGeminiReadiness, isGeminiReadinessForConfig, isGeminiReady, normalizeGeminiConfig, readGeminiConfig } from "./gemini-rest.js";
import { createAdcTokenProvider } from "./google-auth.js";
import { createAuditRecorder } from "./audit.js";
import { createSecretProvider } from "./secrets.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { FileStore } from "./store.js";
import { createDefaultPartnerRegistry } from "./partner-defaults.js";
import { PartnerOperationRunner } from "./partner-runtime.js";
import { PartnerContractError } from "./partner-contracts.js";
import { createLocalMcpDatabase } from "./mcp-database.js";
import { createDefaultToolRegistry } from "./orchestrator.js";
import { LogicContractError } from "./logic-contracts.js";
import { createProducerAgentBoundary } from "./producer-agent-boundary.js";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.js";
import {
  MAX_PRODUCER_BUNDLE_BYTES,
  MAX_PRODUCER_MANIFEST_BYTES,
  MAX_PRODUCER_REVISIONS,
  MAX_PRODUCER_SOURCES,
  CANONICAL_PRODUCER_SOURCE_KINDS,
  PRODUCER_BUNDLE_SCHEMA,
  buildProducerDecisionPacket,
  parseProducerSource,
  producerBundleId,
  producerCitation,
  producerPacketId,
  safeProducerPacketProjection,
  validateProducerBundleSchema,
} from "./producer-consolidation.js";
import { ProducerPacketEngine, projectProducerRun } from "./producer-engine.js";
import { ParallelSearchClient, createParallelEnrichedProducerBuilder, readParallelApiKey, readParallelConfig } from "./parallel-search.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, "..", "web");
const MAX_BODY_BYTES = 128 * 1024;
const MAX_UPLOAD_BODY_BYTES = MAX_DOCUMENT_BYTES + 128 * 1024;
const MAX_PRODUCER_UPLOAD_BODY_BYTES = MAX_PRODUCER_BUNDLE_BYTES;
const TERMINAL = new Set(["needs_input", "succeeded", "canceled", "expired", "failed"]);
const SCRIPT_TERMINAL = new Set(["succeeded", "grounding_gap", "canceled", "failed"]);
const PARTNER_NOT_FOUND_CODES = new Set(["UNKNOWN_PROVIDER", "PARTNER_NOT_FOUND"]);
const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
});

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendError(res, status, code, message, field) {
  sendJson(res, status, { error: { code, message: redactText(message, 300), ...(field ? { field } : {}) } });
}

async function readRawBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw new ContractError("BODY_TOO_LARGE", "Request body is too large");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ContractError("BODY_TOO_LARGE", "Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipartParts(body, contentType) {
  const match = String(contentType || "").match(/boundary=(?:\"([^\"]+)\"|([^;]+))/i);
  if (!match) throw new DocumentContractError("INVALID_MULTIPART", "A multipart file upload is required", "file");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(boundary, offset);
    if (start < 0) break;
    const contentStart = start + boundary.length;
    if (body.subarray(contentStart, contentStart + 2).toString() === "--") break;
    const partStart = body.subarray(contentStart, contentStart + 2).toString() === "\r\n" ? contentStart + 2 : contentStart;
    const next = body.indexOf(boundary, partStart);
    if (next < 0) throw new DocumentContractError("INVALID_MULTIPART", "The multipart boundary is incomplete", "file");
    const part = body.subarray(partStart, Math.max(partStart, next - 2));
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) throw new DocumentContractError("INVALID_MULTIPART", "The file part headers are malformed", "file");
    const headers = part.subarray(0, headerEnd).toString("latin1");
    const content = part.subarray(headerEnd + 4);
    const disposition = headers.match(/content-disposition:\s*form-data/i);
    const name = headers.match(/\bname=\"([^\"]+)\"/i)?.[1];
    const filename = headers.match(/\bfilename=\"([^\"]*)\"/i)?.[1];
    if (!disposition || !name) throw new DocumentContractError("INVALID_MULTIPART", "The file part is malformed", "file");
    parts.push({ name, filename, contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream", content });
    offset = next;
  }
  if (!parts.length) throw new DocumentContractError("INVALID_MULTIPART", "The multipart upload did not contain any parts", "file");
  return parts;
}

function parseMultipart(body, contentType) {
  const parts = parseMultipartParts(body, contentType);
  const fileParts = parts.filter((part) => part.name === "file" && part.filename !== undefined);
  if (parts.length !== 1 || fileParts.length !== 1) throw new DocumentContractError("INVALID_MULTIPART", "Upload exactly one file field", "file");
  return fileParts[0];
}

function parseProducerMultipart(body, contentType) {
  const parts = parseMultipartParts(body, contentType);
  const allowed = new Set(["schema_version", "source_kind", "file"]);
  if (parts.some((part) => !allowed.has(part.name))) throw new DocumentContractError("UNKNOWN_FIELD", "Producer bundle contains an unknown multipart field", "bundle");
  const schemaParts = parts.filter((part) => part.name === "schema_version" && part.filename === undefined);
  const kindParts = parts.filter((part) => part.name === "source_kind" && part.filename === undefined);
  const files = parts.filter((part) => part.name === "file" && part.filename !== undefined);
  if (schemaParts.length !== 1 || files.length < 1 || files.length > MAX_PRODUCER_SOURCES || kindParts.length !== files.length) {
    throw new DocumentContractError("INVALID_BUNDLE", `Provide one schema_version, ${files.length || "one"} source_kind field${files.length === 1 ? "" : "s"}, and 1 to ${MAX_PRODUCER_SOURCES} file fields (parts: schema=${schemaParts.length}, kinds=${kindParts.length}, files=${files.length})`, "bundle");
  }
  validateProducerBundleSchema({ schema_version: schemaParts[0].content.toString("utf8").trim() });
  return files.map((file, index) => ({ ...file, source_kind: kindParts[index].content.toString("utf8").trim() }));
}

function safeManifestValue(value, field, max) {
  if (typeof value !== "string") throw new DocumentContractError("INVALID_MANIFEST", `${field} must be a string`, field);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001F\u007F]/.test(normalized)) throw new DocumentContractError("INVALID_MANIFEST", `${field} must be a bounded safe string`, field);
  return normalized;
}

function parseCanonicalManifest(parts) {
  if (parts.some((part) => !["manifest", "file"].includes(part.name))) throw new DocumentContractError("UNKNOWN_FIELD", "Producer source bundle contains an unknown multipart field", "bundle");
  const manifestParts = parts.filter((part) => part.name === "manifest" && part.filename === undefined);
  const files = parts.filter((part) => part.name === "file" && part.filename !== undefined);
  if (manifestParts.length !== 1 || files.length < 1 || files.length > MAX_PRODUCER_SOURCES) throw new DocumentContractError("INVALID_BUNDLE", `Provide one manifest and 1 to ${MAX_PRODUCER_SOURCES} files`, "manifest");
  if (manifestParts[0].content.length > MAX_PRODUCER_MANIFEST_BYTES) throw new DocumentContractError("MANIFEST_TOO_LARGE", "The source manifest must be at most 32 KiB", "manifest");
  let manifest;
  try {
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestParts[0].content);
    manifest = JSON.parse(manifestText);
  } catch {
    throw new DocumentContractError("INVALID_MANIFEST", "The source manifest must be valid UTF-8 JSON", "manifest");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new DocumentContractError("INVALID_MANIFEST", "The source manifest must be an object", "manifest");
  const allowedManifest = new Set(["schema_version", "sources"]);
  for (const key of Object.keys(manifest)) if (!allowedManifest.has(key)) throw new DocumentContractError("UNKNOWN_FIELD", `The source manifest contains an unknown field: ${key}`, key);
  if (manifest.schema_version !== PRODUCER_BUNDLE_SCHEMA || !Array.isArray(manifest.sources) || manifest.sources.length !== files.length) throw new DocumentContractError("INVALID_MANIFEST", "The manifest must contain one source entry for each uploaded file", "sources");
  const allowedEntry = new Set(["input_ref", "filename", "source_kind", "department", "version_label", "status_label", "relationships", "source_note"]);
  const refs = new Set();
  const entries = manifest.sources.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new DocumentContractError("INVALID_MANIFEST", "Each source manifest entry must be an object", `sources[${index}]`);
    for (const key of Object.keys(entry)) if (!allowedEntry.has(key)) throw new DocumentContractError("UNKNOWN_FIELD", `The source manifest contains an unknown source field: ${key}`, `sources[${index}].${key}`);
    const inputRef = safeManifestValue(entry.input_ref, `sources[${index}].input_ref`, 120);
    if (refs.has(inputRef)) throw new DocumentContractError("INVALID_MANIFEST", "Source input_ref values must be unique", "input_ref");
    refs.add(inputRef);
    if (!CANONICAL_PRODUCER_SOURCE_KINDS.includes(entry.source_kind)) throw new DocumentContractError("INVALID_SOURCE_KIND", "source_kind must use the Producer Intake allowlist", `sources[${index}].source_kind`);
    const result = { input_ref: inputRef, source_kind: entry.source_kind };
    for (const key of ["department", "version_label", "status_label", "source_note"]) if (entry[key] !== undefined) result[key] = safeManifestValue(entry[key], `sources[${index}].${key}`, key === "source_note" ? 240 : key === "department" ? 80 : 120);
    if (entry.filename !== undefined) result.filename = safeManifestValue(entry.filename, `sources[${index}].filename`, 120);
    if (entry.relationships !== undefined) {
      if (!Array.isArray(entry.relationships) || entry.relationships.length > 4) throw new DocumentContractError("INVALID_SOURCE_RELATIONSHIP", "Each source may have at most four relationships", `sources[${index}].relationships`);
      result.relationships = entry.relationships.map((relationship, relationshipIndex) => {
        if (!relationship || typeof relationship !== "object" || Array.isArray(relationship)) throw new DocumentContractError("INVALID_SOURCE_RELATIONSHIP", "A source relationship must be an object", `sources[${index}].relationships[${relationshipIndex}]`);
        const keys = Object.keys(relationship);
        if (keys.some((key) => !["type", "target_input_ref"].includes(key))) throw new DocumentContractError("UNKNOWN_FIELD", "A source relationship contains an unknown field", `sources[${index}].relationships[${relationshipIndex}]`);
        const type = safeManifestValue(relationship.type, "relationship.type", 30);
        if (!["revises", "supports", "derived_from", "references", "conflicts_with", "unknown"].includes(type)) throw new DocumentContractError("INVALID_SOURCE_RELATIONSHIP", "Source relationship type is not supported", "relationship.type");
        return { type, target_input_ref: safeManifestValue(relationship.target_input_ref, "relationship.target_input_ref", 120) };
      });
    } else result.relationships = [];
    return result;
  });
  const primaryCount = entries.filter((entry) => entry.source_kind === "primary_screenplay").length;
  if (primaryCount !== 1) throw new DocumentContractError("PRIMARY_SOURCE_REQUIRED", "Exactly one primary_screenplay source is required", "sources");
  if (entries.filter((entry) => entry.source_kind === "screenplay_revision").length > MAX_PRODUCER_REVISIONS) throw new DocumentContractError("BUNDLE_LIMIT_EXCEEDED", `At most ${MAX_PRODUCER_REVISIONS} screenplay_revision sources are accepted`, "sources");
  const byRef = new Set(entries.map((entry) => entry.input_ref));
  for (const entry of entries) for (const relationship of entry.relationships) {
    if (relationship.target_input_ref === entry.input_ref || !byRef.has(relationship.target_input_ref)) throw new DocumentContractError("INVALID_SOURCE_RELATIONSHIP", "Source relationships must target another manifest entry", "relationships");
  }
  const sourceParts = entries.map((entry, index) => {
    const file = entry.filename ? files.find((item) => item.filename === entry.filename) : files[index];
    if (!file) throw new DocumentContractError("INVALID_MANIFEST", `No uploaded file matches ${entry.filename}`, `sources[${index}].filename`);
    const source = parseProducerSource({ filename: entry.filename || file.filename, contentType: file.contentType, bytes: file.content, ...entry });
    return source;
  });
  return { manifest, sources: sourceParts };
}

async function readUpload(req) {
  const part = parseMultipart(await readRawBody(req, MAX_UPLOAD_BODY_BYTES), req.headers["content-type"]);
  return parseGroundingDocument({ filename: part.filename, contentType: part.contentType, bytes: part.content });
}

async function readProducerUpload(req) {
  const raw = await readRawBody(req, MAX_PRODUCER_UPLOAD_BODY_BYTES);
  const parts = parseMultipartParts(raw, req.headers["content-type"]);
  if (parts.some((part) => part.name === "manifest")) return { ...parseCanonicalManifest(parts), canonical: true };
  return { sources: parseProducerMultipart(raw, req.headers["content-type"]).map((part) => parseProducerSource({ filename: part.filename, contentType: part.contentType, bytes: part.content, source_kind: part.source_kind })), canonical: false };
}

async function readProducerBundle(req) {
  return (await readProducerUpload(req)).sources;
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ContractError("BODY_TOO_LARGE", "Request body is too large");
    chunks.push(chunk);
  }
  if (!bytes) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const body = JSON.parse(text);
    if (!isPlainObject(body)) throw new ContractError("INVALID_JSON", "Request body must be a JSON object");
    return body;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("INVALID_JSON", "Request body must be valid JSON");
  }
}

function requireEmpty(body) {
  if (Object.keys(body).length) throw new ContractError("UNKNOWN_FIELD", "This endpoint does not accept a request body field");
}

function requestHash(request) {
  return hashValue(request);
}

const GOOGLE_AUTH_MODES_REQUIRING_ADC = Object.freeze(["adc", "workload_identity", "attached_identity"]);
const GOOGLE_READINESS_REFRESH_MS = 4 * 60 * 1000;

/** Resolve the server-only Google token provider from an injected override or ADC. */
function resolveGoogleTokenProvider(config, tokenProvider) {
  return tokenProvider || (GOOGLE_AUTH_MODES_REQUIRING_ADC.includes(config.authMode) ? createAdcTokenProvider() : undefined);
}

export function createApp({ store, provider, model, dataPath, env = process.env, googleConfig, googleTransport, googleTokenProvider, googleReadiness, agentInteractionsTransport, agentGenaiClient, groundingSource, secretProvider, auditLogger, partnerRegistry, partnerRuntime, partnerConfig, partnerTransport, partnerTransportFactory, partnerReadiness, partnerEndpointAllowlist, database, toolRegistry, producerBuilder, parallelConfig, parallelClient } = {}) {
  const actualStore = store || new FileStore(dataPath);
  const audit = createAuditRecorder({ store: actualStore, logger: auditLogger });
  const actualProvider = provider || new MockProvider();
  const actualDatabase = database || createLocalMcpDatabase();
  const actualToolRegistry = toolRegistry || createDefaultToolRegistry({ database: actualDatabase });
  const configuredGoogle = normalizeGeminiConfig(googleConfig || readGeminiConfig(env));
  const actualTokenProvider = resolveGoogleTokenProvider(configuredGoogle, googleTokenProvider);
  const actualReadiness = isGeminiReadinessForConfig(googleReadiness, configuredGoogle) ? googleReadiness : createGeminiReadiness({ config: configuredGoogle, transport: googleTransport, tokenProvider: actualTokenProvider });
  const runtimeConfig = readRuntimeConfig(env, { googleConfig: configuredGoogle, googleReadiness: actualReadiness, partnerConfig });
  const actualSecretProvider = createSecretProvider({ env, provider: secretProvider, tokenProvider: actualTokenProvider, references: runtimeConfig.secretReferences.map(({ reference }) => reference) });
  audit.record({ type: "configuration_state", outcome: runtimeConfig.readiness, mode: runtimeConfig.mode, attributes: { target: runtimeConfig.target, google_intent: runtimeConfig.googleIntent, google_state: runtimeConfig.google.readiness, configured: runtimeConfig.google.configured, secret_reference_count: runtimeConfig.secretReferenceCount } });
  const googleReady = isGeminiReady(configuredGoogle, actualReadiness);
  const actualModel = model || (googleReady ? new GeminiRestBackend({ config: configuredGoogle, transport: googleTransport, tokenProvider: actualTokenProvider, readiness: actualReadiness, audit }) : new FakeModel());
  audit.record({ type: "model_provenance", outcome: "configured", mode: runtimeConfig.mode, provenance: typeof actualModel.provenance === "function" ? actualModel.provenance() : undefined, attributes: { backend: googleReady ? "google_rest" : "fake" } });
  audit.record({ type: "provider_provenance", outcome: "configured", mode: runtimeConfig.mode, provenance: actualProvider.capabilities?.(), attributes: { provider_id: actualProvider.manifest?.provider_id || "unknown", read_only: actualProvider.manifest?.read_only !== false } });
  const engine = new MockEngine({ store: actualStore, provider: actualProvider, model: actualModel, audit });
  const actualGroundingSource = groundingSource || new LocalDeterministicGroundingSource({ store: actualStore });
  const groundedEngine = new GroundedBriefEngine({ store: actualStore, groundingSource: actualGroundingSource, model: actualModel, audit });
  const configuredParallel = parallelConfig || readParallelConfig(env);
  const actualParallelClient = parallelClient || new ParallelSearchClient({ config: configuredParallel, apiKey: configuredParallel.configured ? readParallelApiKey(env) : undefined });
  audit.record({ type: "configuration_state", outcome: configuredParallel.enabled ? "ready" : "disabled", mode: "parallel_search", attributes: { configured: configuredParallel.configured, enabled: configuredParallel.enabled, mode: configuredParallel.mode } });
  const actualProducerBuilder = producerBuilder || createParallelEnrichedProducerBuilder({ baseBuilder: buildProducerDecisionPacket, parallelClient: actualParallelClient, parallelConfig: configuredParallel });
  const producerEngine = new ProducerPacketEngine({ store: actualStore, audit, builder: actualProducerBuilder });
  const actualPartnerRegistry = partnerRegistry || createDefaultPartnerRegistry({
    secretProvider: actualSecretProvider,
    partnerConfig: runtimeConfig.partner,
    transport: partnerTransport,
    transportFactory: partnerTransportFactory,
    readiness: partnerReadiness,
    endpointAllowlist: partnerEndpointAllowlist,
  });
  const actualPartnerRuntime = partnerRuntime || new PartnerOperationRunner({ registry: actualPartnerRegistry });
  const actualAgentBoundary = createProducerAgentBoundary({ store: actualStore, audit, env, runtimeConfig, googleConfig: configuredGoogle, googleReadiness: actualReadiness, interactionsTransport: agentInteractionsTransport, genaiClient: agentGenaiClient });
  engine.resumeActive();
  resumeActiveProducerRuns(actualStore, producerEngine);

  const server = http.createServer(async (req, res) => {
    const streaming = String(req.url || "").endsWith("/events");
    if (!streaming) req.setTimeout(runtimeConfig.requestTimeoutMs, () => {
      if (!res.headersSent) sendError(res, 504, "REQUEST_TIMEOUT", "The request exceeded the configured timeout");
      req.destroy();
    });
    try {
      await route(req, res, { store: actualStore, engine, groundedEngine, producerEngine, groundingSource: actualGroundingSource, googleConfig: configuredGoogle, googleReadiness: actualReadiness, runtimeConfig, audit, partnerRuntime: actualPartnerRuntime, database: actualDatabase, toolRegistry: actualToolRegistry, agentBoundary: actualAgentBoundary });
    } catch (error) {
      const notFound = ["RUN_NOT_FOUND", "DOCUMENT_NOT_FOUND", "SCRIPT_RUN_NOT_FOUND", "PRODUCER_PACKET_NOT_FOUND", "PRODUCER_BUNDLE_NOT_FOUND", ...PARTNER_NOT_FOUND_CODES].includes(error.code);
      const conflict = ["IDEMPOTENCY_KEY_REUSED", "RUN_NOT_RETRYABLE", "RUN_NOT_CLARIFIABLE", "INVALID_CANDIDATE", "SCRIPT_RUN_NOT_RETRYABLE", "PRODUCER_PACKET_NOT_RETRYABLE"].includes(error.code);
      const safeContractError = error instanceof ContractError || error instanceof DocumentContractError || error instanceof PartnerContractError || error instanceof LogicContractError;
      const status = notFound ? 404 : conflict ? 409 : safeContractError ? 400 : 500;
      if (!res.headersSent) sendError(res, status, error.code || "INTERNAL_ERROR", safeContractError ? error.message : `The ${PRODUCT_DISPLAY_NAME} server could not complete the request`, error.field);
      if (!safeContractError) audit.record({ type: "operator_failure", outcome: "failed", mode: runtimeConfig.mode, code: error.code || "internal_error", attributes: { route: req.url?.split("?")[0] } });
    }
  });
  server.requestTimeout = runtimeConfig.requestTimeoutMs;
  server.headersTimeout = Math.min(runtimeConfig.requestTimeoutMs, 30_000);
  server.keepAliveTimeout = Math.min(runtimeConfig.requestTimeoutMs, 10_000);
  return { server, store: actualStore, engine, groundedEngine, producerEngine, groundingSource: actualGroundingSource, provider: actualProvider, model: actualModel, googleConfig: configuredGoogle, googleReadiness: actualReadiness, runtimeConfig, secretProvider: actualSecretProvider, audit, partnerRegistry: actualPartnerRegistry, partnerRuntime: actualPartnerRuntime, database: actualDatabase, toolRegistry: actualToolRegistry, agentBoundary: actualAgentBoundary, parallelConfig: configuredParallel, parallelClient: actualParallelClient };
}

function resumeActiveProducerRuns(store, producerEngine) {
  for (const packetId of store.listActiveProducerRunIds()) producerEngine.enqueue(packetId);
}

async function route(req, res, { store, engine, groundedEngine, producerEngine, groundingSource, googleConfig, googleReadiness, runtimeConfig, audit, partnerRuntime, database, toolRegistry, agentBoundary }) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/readyz") {
    const google = engine.model?.readiness?.() || googleReadiness.readiness();
    const partners = partnerRuntime.projections();
    const activePartnersReady = partners.filter((partner) => partner.enabled).every((partner) => partner.readiness.state === "ready");
    const ready = (runtimeConfig.mode === "mock" || (google.state === "passed" && google.configured && google.checked && google.passed && !google.stale)) && activePartnersReady;
    return sendJson(res, ready ? 200 : 503, { ok: ready, mode: engine.model instanceof GeminiRestBackend ? "google_rest" : "mock-only", runtime_mode: runtimeConfig.mode, provider: "Demo evidence", partners, google: { state: google.state, configured: Boolean(google.configured), checked: Boolean(google.checked), passed: Boolean(google.passed), failed: Boolean(google.failed), stale: Boolean(google.stale), checked_at: google.checked_at || null, evidence: google.evidence || null, missing: google.missing || [] }, agent_runtime: agentBoundary.readiness(), model_backend: engine.provenance.model_backend.backend, config_state: runtimeConfig.readiness });
  }
  if (req.method === "GET" && url.pathname === "/") return sendStatic(res, "index.html", "text/html; charset=utf-8");
  if (req.method === "GET" && ["/app.js", "/session-state.js", "/styles.css"].includes(url.pathname)) return sendStatic(res, url.pathname.slice(1), url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "partners") return listPartners(res, partnerRuntime);
  if (parts[0] === "v1" && parts[1] === "partners" && parts.length >= 3) {
    const providerId = decodeURIComponent(parts[2]);
    if (req.method === "GET" && parts.length === 3) return getPartner(res, partnerRuntime, providerId);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "readiness") return getPartnerReadiness(res, partnerRuntime, providerId);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") return getPartnerEvents(res, partnerRuntime, providerId);
  }
  if (req.method === "GET" && url.pathname === "/v1/tools/readiness") return sendJson(res, 200, toolRegistry.readiness());
  if (req.method === "GET" && url.pathname === "/v1/tools") return sendJson(res, 200, toolRegistry.readiness());
  if (req.method === "GET" && url.pathname === "/v1/agent/readiness") return sendJson(res, 200, { ...agentBoundary.readiness(), contract: agentBoundary.contract() });
  if (req.method === "POST" && url.pathname === "/v1/agent/producer-intake") return invokeProducerAgent(req, res, agentBoundary, runtimeConfig.maxBodyBytes);
  if (req.method === "GET" && url.pathname === "/v1/logic/state") return sendJson(res, 200, { schema_version: "logic-host-state@1", mode: "local-mock", no_side_effect_mode: true, tool_readiness: toolRegistry.readiness(), database: { server_id: database.capabilities().server_id, read_only: true, operations: database.listOperations(), private_rows: false, arbitrary_sql: false } });
  if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "documents") return createDocument(req, res, store);
  if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "producer-source-bundles") return createProducerSourceBundle(req, res, store);
  if (req.method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "producer-source-bundles") return getProducerSourceBundle(res, store, parts[2]);
  if (req.method === "POST" && parts.length === 4 && parts[0] === "v1" && parts[1] === "producer-source-bundles" && parts[3] === "packets") return createProducerPacketFromBundle(req, res, store, producerEngine, parts[2]);
  if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "producer-packets") return createProducerPacket(req, res, store, producerEngine);
  if (req.method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "producer-packets") return getProducerPacket(res, store, parts[2]);
  if (req.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "producer-packets" && parts[3] === "events") return streamProducerEvents(req, res, store, parts[2]);
  if (req.method === "POST" && parts.length === 4 && parts[0] === "v1" && parts[1] === "producer-packets" && parts[3] === "retry") return retryProducerPacket(req, res, store, producerEngine, parts[2]);
  if (req.method === "GET" && parts.length === 5 && parts[0] === "v1" && parts[1] === "producer-packets" && parts[3] === "citations") return getProducerCitation(res, store, parts[2], parts[4]);
  if (req.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "producer-packets" && parts[3] === "handoff") return getProducerHandoff(req, res, store, parts[2]);
  if (parts[0] === "v1" && parts[1] === "documents" && parts.length >= 3) {
    if (req.method === "GET" && parts.length === 3) return getDocument(res, store, parts[2]);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "briefs") return createGroundedBrief(req, res, store, groundedEngine, parts[2]);
    if (req.method === "GET" && parts.length === 5 && parts[3] === "citations") return getDocumentCitation(res, store, groundingSource, parts[2], parts[4]);
  }
  if (parts[0] === "v1" && parts[1] === "script-briefs" && parts.length >= 3) {
    if (req.method === "GET" && parts.length === 3) return getGroundedBrief(res, store, parts[2]);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") return streamScriptEvents(req, res, store, parts[2]);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "retry") return retryGroundedBrief(req, res, store, groundedEngine, parts[2]);
  }
  if (parts[0] !== "v1") return sendError(res, 404, "NOT_FOUND", "Route not found");
  if (req.method === "POST" && parts.length === 2 && parts[1] === "runs") return createRun(req, res, { store, engine, audit, runtimeConfig, partnerRuntime });
  if (parts.length >= 3 && parts[1] === "runs") {
    const runId = parts[2];
    if (req.method === "GET" && parts.length === 3) return getRun(res, store, runId, partnerRuntime);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "state") return getRunState(res, store, runId);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "checkpoints") return getRunCheckpoints(res, store, runId);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") return streamEvents(req, res, store, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "cancel") return cancelRun(req, res, store, engine, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "retry") return retryRun(req, res, store, engine, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "clarify") return clarifyRun(req, res, store, engine, runId);
    if (req.method === "GET" && parts.length === 5 && parts[3] === "evidence") return getEvidence(res, store, runId, parts[4]);
  }
  return sendError(res, 404, "NOT_FOUND", "Route not found");
}

async function createRun(req, res, { store, engine, audit, runtimeConfig, partnerRuntime }) {
  const request = parseRunRequest(await readBody(req, runtimeConfig.maxBodyBytes));
  const key = parseIdempotencyKey(req.headers["idempotency-key"]);
  const result = store.createRun({ request, requestHash: requestHash(request), idempotencyHash: hashValue(key), provenance: engine.provenance });
  if (result.created) {
    audit.record({ type: "request_outcome", outcome: "accepted", mode: runtimeConfig.mode, runId: result.run.run_id, provenance: engine.provenance, attributes: { workflow: "audience_data_readiness" } });
    engine.enqueue(result.run.run_id);
  }
  const projection = { ...projectRun(result.run, store), partner_status: partnerRuntime.projections() };
  return sendJson(res, 202, projection, { location: `/v1/runs/${result.run.run_id}` });
}

async function createDocument(req, res, store) {
  const document = await readUpload(req);
  const result = store.createDocument(document);
  return sendJson(res, result.created ? 201 : 200, { ...safeDocumentProjection(result.document), duplicate: !result.created, ingestion: { ...result.document.ingestion, stages: ["uploaded", "text extracted", "chunks mapped", "ready"] } });
}

async function invokeProducerAgent(req, res, agentBoundary, maxBodyBytes) {
  const result = await agentBoundary.invoke(await readBody(req, maxBodyBytes));
  return sendJson(res, 200, result);
}

function safeProducerBundleProjection(bundle) {
  return {
    schema_version: PRODUCER_BUNDLE_SCHEMA,
    bundle_id: bundle.bundle_id,
    source_count: bundle.sources.length,
    source_ids: bundle.sources.map((source) => source.source_id),
    total_bytes: bundle.sources.reduce((total, source) => total + source.byte_size, 0),
    total_extracted_chars: bundle.sources.reduce((total, source) => total + source.text_char_count, 0),
    manifest_hash: bundle.manifest_hash,
    source_manifest: bundle.sources.map((source) => ({
      source_id: source.source_id,
      input_ref: source.input_ref || null,
      filename: source.filename,
      media_type: source.media_type,
      byte_size: source.byte_size,
      content_hash: source.content_hash,
      source_kind: source.source_kind,
      department: source.department || null,
      version_label: source.version_label || null,
      status_label: source.status_label || null,
      relationships: source.relationships || [],
      ingestion_state: source.ingestion?.state || "ready",
      truncated: Boolean(source.truncated),
    })),
    provenance: { mode: "demo", network: false, credentials: false, retention_state: "local" },
  };
}

async function createProducerSourceBundle(req, res, store) {
  const upload = await readProducerUpload(req);
  if (!upload.canonical) throw new DocumentContractError("MANIFEST_REQUIRED", "Producer Intake source bundles require a bounded manifest", "manifest");
  const bundleId = producerBundleId(upload.sources);
  const manifestHash = `sha256:${hashValue(stableStringify(upload.manifest))}`;
  const result = store.createProducerBundle({ schema_version: PRODUCER_BUNDLE_SCHEMA, bundle_id: bundleId, manifest_hash: manifestHash, sources: upload.sources, created_at: new Date().toISOString(), retention_state: "local" });
  return sendJson(res, result.created ? 201 : 200, safeProducerBundleProjection(result.bundle), { location: `/v1/producer-source-bundles/${bundleId}` });
}

function getProducerSourceBundle(res, store, bundleId) {
  const bundle = store.getProducerBundle(bundleId);
  if (!bundle) throw new ContractError("PRODUCER_BUNDLE_NOT_FOUND", "Producer source bundle not found");
  return sendJson(res, 200, safeProducerBundleProjection(bundle));
}

async function createProducerPacketFromBundle(req, res, store, producerEngine, bundleId) {
  const bundle = store.getProducerBundle(bundleId);
  if (!bundle) throw new ContractError("PRODUCER_BUNDLE_NOT_FOUND", "Producer source bundle not found");
  const body = await readBody(req);
  const allowed = new Set(["schema_version", "bundle_id", "decision_context", "target_region"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new ContractError("UNKNOWN_FIELD", `Producer Intake request contains unknown field: ${key}`, key);
  if (body.schema_version !== "producer-intake-request@1" || body.bundle_id !== bundleId) throw new ContractError("INVALID_SCHEMA_VERSION", "schema_version and bundle_id must identify a producer-intake-request@1 for this bundle");
  const decisionContext = body.decision_context === undefined ? "" : String(body.decision_context).normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (decisionContext.length > 1_000) throw new ContractError("INVALID_REQUEST", "decision_context must be at most 1,000 characters", "decision_context");
  const targetRegion = String(body.target_region || "Singapore").normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!targetRegion || targetRegion.length > 100) throw new ContractError("INVALID_REQUEST", "target_region must be a bounded non-empty string", "target_region");
  const packetId = producerPacketId(bundle.sources, { bundleId, targetRegion });
  const result = producerEngine.create({ sources: bundle.sources, packetId, bundleId, bundleManifestHash: bundle.manifest_hash, decisionContext, targetRegion });
  return sendJson(res, result.created ? 202 : 200, projectProducerRun(result.run, store), { location: `/v1/producer-packets/${packetId}` });
}

async function createProducerPacket(req, res, store, producerEngine) {
  const upload = await readProducerUpload(req);
  const bundleId = upload.canonical ? producerBundleId(upload.sources) : undefined;
  const bundleManifestHash = upload.canonical ? `sha256:${hashValue(stableStringify(upload.manifest))}` : undefined;
  if (upload.canonical) store.createProducerBundle({ schema_version: PRODUCER_BUNDLE_SCHEMA, bundle_id: bundleId, manifest_hash: bundleManifestHash, sources: upload.sources, created_at: new Date().toISOString(), retention_state: "local" });
  const packetId = producerPacketId(upload.sources, { bundleId });
  const result = producerEngine.create({ sources: upload.sources, packetId, bundleId, bundleManifestHash });
  return sendJson(res, result.created ? 202 : 200, projectProducerRun(result.run, store), { location: `/v1/producer-packets/${packetId}` });
}

function getProducerPacket(res, store, packetId) {
  const run = store.getProducerRun(packetId);
  if (run) return sendJson(res, 200, projectProducerRun(run, store));
  const packet = store.getProducerPacket(packetId);
  if (!packet) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet not found");
  return sendJson(res, 200, safeProducerPacketProjection(packet));
}

const PRODUCER_RUN_TERMINAL = new Set(["succeeded", "failed"]);

function streamProducerEvents(req, res, store, packetId) {
  const requestUrl = new URL(req.url, "http://localhost");
  const run = store.getProducerRun(packetId);
  if (!run) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet run not found");
  let cursor = Number(req.headers["last-event-id"] || requestUrl.searchParams.get("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  let closed = false;
  const write = (event) => {
    if (closed) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    cursor = event.seq;
  };
  const flush = () => {
    if (closed) return;
    for (const event of store.getProducerRunEvents(packetId, cursor)) write(event);
    const current = store.getProducerRun(packetId);
    if (current && PRODUCER_RUN_TERMINAL.has(current.state)) {
      clearInterval(poll);
      clearInterval(heartbeat);
      setTimeout(() => { if (!closed) { closed = true; res.end(); } }, 30);
    }
  };
  const poll = setInterval(flush, 150);
  const heartbeat = setInterval(() => { if (!closed) res.write(": heartbeat\n\n"); }, 10_000);
  req.on("close", () => { closed = true; clearInterval(poll); clearInterval(heartbeat); });
  flush();
}

async function retryProducerPacket(req, res, store, producerEngine, packetId) {
  requireEmpty(await readBody(req));
  const child = await producerEngine.retry(packetId);
  return sendJson(res, 202, projectProducerRun(child, store), { location: `/v1/producer-packets/${child.packet_id}` });
}

function getProducerCitation(res, store, packetId, citationId) {
  const packet = store.getProducerPacket(packetId);
  if (!packet) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet not found");
  const citation = producerCitation(packet, citationId);
  if (!citation) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer citation not found");
  return sendJson(res, 200, { ...citation, excerpt: citation.excerpt.slice(0, 900) });
}

function producerHandoffJson(packet) {
  return {
    schema_version: "producer-read-only-handoff@1",
    packet_id: packet.packet_id,
    bundle_id: packet.bundle_id || packet.bundle?.bundle_id || null,
    target_region: packet.target_region || packet.provenance?.target_region || "Singapore",
    status: packet.handoff?.status || "review_required",
    source_manifest: (packet.source_manifest || packet.source_inventory || []).map((source) => ({ ...source })),
    exact_facts: (packet.exact_facts || []).slice(0, 24),
    scene_index: (packet.scene_index || []).slice(0, 24).map((scene) => ({
      scene_id: scene.scene_id,
      scene_reference: scene.scene_reference,
      scene_heading: scene.scene_heading,
      scene_summary: scene.scene_summary,
      narrative_summary: scene.narrative_summary,
      setting: scene.setting,
      int_ext: scene.int_ext,
      time_of_day: scene.time_of_day,
      actor_count: scene.actor_count,
      actor_count_basis: scene.actor_count_basis,
      dialogue_characters: scene.dialogue_characters || [],
      dialogue: scene.dialogue || [],
      actions: scene.actions || [],
      character_analysis: scene.character_analysis || [],
      atmosphere: scene.atmosphere,
      classification: scene.classification,
      evidence_state: scene.evidence_state,
      source_ids: scene.source_ids || [],
      citation_ids: scene.citation_ids || [],
      limitations: scene.limitations || [],
    })),
    production_elements: (packet.production_elements || []).slice(0, 240),
    budget_risk_observations: (packet.budget_risk_observations || []).slice(0, 120),
    coverage_gaps: (packet.coverage_gaps || []).slice(0, 120),
    budget_inputs: (packet.budget_inputs || []).slice(0, 24),
    rights_access_logistics: (packet.rights_access_logistics || []).slice(0, 24),
    conflicts: (packet.conflicts || []).slice(0, 24),
    decision_question_register: (packet.decision_question_register || []).slice(0, 120),
    gaps_and_next_steps: (packet.gaps_and_next_steps || []).slice(0, 120),
    external_evidence: (packet.external_evidence || []).slice(0, 60),
    handoff: packet.handoff,
    provenance: packet.provenance,
    limitations: packet.limitations.slice(0, 8),
  };
}

function markdownHandoff(packet) {
  const handoff = producerHandoffJson(packet);
  const lines = [
    "# MovieInator Producer Intake Decision Packet",
    "",
    `Packet: ${handoff.packet_id}`,
    `Bundle: ${handoff.bundle_id || "not supplied"}`,
    `Target region: ${handoff.target_region}`,
    "",
    "## Source inventory",
    ...handoff.source_manifest.map((source) => `- ${source.source_id} | ${source.filename} | ${source.source_kind} | ${source.content_hash || "hash unavailable"}${source.version_label ? ` | version ${source.version_label}` : ""}`),
    "",
    "## Exact facts",
    ...handoff.exact_facts.map((fact) => `- [${fact.classification}] [${fact.evidence_state}] ${fact.value || fact.text} (citations: ${(fact.citation_ids || []).join(", ") || "none"})`),
    "",
    "## Scene index",
    ...handoff.scene_index.map((scene) => `- ${scene.scene_heading || scene.scene_reference} | summary: ${scene.scene_summary || "not established"} | actors: ${scene.actor_count ?? "not established"} | dialogue: ${(scene.dialogue || []).map((line) => line.text).join(" ") || "not established"} | actions: ${(scene.actions || []).map((line) => line.text).join(" ") || "not established"} | atmosphere: ${JSON.stringify(scene.atmosphere || {})} | ${scene.classification}; ${scene.evidence_state} (citations: ${(scene.citation_ids || []).join(", ") || "none"})`),
    "",
    "## Production elements",
    ...handoff.production_elements.map((item) => `- [${item.category}] ${item.value || item.text} | count: ${item.count ?? "not established"} | complexity: ${item.complexity || "not established"} | ${item.classification}; ${item.evidence_state} (citations: ${(item.citation_ids || []).join(", ") || "none"})`),
    "",
    "## Budget-risk observations",
    ...(handoff.budget_risk_observations.length ? handoff.budget_risk_observations.map((item) => `- [${item.evidence_state}] ${item.text} | owner: ${item.owner || "unset"} | next action: ${item.next_action || "human review required"}`) : ["- No source-grounded budget-risk observation was recorded."]),
    "",
    "## Coverage gaps",
    ...(handoff.coverage_gaps.length ? handoff.coverage_gaps.map((item) => `- [${item.field || item.category}] ${item.question || item.text} | owner: ${item.owner || "unset"} | next action: ${item.next_action || "human review required"}`) : ["- No coverage gap was recorded."]),
    "",
    "## Budget inputs",
    ...handoff.budget_inputs.map((input) => `- ${input.value || input.original_wording} | ${input.currency || "currency unset"} | ${input.unit || "unit unset"} | ${input.evidence_state} | no total calculated`),
    "",
    "## Conflicts",
    ...handoff.conflicts.flatMap((conflict) => [`- ${conflict.title || conflict.kind}: ${conflict.question || conflict.impact || "human resolution required"}`, ...(conflict.assertions || []).map((assertion) => `  - ${assertion.text} (${(assertion.citation_ids || []).join(", ")})`)]),
    "",
    "## Questions and next steps",
    ...handoff.gaps_and_next_steps.map((gap) => `- ${gap.question} | owner: ${gap.owner || "unset"} | priority: ${gap.priority || "unset"} | next action: ${gap.next_action}`),
    "",
    "## External evidence (Parallel Search, not verified against uploaded sources)",
    ...(handoff.external_evidence.length ? handoff.external_evidence.map((item) => `- [${item.classification}] [${item.evidence_state}] ${item.value || item.text} (citations: ${(item.citation_ids || []).join(", ") || "none"})`) : ["- Parallel Search enrichment is not enabled for this packet."]),
    "",
    `Handoff: ${handoff.handoff?.next_action || "Human review required."}`,
    "",
    "Read-only local/demo handoff. It does not book, approve, publish, send, or modify a downstream system.",
  ];
  return lines.join("\n").slice(0, 90_000);
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""').replace(/[\r\n]+/g, " ").slice(0, 700)}"`;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function csvHandoff(packet) {
  const handoff = producerHandoffJson(packet);
  const rows = [csvRow(["section", "label", "classification", "evidence_state", "value", "owner", "priority", "citation_ids"])];
  for (const source of handoff.source_manifest) {
    rows.push(csvRow(["source_manifest", source.source_id, "externally_supplied_fact", source.ingestion_state || "ready", `${source.filename} (${source.source_kind}${source.version_label ? `, version ${source.version_label}` : ""})`, source.department || "", "", (source.relationships || []).map((relationship) => relationship.type).join("; ")]));
  }
  for (const fact of handoff.exact_facts) {
    rows.push(csvRow(["exact_facts", fact.field || fact.fact_id || "", fact.classification || "", fact.evidence_state || "", fact.value || fact.text || "", "", "", (fact.citation_ids || []).join("; ")]));
  }
  for (const scene of handoff.scene_index) {
    rows.push(csvRow(["scene_index", scene.scene_id || "", scene.classification || "", scene.evidence_state || "", `${scene.scene_heading || scene.scene_reference || ""} | summary: ${scene.scene_summary || "not established"} | actors: ${scene.actor_count ?? "not established"} | dialogue: ${JSON.stringify(scene.dialogue || [])} | actions: ${JSON.stringify(scene.actions || [])} | character analysis: ${JSON.stringify(scene.character_analysis || [])} | atmosphere: ${JSON.stringify(scene.atmosphere || {})}`, "", "", (scene.citation_ids || []).join("; ")]));
  }
  for (const item of handoff.production_elements) {
    rows.push(csvRow(["production_elements", item.element_id || "", item.classification || "", item.evidence_state || "", `${item.category || "other"}: ${item.value || item.text || ""} | count: ${item.count ?? "not established"} | complexity: ${item.complexity || "not established"}`, item.owner || "", item.priority || "", (item.citation_ids || []).join("; ")]));
  }
  for (const item of handoff.budget_risk_observations) {
    rows.push(csvRow(["budget_risk_observations", item.element_id || "", item.classification || "", item.evidence_state || "", item.text || item.value || "", item.owner || "", item.priority || "", (item.citation_ids || []).join("; ")]));
  }
  for (const item of handoff.coverage_gaps) {
    rows.push(csvRow(["coverage_gaps", item.gap_id || "", item.classification || "", item.evidence_state || "", item.question || item.text || "", item.owner || "", item.priority || "", (item.citation_ids || []).join("; ")]));
  }
  for (const input of handoff.budget_inputs) {
    rows.push(csvRow(["budget_inputs", input.input_id || "", input.classification || "", input.evidence_state || "", `${input.value || input.original_wording || ""} ${input.unit || ""} ${input.currency || ""}`.trim(), "", "", (input.citation_ids || []).join("; ")]));
  }
  for (const row of handoff.rights_access_logistics) {
    rows.push(csvRow(["rights_access_logistics", row.category || row.field || "", row.classification || "", row.evidence_state || "", row.value || row.text || "", row.owner || "", row.priority || "", (row.citation_ids || []).join("; ")]));
  }
  for (const conflict of handoff.conflicts) {
    for (const assertion of conflict.assertions || [{ text: conflict.question || conflict.impact, citation_ids: conflict.citation_ids, classification: conflict.classification, evidence_state: conflict.evidence_state }]) {
      rows.push(csvRow(["conflicts", conflict.conflict_id || conflict.title || "", assertion.classification || conflict.classification || "conflict", assertion.evidence_state || conflict.evidence_state || "conflict", assertion.text || "", "", "", (assertion.citation_ids || []).join("; ")]));
    }
  }
  for (const entry of handoff.decision_question_register) {
    rows.push(csvRow(["decision_question_register", entry.entry_id || "", entry.classification || entry.entry_type || "", entry.evidence_state || "", `${entry.title || entry.related_to || ""}${entry.next_action ? ` | next action: ${entry.next_action}` : ""}`, entry.owner || "", entry.priority || "", (entry.citation_ids || []).join("; ")]));
  }
  for (const gap of handoff.gaps_and_next_steps) {
    rows.push(csvRow(["gaps_and_next_steps", gap.gap_id || "", gap.classification || "open_question", gap.evidence_state || "", `${gap.question || ""}${gap.next_action ? ` | next action: ${gap.next_action}` : ""}`, gap.owner || "", gap.priority || "", (gap.citation_ids || []).join("; ")]));
  }
  for (const item of handoff.external_evidence) {
    rows.push(csvRow(["external_evidence", item.element_id || "", item.classification || "", item.evidence_state || "", item.value || item.text || "", "", "", (item.citation_ids || []).join("; ")]));
  }
  return rows.slice(0, 512).join("\r\n");
}

function getProducerHandoff(req, res, store, packetId) {
  const packet = store.getProducerPacket(packetId);
  if (!packet) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet not found");
  const format = new URL(req.url, "http://localhost").searchParams.get("format") || "markdown";
  if (!["markdown", "json", "csv"].includes(format)) throw new ContractError("UNSUPPORTED_EXPORT_FORMAT", "Only Markdown, JSON, and CSV handoff exports are supported", "format");
  if (format === "json") return sendJson(res, 200, producerHandoffJson(packet), { "content-disposition": `attachment; filename="${packet.packet_id}-handoff.json"` });
  if (format === "csv") {
    const csv = csvHandoff(packet);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${packet.packet_id}-handoff.csv"`, "cache-control": "no-store" });
    return res.end(csv);
  }
  const body = markdownHandoff(packet);
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${packet.packet_id}-handoff.md"`, "cache-control": "no-store" });
  res.end(body);
}

function getDocument(res, store, documentId) {
  const document = store.getDocument(documentId);
  if (!document) throw new ContractError("DOCUMENT_NOT_FOUND", "Document not found");
  return sendJson(res, 200, safeDocumentProjection(document));
}

async function createGroundedBrief(req, res, store, groundedEngine, documentId) {
  const document = store.getDocument(documentId);
  if (!document) throw new ContractError("DOCUMENT_NOT_FOUND", "Document not found");
  const request = validateGroundingRequest(await readBody(req));
  const key = parseIdempotencyKey(req.headers["idempotency-key"]);
  const result = store.createScriptRun({ documentId, question: request.question, requestIntent: request.request || request.question, briefVersion: request.brief_version || 1, idempotencyHash: hashValue(key), provenance: groundedEngine.provenance() });
  if (result.created) groundedEngine.enqueue(result.run.run_id);
  return sendJson(res, 202, projectGroundedRun(result.run, store), { location: `/v1/script-briefs/${result.run.run_id}` });
}

function getGroundedBrief(res, store, runId) {
  const run = store.getScriptRun(runId);
  if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
  return sendJson(res, 200, projectGroundedRun(run, store));
}

function streamScriptEvents(req, res, store, runId) {
  const requestUrl = new URL(req.url, "http://localhost");
  const run = store.getScriptRun(runId);
  if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
  let cursor = Number(req.headers["last-event-id"] || requestUrl.searchParams.get("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  let closed = false;
  const write = (event) => {
    if (closed) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    cursor = event.seq;
  };
  const flush = () => {
    if (closed) return;
    for (const event of store.getScriptEvents(runId, cursor)) write(event);
    const current = store.getScriptRun(runId);
    if (current && SCRIPT_TERMINAL.has(current.state)) {
      clearInterval(poll);
      clearInterval(heartbeat);
      setTimeout(() => { if (!closed) { closed = true; res.end(); } }, 30);
    }
  };
  const poll = setInterval(flush, 150);
  const heartbeat = setInterval(() => { if (!closed) res.write(": heartbeat\n\n"); }, 10_000);
  req.on("close", () => { closed = true; clearInterval(poll); clearInterval(heartbeat); });
  flush();
}

async function retryGroundedBrief(req, res, store, groundedEngine, runId) {
  requireEmpty(await readBody(req));
  const child = await groundedEngine.retry(runId, { idempotencyHash: hashValue(`${runId}|retry|${Date.now()}`) });
  return sendJson(res, 202, projectGroundedRun(child, store), { location: `/v1/script-briefs/${child.run_id}` });
}

async function getDocumentCitation(res, store, groundingSource, documentId, citationId) {
  const document = store.getDocument(documentId);
  if (!document) throw new ContractError("DOCUMENT_NOT_FOUND", "Document not found");
  const citation = await groundingSource.citation(documentId, citationId);
  if (!citation) throw new ContractError("DOCUMENT_NOT_FOUND", "Citation not found");
  return sendJson(res, 200, safeCitationProjection(citation));
}

function listPartners(res, partnerRuntime) {
  return sendJson(res, 200, { schema_version: "partner-registry-projection@1", providers: partnerRuntime.projections(), limitation: "Only explicitly registered read-only partner metadata is shown. No raw payloads or credentials are returned." });
}

function getPartner(res, partnerRuntime, providerId) {
  const projection = partnerRuntime.projections().find((item) => item.provider?.provider_id === providerId);
  if (!projection) throw new ContractError("PARTNER_NOT_FOUND", "Partner provider not found");
  return sendJson(res, 200, projection);
}

function getPartnerReadiness(res, partnerRuntime, providerId) {
  return sendJson(res, 200, partnerRuntime.readiness(providerId));
}

function getPartnerEvents(res, partnerRuntime, providerId) {
  if (!partnerRuntime.registry.has(providerId)) throw new ContractError("PARTNER_NOT_FOUND", "Partner provider not found");
  return sendJson(res, 200, { schema_version: "partner-events-projection@1", provider_id: providerId, events: partnerRuntime.eventsFor(providerId), limitation: "Events are redacted operational evidence only." });
}

function getRun(res, store, runId, partnerRuntime) {
  const run = store.getRun(runId);
  if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  return sendJson(res, 200, { ...projectRun(run, store), partner_status: partnerRuntime.projections() });
}

function getRunState(res, store, runId) {
  const projection = store.workflowProjection(runId);
  if (!projection) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  return sendJson(res, 200, { schema_version: "workflow-state-projection@1", run_id: runId, ...projection });
}

function getRunCheckpoints(res, store, runId) {
  const run = store.getRun(runId);
  if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  return sendJson(res, 200, { schema_version: "workflow-checkpoints-projection@1", run_id: runId, checkpoints: store.workflowProjection(runId)?.checkpoints || [] });
}

async function cancelRun(req, res, store, engine, runId) {
  requireEmpty(await readBody(req));
  const run = engine.requestCancel(runId);
  return sendJson(res, 202, projectRun(run, store));
}

async function retryRun(req, res, store, engine, runId) {
  requireEmpty(await readBody(req));
  const child = await engine.retry(runId);
  return sendJson(res, 202, projectRun(child, store), { location: `/v1/runs/${child.run_id}` });
}

async function clarifyRun(req, res, store, engine, runId) {
  const body = await readBody(req);
  if (Object.keys(body).some((key) => key !== "candidate_id")) throw new ContractError("UNKNOWN_FIELD", "Only candidate_id is accepted for clarification");
  const candidateId = redactText(body.candidate_id, 200);
  if (!candidateId) throw new ContractError("REQUIRED_FIELD", "candidate_id is required", "candidate_id");
  const child = await engine.clarify(runId, candidateId);
  return sendJson(res, 202, projectRun(child, store), { location: `/v1/runs/${child.run_id}` });
}

function getEvidence(res, store, runId, evidenceId) {
  const run = store.getRun(runId);
  if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  if (!run.evidence_ids.includes(evidenceId)) throw new ContractError("RUN_NOT_FOUND", "Evidence not found");
  const evidence = store.getEvidence(evidenceId);
  if (!evidence) throw new ContractError("RUN_NOT_FOUND", "Evidence not found");
  return sendJson(res, 200, safeEvidence(evidence));
}

function safeEvidence(record) {
  return {
    schema_version: "evidence-projection@1",
    evidence_id: record.evidence_id,
    run_id: record.run_id,
    check_kind: record.check_kind,
    status: record.status,
    source_label: "Demo evidence",
    authority_class: record.authority_class,
    semantic_operation: record.semantic_operation,
    observed_at: record.observed_at,
    fresh_until: record.fresh_until,
    facts: record.facts,
    units: record.units,
    policy_version: record.policy_version,
    safe_hash: record.response_hash,
    provenance: record.provenance,
  };
}

function streamEvents(req, res, store, runId) {
  const requestUrl = new URL(req.url, "http://localhost");
  const run = store.getRun(runId);
  if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  let cursor = Number(req.headers["last-event-id"] || requestUrl.searchParams.get("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  const write = (event) => {
    if (closed) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    cursor = event.seq;
  };
  const flush = () => {
    const events = store.getEvents(runId, cursor);
    for (const event of events) write(event);
    const current = store.getRun(runId);
    if (current && TERMINAL.has(current.state)) {
      clearInterval(poll);
      clearInterval(heartbeat);
      setTimeout(() => {
        if (!closed) {
          closed = true;
          res.end();
        }
      }, 30);
    }
  };
  const poll = setInterval(flush, 150);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": heartbeat\n\n");
  }, 10_000);
  req.on("close", () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  });
  flush();
}

function sendStatic(res, name, contentType) {
  const file = path.join(WEB_ROOT, name);
  if (!file.startsWith(WEB_ROOT)) return sendError(res, 404, "NOT_FOUND", "Asset not found");
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": contentType, "cache-control": "no-cache" });
    res.end(body);
  } catch {
    sendError(res, 404, "NOT_FOUND", "Asset not found");
  }
}

/**
 * Boot the server process. Unlike `createApp` (used synchronously by tests
 * with pre-checked or intentionally unchecked readiness), this is the actual
 * process entry point: when the operator has explicitly enabled and fully
 * configured Google Gemini, it runs one real, awaited readiness preflight
 * before the server accepts traffic, and keeps that evidence fresh with a
 * bounded periodic recheck so the live call path stays genuinely usable
 * instead of silently going stale after `GEMINI_READINESS_MAX_AGE_MS`. Mock
 * mode and incomplete configuration take neither branch and make zero
 * network calls, matching the existing fail-closed contract.
 */
export async function startServer({ env = process.env, googleReadinessRefreshMs = GOOGLE_READINESS_REFRESH_MS, ...options } = {}) {
  const configuredGoogle = normalizeGeminiConfig(options.googleConfig || readGeminiConfig(env));
  const tokenProvider = resolveGoogleTokenProvider(configuredGoogle, options.googleTokenProvider);
  const liveGoogleIntent = configuredGoogle.enabled && configuredGoogle.configured;
  let googleReadiness = options.googleReadiness;
  if (liveGoogleIntent && !isGeminiReadinessForConfig(googleReadiness, configuredGoogle)) {
    const readiness = createGeminiReadiness({ config: configuredGoogle, transport: options.googleTransport, tokenProvider });
    await readiness.check();
    googleReadiness = readiness;
  }
  const app = createApp({ ...options, env, googleConfig: configuredGoogle, googleTokenProvider: tokenProvider, googleReadiness });
  let refreshTimer;
  if (liveGoogleIntent && isGeminiReadinessForConfig(app.googleReadiness, configuredGoogle)) {
    const refreshMs = Math.max(1000, Math.min(googleReadinessRefreshMs, GEMINI_READINESS_MAX_AGE_MS - 30_000));
    refreshTimer = setInterval(() => { app.googleReadiness.check().catch(() => {}); }, refreshMs);
    refreshTimer.unref?.();
  }
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.runtimeConfig.port, app.runtimeConfig.host, resolve);
  });
  let shuttingDown = false;
  const shutdown = async (signal = "shutdown") => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (refreshTimer) clearInterval(refreshTimer);
    let closed = false;
    const close = new Promise((resolve) => app.server.close(() => { closed = true; resolve(); }));
    await Promise.race([close, new Promise((resolve) => setTimeout(resolve, app.runtimeConfig.gracefulShutdownMs))]);
    if (!closed) {
      app.server.closeAllConnections?.();
      await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
    app.audit.record({ type: "configuration_state", outcome: "stopped", mode: app.runtimeConfig.mode, attributes: { signal } });
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  return { ...app, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startServer({ dataPath: process.env.DATA_PATH }).then((app) => {
    const address = app.server.address();
    const host = typeof address === "object" && address ? address.address : app.runtimeConfig.host;
    const port = typeof address === "object" && address ? address.port : app.runtimeConfig.port;
    console.log(`${PRODUCT_DISPLAY_NAME} server listening on http://${host}:${port}`);
  }).catch((error) => {
    console.error(JSON.stringify({ event: "startup_failed", code: error.code || "startup_failed" }));
    process.exitCode = 1;
  });
}
