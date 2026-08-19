import fs from "node:fs";
import path from "node:path";
import {
  ContractError,
  EVENT_SCHEMA,
  MAX_EVENTS_PER_RUN,
  PROVENANCE,
  RUN_STATES,
  TERMINAL_STATES,
  assertRunState,
  hashValue,
  nowIso,
  safeId,
} from "./contracts.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return { version: 2, runs: {}, events: {}, evidence: {}, idempotency: {}, documents: {}, scriptRuns: {}, scriptEvents: {}, scriptIdempotency: {}, auditEvents: [] };
}

/** Durable, append-only local store used by the mock worker and local browser slice. */
export class FileStore {
  constructor(filePath = path.resolve(process.cwd(), ".data", "runs.json"), { clock = Date } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.state = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || ![1, 2].includes(parsed.version)) return defaultState();
      return { ...defaultState(), ...parsed, version: 2, documents: parsed.documents || {}, scriptRuns: parsed.scriptRuns || {}, scriptEvents: parsed.scriptEvents || {}, scriptIdempotency: parsed.scriptIdempotency || {}, auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(-5000) : [] };
    } catch {
      return defaultState();
    }
  }

  #persist() {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }

  createRun({ request, requestHash, idempotencyHash, parentRunId = null, retryCount = 0, actor = "anonymous-demo", provenance = PROVENANCE }) {
    const existing = this.state.idempotency[idempotencyHash];
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ContractError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different request");
      }
      return { run: clone(this.state.runs[existing.run_id]), created: false };
    }
    const runId = safeId("run");
    const now = nowIso(this.clock);
    const run = {
      run_id: runId,
      schema_version: "run-record@1",
      request: clone(request),
      request_hash: requestHash,
      idempotency_hash: idempotencyHash,
      parent_run_id: parentRunId,
      retry_count: retryCount,
      actor,
      workflow: "audience_data_readiness",
      provider_mode: provenance?.provider_backend?.backend || "mock",
      model_mode: provenance?.model_backend?.backend || "fake",
      provenance: clone(provenance || PROVENANCE),
      state: "accepted",
      decision: null,
      phase: "accepted",
      created_at: now,
      updated_at: now,
      deadline_at: new Date(Date.now() + 90_000).toISOString(),
      cancellation_requested: false,
      attempt_count: 0,
      clarification: null,
      result: null,
      error: null,
      evidence_ids: [],
      policy_decision: null,
      progress: { completed: 0, total: 0 },
    };
    this.state.runs[runId] = run;
    this.state.events[runId] = [];
    this.state.idempotency[idempotencyHash] = { request_hash: requestHash, run_id: runId, created_at: now };
    this.#persist();
    this.appendEvent(runId, "run.accepted", "intake", "accepted", "Run accepted", { provenance: PROVENANCE.label });
    return { run: clone(run), created: true };
  }

  getRun(runId) {
    return clone(this.state.runs[runId]);
  }

  getEvidence(evidenceId) {
    return clone(this.state.evidence[evidenceId]);
  }

  listEvidence(runId) {
    const run = this.state.runs[runId];
    if (!run) return [];
    return run.evidence_ids.map((id) => this.state.evidence[id]).filter(Boolean).map(clone);
  }

  findByIdempotency(idempotencyHash) {
    const item = this.state.idempotency[idempotencyHash];
    return item ? clone(this.state.runs[item.run_id]) : undefined;
  }

  saveRun(run) {
    if (!run || !this.state.runs[run.run_id]) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    assertRunState(run.state);
    run.updated_at = nowIso(this.clock);
    this.state.runs[run.run_id] = clone(run);
    this.#persist();
    return clone(run);
  }

  transition(runId, state, patch = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    assertRunState(state);
    if (TERMINAL_STATES.has(run.state) && run.state !== state) return clone(run);
    const next = { ...run, ...clone(patch), state, updated_at: nowIso(this.clock) };
    this.state.runs[runId] = next;
    this.#persist();
    return clone(next);
  }

  appendEvent(runId, type, step, state, display, payload = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    const events = this.state.events[runId] || (this.state.events[runId] = []);
    if (events.length >= MAX_EVENTS_PER_RUN) return clone(events.at(-1));
    const event = {
      schema_version: EVENT_SCHEMA,
      run_id: runId,
      seq: events.length + 1,
      type,
      step,
      state,
      display: String(display).slice(0, 240),
      payload: sanitizePayload(payload),
      occurred_at: nowIso(this.clock),
    };
    events.push(event);
    this.#persist();
    return clone(event);
  }

  getEvents(runId, after = 0) {
    return clone((this.state.events[runId] || []).filter((event) => event.seq > after));
  }

  addEvidence(runId, record) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    if (!this.state.evidence[record.evidence_id]) {
      this.state.evidence[record.evidence_id] = clone(record);
      run.evidence_ids.push(record.evidence_id);
      this.state.runs[runId] = run;
      this.#persist();
    }
    return clone(this.state.evidence[record.evidence_id]);
  }

  addResult(runId, result, decision) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    if (TERMINAL_STATES.has(run.state) && run.state !== "succeeded") return clone(run);
    run.result = clone(result);
    run.decision = decision;
    run.policy_decision = clone(result.policy_decision || null);
    run.state = "succeeded";
    run.phase = "succeeded";
    run.updated_at = nowIso(this.clock);
    this.state.runs[runId] = run;
    this.#persist();
    return clone(run);
  }

  markFailed(runId, error) {
    const run = this.state.runs[runId];
    if (!run || TERMINAL_STATES.has(run.state)) return clone(run);
    run.state = "failed";
    run.phase = "failed";
    run.error = {
      class: String(error.class || "failed").slice(0, 60),
      message: String(error.message || "The run could not be completed").slice(0, 300),
      recoverable: Boolean(error.recoverable),
    };
    run.updated_at = nowIso(this.clock);
    this.state.runs[runId] = run;
    this.#persist();
    return clone(run);
  }

  createDocument(document) {
    const existing = this.state.documents[document.document_id];
    if (existing) return { document: clone(existing), created: false };
    this.state.documents[document.document_id] = clone(document);
    this.#persist();
    return { document: clone(document), created: true };
  }

  getDocument(documentId) {
    return clone(this.state.documents[documentId]);
  }

  createScriptRun({ documentId, question, idempotencyHash, parentRunId = null, retryCount = 0, provenance }) {
    const existing = this.state.scriptIdempotency[idempotencyHash];
    if (existing) {
      if (existing.document_id !== documentId || existing.question !== question) throw new ContractError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different grounded brief");
      return { run: clone(this.state.scriptRuns[existing.run_id]), created: false };
    }
    if (!this.state.documents[documentId]) throw new ContractError("DOCUMENT_NOT_FOUND", "Document not found");
    const runId = safeId("script_run");
    const now = nowIso(this.clock);
    const run = {
      run_id: runId,
      schema_version: "grounded-brief-run@1",
      workflow: "grounded_script_brief",
      document_id: documentId,
      question,
      parent_run_id: parentRunId,
      retry_count: retryCount,
      state: "accepted",
      phase: "accepted",
      created_at: now,
      updated_at: now,
      provenance: clone(provenance),
      progress: { stage: "accepted", selected_excerpt_count: 0 },
      result: null,
      error: null,
      citation_ids: [],
    };
    this.state.scriptRuns[runId] = run;
    this.state.scriptEvents[runId] = [];
    this.state.scriptIdempotency[idempotencyHash] = { document_id: documentId, question, run_id: runId, created_at: now };
    this.#persist();
    this.appendScriptEvent(runId, "script.accepted", "intake", "accepted", "Grounded brief accepted", {});
    return { run: clone(run), created: true };
  }

  getScriptRun(runId) {
    return clone(this.state.scriptRuns[runId]);
  }

  getScriptEvents(runId, after = 0) {
    return clone((this.state.scriptEvents[runId] || []).filter((event) => event.seq > after));
  }

  transitionScriptRun(runId, state, patch = {}) {
    const run = this.state.scriptRuns[runId];
    if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
    const terminal = new Set(["succeeded", "grounding_gap", "failed", "canceled"]);
    if (terminal.has(run.state) && run.state !== state) return clone(run);
    const next = { ...run, ...clone(patch), state, updated_at: nowIso(this.clock) };
    this.state.scriptRuns[runId] = next;
    this.#persist();
    return clone(next);
  }

  appendScriptEvent(runId, type, step, state, display, payload = {}) {
    const run = this.state.scriptRuns[runId];
    if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
    const events = this.state.scriptEvents[runId] || (this.state.scriptEvents[runId] = []);
    if (events.length >= MAX_EVENTS_PER_RUN) return clone(events.at(-1));
    const event = {
      schema_version: EVENT_SCHEMA,
      run_id: runId,
      seq: events.length + 1,
      type,
      step,
      state,
      display: String(display).slice(0, 240),
      payload: sanitizePayload(payload),
      occurred_at: nowIso(this.clock),
    };
    events.push(event);
    this.#persist();
    return clone(event);
  }

  addScriptResult(runId, result) {
    const run = this.state.scriptRuns[runId];
    if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
    run.result = clone(result);
    run.citation_ids = (result.citations || []).map((citation) => citation.citation_id);
    run.state = result.status === "grounding_gap" ? "grounding_gap" : "succeeded";
    run.phase = run.state;
    run.updated_at = nowIso(this.clock);
    this.state.scriptRuns[runId] = run;
    this.#persist();
    return clone(run);
  }

  markScriptFailed(runId, error) {
    const run = this.state.scriptRuns[runId];
    if (!run) throw new ContractError("SCRIPT_RUN_NOT_FOUND", "Grounded brief run not found");
    if (["succeeded", "grounding_gap", "failed", "canceled"].includes(run.state)) return clone(run);
    run.state = "failed";
    run.phase = "failed";
    run.error = { class: String(error.class || "failed").slice(0, 60), message: String(error.message || "The grounded brief could not be completed").slice(0, 300), recoverable: Boolean(error.recoverable) };
    run.updated_at = nowIso(this.clock);
    this.state.scriptRuns[runId] = run;
    this.#persist();
    return clone(run);
  }

  appendAuditEvent(event) {
    if (!event || typeof event !== "object") return undefined;
    this.state.auditEvents.push(clone(event));
    if (this.state.auditEvents.length > 5_000) this.state.auditEvents.splice(0, this.state.auditEvents.length - 5_000);
    this.#persist();
    return clone(event);
  }

  getAuditEvents() {
    return clone(this.state.auditEvents);
  }

  count() {
    return Object.keys(this.state.runs).length;
  }
}

function sanitizePayload(value, depth = 0) {
  if (depth > 2) return "[bounded]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? value.slice(0, 500) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizePayload(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      if (/token|secret|password|prompt|raw|payload/i.test(key)) continue;
      result[key] = sanitizePayload(value[key], depth + 1);
    }
    return result;
  }
  return undefined;
}
