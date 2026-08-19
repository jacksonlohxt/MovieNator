import fs from "node:fs";
import path from "node:path";
import {
  ContractError,
  EVENT_SCHEMA,
  MAX_EVENTS_PER_RUN,
  PROVENANCE,
  RUN_STATES,
  ACTIVE_STATES,
  TERMINAL_STATES,
  assertRunState,
  hashValue,
  nowIso,
  safeId,
} from "./contracts.js";
import {
  WORKFLOW_LEASE_MS,
  createBranch,
  createCheckpoint,
  createLease,
  createTerminalOutcome,
  createWorkflowState,
  publicBranch,
  publicCheckpoint,
  publicWorkflowState,
  validateBranch,
} from "./workflow-state.js";
import { WORKFLOW_BRANCH_STATES, hashContract } from "./logic-contracts.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return { version: 3, runs: {}, events: {}, evidence: {}, idempotency: {}, documents: {}, scriptRuns: {}, scriptEvents: {}, scriptIdempotency: {}, auditEvents: [] };
}

function ensureWorkflowFields(run, clock = Date) {
  if (!run) return run;
  const now = run.updated_at || nowIso(clock);
  if (!run.workflow_state) run.workflow_state = createWorkflowState({ runId: run.run_id, state: run.state, phase: run.phase || run.state, now });
  if (!run.branches) run.branches = {};
  if (!run.checkpoints) run.checkpoints = [];
  if (!Object.hasOwn(run, "terminal_outcome")) run.terminal_outcome = null;
  return run;
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
      if (!parsed || ![1, 2, 3].includes(parsed.version)) return defaultState();
      return { ...defaultState(), ...parsed, version: 3, documents: parsed.documents || {}, scriptRuns: parsed.scriptRuns || {}, scriptEvents: parsed.scriptEvents || {}, scriptIdempotency: parsed.scriptIdempotency || {}, auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents.slice(-5000) : [] };
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
      workflow_state: createWorkflowState({ runId, state: "accepted", phase: "accepted", now }),
      branches: {},
      checkpoints: [],
      terminal_outcome: null,
    };
    this.state.runs[runId] = run;
    this.state.events[runId] = [];
    this.state.idempotency[idempotencyHash] = { request_hash: requestHash, run_id: runId, created_at: now };
    this.#persist();
    this.appendEvent(runId, "run.accepted", "intake", "accepted", "Run accepted", { provenance: PROVENANCE.label });
    return { run: clone(run), created: true };
  }

  getRun(runId) {
    const run = this.state.runs[runId];
    if (!run) return undefined;
    ensureWorkflowFields(run, this.clock);
    return clone(run);
  }

  listRuns({ states } = {}) {
    const allowed = states ? new Set(states) : null;
    return Object.values(this.state.runs).filter((run) => !allowed || allowed.has(run.state)).map((run) => clone(ensureWorkflowFields(run, this.clock)));
  }

  listActiveRuns() {
    return this.listRuns({ states: [...ACTIVE_STATES] });
  }

  getWorkflowState(runId) {
    const run = this.state.runs[runId];
    if (!run) return undefined;
    ensureWorkflowFields(run, this.clock);
    return clone(run.workflow_state);
  }

  getCheckpoints(runId) {
    const run = this.state.runs[runId];
    return run ? clone(ensureWorkflowFields(run, this.clock).checkpoints || []) : [];
  }

  getBranches(runId) {
    const run = this.state.runs[runId];
    return run ? clone(ensureWorkflowFields(run, this.clock).branches || {}) : {};
  }

  saveCheckpoint(runId, { kind, phase, input, output, status = "complete", payload = {} } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const inputHash = typeof input === "string" && input.startsWith("sha256:") ? input : hashContract(input ?? {});
    const existing = run.checkpoints.find((checkpoint) => checkpoint.kind === kind && checkpoint.input_hash === inputHash && checkpoint.status === status);
    if (existing) return clone(existing);
    const checkpoint = createCheckpoint({ runId, kind, phase, sequence: run.checkpoints.length + 1, input: inputHash, output, status, now: nowIso(this.clock), payload });
    run.checkpoints.push(checkpoint);
    run.workflow_state.checkpoint_id = checkpoint.checkpoint_id;
    run.workflow_state.state = run.state;
    run.workflow_state.phase = phase;
    run.workflow_state.updated_at = nowIso(this.clock);
    run.updated_at = run.workflow_state.updated_at;
    this.state.runs[runId] = run;
    this.#persist();
    return clone(checkpoint);
  }

  upsertBranch(runId, branchId, patch = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const now = nowIso(this.clock);
    const existing = run.branches[branchId] || createBranch({ runId, branchId, kind: patch.kind || branchId, now });
    const next = { ...existing, ...clone(patch), branch_id: branchId, run_id: runId, updated_at: now };
    if (!WORKFLOW_BRANCH_STATES.includes(next.state)) throw new ContractError("INVALID_BRANCH_STATE", `Unknown branch state: ${next.state}`);
    if (next.state === "running" && !next.started_at) next.started_at = now;
    if (["succeeded", "failed", "timed_out", "canceled", "skipped"].includes(next.state) && !next.completed_at) next.completed_at = now;
    validateBranch(next);
    run.branches[branchId] = next;
    if (!run.workflow_state.branch_ids.includes(branchId)) run.workflow_state.branch_ids.push(branchId);
    run.workflow_state.updated_at = now;
    run.updated_at = now;
    this.state.runs[runId] = run;
    this.#persist();
    return clone(next);
  }

  acquireLease(runId, ownerId, { ttlMs = WORKFLOW_LEASE_MS } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const now = nowIso(this.clock);
    const current = run.workflow_state.lease;
    if (current && Date.parse(current.expires_at) > Date.parse(now) && current.owner_id !== ownerId) return null;
    const lease = current && current.owner_id === ownerId ? { ...current, expires_at: new Date(Date.parse(now) + ttlMs).toISOString(), heartbeat_at: now } : createLease({ runId, ownerId, now, ttlMs });
    run.workflow_state.lease = lease;
    run.workflow_state.updated_at = now;
    run.updated_at = now;
    this.state.runs[runId] = run;
    this.#persist();
    return clone(lease);
  }

  renewLease(runId, ownerId, { ttlMs = WORKFLOW_LEASE_MS } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const lease = run.workflow_state.lease;
    const now = nowIso(this.clock);
    if (!lease || lease.owner_id !== ownerId || Date.parse(lease.expires_at) <= Date.parse(now)) return null;
    lease.expires_at = new Date(Date.parse(now) + ttlMs).toISOString();
    lease.heartbeat_at = now;
    run.workflow_state.updated_at = now;
    run.updated_at = now;
    this.#persist();
    return clone(lease);
  }

  releaseLease(runId, ownerId) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    if (run.workflow_state.lease && (!ownerId || run.workflow_state.lease.owner_id === ownerId)) {
      run.workflow_state.lease = null;
      run.workflow_state.updated_at = nowIso(this.clock);
      run.updated_at = run.workflow_state.updated_at;
      this.state.runs[runId] = run;
      this.#persist();
    }
    return clone(run.workflow_state.lease);
  }

  requestCancellation(runId) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const now = nowIso(this.clock);
    run.cancellation_requested = true;
    run.workflow_state.cancellation = { requested: true, requested_at: run.workflow_state.cancellation.requested_at || now, confirmed_at: run.workflow_state.cancellation.confirmed_at };
    run.workflow_state.updated_at = now;
    run.updated_at = now;
    this.state.runs[runId] = run;
    this.#persist();
    return clone(run);
  }

  setTerminalOutcome(runId, outcome, { reasonCode = "terminal", message = "Run reached a terminal outcome", result, recoverable = false } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    ensureWorkflowFields(run, this.clock);
    const now = nowIso(this.clock);
    run.terminal_outcome = createTerminalOutcome({ outcome, reasonCode, message, result, now, recoverable });
    run.workflow_state.terminal_outcome = run.terminal_outcome;
    run.workflow_state.state = run.state;
    run.workflow_state.phase = run.phase || run.state;
    run.workflow_state.lease = null;
    if (outcome === "canceled") run.workflow_state.cancellation.confirmed_at = now;
    run.workflow_state.updated_at = now;
    run.updated_at = now;
    this.state.runs[runId] = run;
    this.#persist();
    return clone(run.terminal_outcome);
  }

  recoverExpiredLeases() {
    const now = Date.parse(nowIso(this.clock));
    let count = 0;
    for (const run of Object.values(this.state.runs)) {
      ensureWorkflowFields(run, this.clock);
      if (run.workflow_state.lease && Date.parse(run.workflow_state.lease.expires_at) <= now) {
        run.workflow_state.lease = null;
        run.workflow_state.updated_at = new Date(now).toISOString();
        run.updated_at = run.workflow_state.updated_at;
        count += 1;
      }
    }
    if (count) this.#persist();
    return count;
  }

  workflowProjection(runId) {
    const run = this.state.runs[runId];
    if (!run) return undefined;
    ensureWorkflowFields(run, this.clock);
    return { state: publicWorkflowState(run), checkpoints: run.checkpoints.map(publicCheckpoint), branches: Object.values(run.branches).map(publicBranch) };
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
    ensureWorkflowFields(run, this.clock);
    const now = nowIso(this.clock);
    const next = { ...run, ...clone(patch), state, updated_at: now };
    next.workflow_state = { ...next.workflow_state, state, phase: next.phase || state, updated_at: now };
    if (next.cancellation_requested) next.workflow_state.cancellation = { ...next.workflow_state.cancellation, requested: true, requested_at: next.workflow_state.cancellation.requested_at || now };
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
    this.setTerminalOutcome(runId, "succeeded", { reasonCode: "result_published", message: "Verified result published", result });
    return clone(this.state.runs[runId]);
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
    this.setTerminalOutcome(runId, "failed", { reasonCode: run.error.class, message: run.error.message, recoverable: run.error.recoverable });
    return clone(this.state.runs[runId]);
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
