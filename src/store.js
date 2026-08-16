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
  return { version: 1, runs: {}, events: {}, evidence: {}, idempotency: {} };
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
      if (!parsed || parsed.version !== 1) return defaultState();
      return { ...defaultState(), ...parsed };
    } catch {
      return defaultState();
    }
  }

  #persist() {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }

  createRun({ request, requestHash, idempotencyHash, parentRunId = null, retryCount = 0, actor = "anonymous-demo" }) {
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
      provider_mode: "mock",
      model_mode: "fake",
      provenance: clone(PROVENANCE),
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
