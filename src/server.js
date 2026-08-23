import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  hashValue,
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
import { GeminiRestBackend, isGeminiReady, normalizeGeminiConfig, readGeminiConfig } from "./gemini-rest.js";
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
import { PRODUCT_DISPLAY_NAME } from "./product-identity.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, "..", "web");
const MAX_BODY_BYTES = 128 * 1024;
const MAX_UPLOAD_BODY_BYTES = MAX_DOCUMENT_BYTES + 128 * 1024;
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

function parseMultipart(body, contentType) {
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
    if (next < 0) break;
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
    offset = next + boundary.length;
  }
  const fileParts = parts.filter((part) => part.name === "file" && part.filename !== undefined);
  if (parts.length !== 1 || fileParts.length !== 1) throw new DocumentContractError("INVALID_MULTIPART", "Upload exactly one file field", "file");
  return fileParts[0];
}

async function readUpload(req) {
  const part = parseMultipart(await readRawBody(req, MAX_UPLOAD_BODY_BYTES), req.headers["content-type"]);
  return parseGroundingDocument({ filename: part.filename, contentType: part.contentType, bytes: part.content });
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

export function createApp({ store, provider, model, dataPath, env = process.env, googleConfig, googleTransport, googleTokenProvider, groundingSource, secretProvider, auditLogger, partnerRegistry, partnerRuntime, database, toolRegistry } = {}) {
  const actualStore = store || new FileStore(dataPath);
  const runtimeConfig = readRuntimeConfig(env, { googleConfig });
  const audit = createAuditRecorder({ store: actualStore, logger: auditLogger });
  const actualProvider = provider || new MockProvider();
  const actualDatabase = database || createLocalMcpDatabase();
  const actualToolRegistry = toolRegistry || createDefaultToolRegistry({ database: actualDatabase });
  const configuredGoogle = normalizeGeminiConfig(googleConfig || readGeminiConfig(env));
  const actualTokenProvider = googleTokenProvider || (["adc", "workload_identity", "attached_identity"].includes(configuredGoogle.authMode) ? createAdcTokenProvider() : undefined);
  const actualSecretProvider = createSecretProvider({ env, provider: secretProvider, tokenProvider: actualTokenProvider });
  audit.record({ type: "configuration_state", outcome: runtimeConfig.readiness, mode: runtimeConfig.mode, attributes: { target: runtimeConfig.target, google_intent: runtimeConfig.googleIntent, google_state: runtimeConfig.google.readiness, configured: runtimeConfig.google.configured, secret_reference_count: runtimeConfig.secretReferenceCount } });
  const actualModel = model || (isGeminiReady(configuredGoogle) ? new GeminiRestBackend({ config: configuredGoogle, transport: googleTransport, tokenProvider: actualTokenProvider, audit }) : new FakeModel());
  audit.record({ type: "model_provenance", outcome: "configured", mode: runtimeConfig.mode, provenance: typeof actualModel.provenance === "function" ? actualModel.provenance() : undefined, attributes: { backend: isGeminiReady(configuredGoogle) ? "google_rest" : "fake" } });
  audit.record({ type: "provider_provenance", outcome: "configured", mode: runtimeConfig.mode, provenance: actualProvider.capabilities?.(), attributes: { provider_id: actualProvider.manifest?.provider_id || "unknown", read_only: actualProvider.manifest?.read_only !== false } });
  const engine = new MockEngine({ store: actualStore, provider: actualProvider, model: actualModel, audit });
  const actualGroundingSource = groundingSource || new LocalDeterministicGroundingSource({ store: actualStore });
  const groundedEngine = new GroundedBriefEngine({ store: actualStore, groundingSource: actualGroundingSource, model: actualModel, audit });
  const actualPartnerRegistry = partnerRegistry || createDefaultPartnerRegistry();
  const actualPartnerRuntime = partnerRuntime || new PartnerOperationRunner({ registry: actualPartnerRegistry });
  engine.resumeActive();

  const server = http.createServer(async (req, res) => {
    const streaming = String(req.url || "").endsWith("/events");
    if (!streaming) req.setTimeout(runtimeConfig.requestTimeoutMs, () => {
      if (!res.headersSent) sendError(res, 504, "REQUEST_TIMEOUT", "The request exceeded the configured timeout");
      req.destroy();
    });
    try {
      await route(req, res, { store: actualStore, engine, groundedEngine, groundingSource: actualGroundingSource, googleConfig: configuredGoogle, runtimeConfig, audit, partnerRuntime: actualPartnerRuntime, database: actualDatabase, toolRegistry: actualToolRegistry });
    } catch (error) {
      const notFound = ["RUN_NOT_FOUND", "DOCUMENT_NOT_FOUND", "SCRIPT_RUN_NOT_FOUND", ...PARTNER_NOT_FOUND_CODES].includes(error.code);
      const conflict = ["IDEMPOTENCY_KEY_REUSED", "RUN_NOT_RETRYABLE", "RUN_NOT_CLARIFIABLE", "INVALID_CANDIDATE"].includes(error.code);
      const safeContractError = error instanceof ContractError || error instanceof DocumentContractError || error instanceof PartnerContractError;
      const status = notFound ? 404 : conflict ? 409 : safeContractError ? 400 : 500;
      if (!res.headersSent) sendError(res, status, error.code || "INTERNAL_ERROR", safeContractError ? error.message : `The ${PRODUCT_DISPLAY_NAME} server could not complete the request`, error.field);
      if (!safeContractError) audit.record({ type: "operator_failure", outcome: "failed", mode: runtimeConfig.mode, code: error.code || "internal_error", attributes: { route: req.url?.split("?")[0] } });
    }
  });
  server.requestTimeout = runtimeConfig.requestTimeoutMs;
  server.headersTimeout = Math.min(runtimeConfig.requestTimeoutMs, 30_000);
  server.keepAliveTimeout = Math.min(runtimeConfig.requestTimeoutMs, 10_000);
  return { server, store: actualStore, engine, groundedEngine, groundingSource: actualGroundingSource, provider: actualProvider, model: actualModel, googleConfig: configuredGoogle, runtimeConfig, secretProvider: actualSecretProvider, audit, partnerRegistry: actualPartnerRegistry, partnerRuntime: actualPartnerRuntime, database: actualDatabase, toolRegistry: actualToolRegistry };
}

async function route(req, res, { store, engine, groundedEngine, groundingSource, googleConfig, runtimeConfig, audit, partnerRuntime, database, toolRegistry }) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/readyz") {
    const google = engine.model?.readiness?.() || { state: googleConfig.readiness, configured: googleConfig.configured, missing: [...googleConfig.missing] };
    const ready = runtimeConfig.mode === "mock" || (google.state === "passed" && google.configured);
    return sendJson(res, ready ? 200 : 503, { ok: ready, mode: engine.model instanceof GeminiRestBackend ? "google_rest" : "mock-only", runtime_mode: runtimeConfig.mode, provider: "Demo evidence", partners: partnerRuntime.projections(), google: { state: google.state, configured: Boolean(google.configured), missing: google.missing || [] }, model_backend: engine.provenance.model_backend.backend, config_state: runtimeConfig.readiness });
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
  if (req.method === "GET" && url.pathname === "/v1/logic/state") return sendJson(res, 200, { schema_version: "logic-host-state@1", mode: "local-mock", no_side_effect_mode: true, tool_readiness: toolRegistry.readiness(), database: { server_id: database.capabilities().server_id, read_only: true, operations: database.listOperations(), private_rows: false, arbitrary_sql: false } });
  if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "documents") return createDocument(req, res, store);
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

export async function startServer({ env = process.env, ...options } = {}) {
  const app = createApp({ ...options, env });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.runtimeConfig.port, app.runtimeConfig.host, resolve);
  });
  let shuttingDown = false;
  const shutdown = async (signal = "shutdown") => {
    if (shuttingDown) return;
    shuttingDown = true;
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
