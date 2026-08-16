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
import { MockEngine, MockProvider, FakeModel, projectRun } from "./engine.js";
import { GeminiRestBackend, isGeminiReady, normalizeGeminiConfig, readGeminiConfig } from "./gemini-rest.js";
import { FileStore } from "./store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, "..", "web");
const MAX_BODY_BYTES = 128 * 1024;
const TERMINAL = new Set(["needs_input", "succeeded", "canceled", "expired", "failed"]);
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

async function readBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new ContractError("BODY_TOO_LARGE", "Request body is too large");
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

export function createApp({ store, provider, model, dataPath, env = process.env, googleConfig, googleTransport, googleTokenProvider } = {}) {
  const actualStore = store || new FileStore(dataPath);
  const actualProvider = provider || new MockProvider();
  const configuredGoogle = normalizeGeminiConfig(googleConfig || readGeminiConfig(env));
  const actualModel = model || (isGeminiReady(configuredGoogle) ? new GeminiRestBackend({ config: configuredGoogle, transport: googleTransport, tokenProvider: googleTokenProvider }) : new FakeModel());
  const engine = new MockEngine({ store: actualStore, provider: actualProvider, model: actualModel });

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { store: actualStore, engine, googleConfig: configuredGoogle });
    } catch (error) {
      const status = error instanceof ContractError && error.code === "RUN_NOT_FOUND" ? 404 : error instanceof ContractError && ["IDEMPOTENCY_KEY_REUSED", "RUN_NOT_RETRYABLE", "RUN_NOT_CLARIFIABLE", "INVALID_CANDIDATE"].includes(error.code) ? 409 : error instanceof ContractError ? 400 : 500;
      sendError(res, status, error.code || "INTERNAL_ERROR", error instanceof ContractError ? error.message : "The demo server could not complete the request", error.field);
    }
  });
  return { server, store: actualStore, engine, provider: actualProvider, model: actualModel, googleConfig: configuredGoogle };
}

async function route(req, res, { store, engine, googleConfig }) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/readyz") {
    const google = engine.model?.readiness?.() || { state: googleConfig.readiness, configured: googleConfig.configured, missing: [...googleConfig.missing] };
    return sendJson(res, 200, { ok: true, mode: engine.model instanceof GeminiRestBackend ? "google_rest" : "mock-only", provider: "Demo evidence", google: { state: google.state, configured: Boolean(google.configured), missing: google.missing || [] }, model_backend: engine.provenance.model_backend.backend });
  }
  if (req.method === "GET" && url.pathname === "/") return sendStatic(res, "index.html", "text/html; charset=utf-8");
  if (req.method === "GET" && ["/app.js", "/styles.css"].includes(url.pathname)) return sendStatic(res, url.pathname.slice(1), url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return sendError(res, 404, "NOT_FOUND", "Route not found");
  if (req.method === "POST" && parts.length === 2 && parts[1] === "runs") return createRun(req, res, { store, engine });
  if (parts.length >= 3 && parts[1] === "runs") {
    const runId = parts[2];
    if (req.method === "GET" && parts.length === 3) return getRun(res, store, runId);
    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") return streamEvents(req, res, store, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "cancel") return cancelRun(req, res, store, engine, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "retry") return retryRun(req, res, store, engine, runId);
    if (req.method === "POST" && parts.length === 4 && parts[3] === "clarify") return clarifyRun(req, res, store, engine, runId);
    if (req.method === "GET" && parts.length === 5 && parts[3] === "evidence") return getEvidence(res, store, runId, parts[4]);
  }
  return sendError(res, 404, "NOT_FOUND", "Route not found");
}

async function createRun(req, res, { store, engine }) {
  const request = parseRunRequest(await readBody(req));
  const key = parseIdempotencyKey(req.headers["idempotency-key"]);
  const result = store.createRun({ request, requestHash: requestHash(request), idempotencyHash: hashValue(key), provenance: engine.provenance });
  if (result.created) engine.enqueue(result.run.run_id);
  const projection = projectRun(result.run, store);
  return sendJson(res, 202, projection, { location: `/v1/runs/${result.run.run_id}` });
}

function getRun(res, store, runId) {
  const run = store.getRun(runId);
  if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
  return sendJson(res, 200, projectRun(run, store));
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp({ dataPath: process.env.DATA_PATH });
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`Gemini Agents mock workflow listening on http://127.0.0.1:${port}`);
  });
}
