import crypto from "node:crypto";
import { BRANCH_SCHEMA, CHECKPOINT_KINDS, CHECKPOINT_SCHEMA, LEASE_SCHEMA, TERMINAL_OUTCOME_SCHEMA, WORKFLOW_BRANCH_STATES, WORKFLOW_STATE_SCHEMA, hashContract, isoTimestamp, parseCheckpoint, parseLease, parseTerminalOutcome, safeClone, validateWorkflowState } from "./logic-contracts.js";

export const WORKFLOW_MAX_ATTEMPTS = 2;
export const WORKFLOW_LEASE_MS = 30_000;

export function workflowNow(clock = Date) {
  return new clock().toISOString();
}

export function createWorkflowState({ runId, state = "accepted", phase = "accepted", now = new Date().toISOString(), maxAttempts = WORKFLOW_MAX_ATTEMPTS } = {}) {
  return {
    schema_version: WORKFLOW_STATE_SCHEMA,
    run_id: runId,
    state,
    phase,
    checkpoint_id: null,
    branch_ids: [],
    lease: null,
    retry: { attempt: 0, max_attempts: maxAttempts, last_error: null },
    cancellation: { requested: false, requested_at: undefined, confirmed_at: undefined },
    terminal_outcome: null,
    updated_at: now,
  };
}

export function createBranch({ runId, branchId, kind, now = new Date().toISOString() } = {}) {
  return {
    schema_version: BRANCH_SCHEMA,
    branch_id: branchId,
    run_id: runId,
    kind,
    state: "pending",
    attempt: 0,
    max_attempts: WORKFLOW_MAX_ATTEMPTS,
    checkpoint_id: null,
    started_at: null,
    completed_at: null,
    error: null,
    updated_at: now,
  };
}

export function createLease({ runId, ownerId, now = new Date().toISOString(), ttlMs = WORKFLOW_LEASE_MS } = {}) {
  const acquired = Date.parse(now);
  return {
    schema_version: LEASE_SCHEMA,
    lease_id: `lease_${crypto.randomUUID().replaceAll("-", "")}`,
    owner_id: ownerId,
    acquired_at: new Date(acquired).toISOString(),
    expires_at: new Date(acquired + ttlMs).toISOString(),
    heartbeat_at: new Date(acquired).toISOString(),
  };
}

export function createCheckpoint({ runId, kind, phase, sequence, input, output, status = "complete", now = new Date().toISOString(), payload = {} } = {}) {
  if (!CHECKPOINT_KINDS.includes(kind)) throw new Error(`Unknown checkpoint kind: ${kind}`);
  return parseCheckpoint({
    schema_version: CHECKPOINT_SCHEMA,
    checkpoint_id: `cp_${crypto.randomUUID().replaceAll("-", "")}`,
    run_id: runId,
    kind,
    phase,
    sequence,
    input_hash: typeof input === "string" && input.startsWith("sha256:") ? input : hashContract(input ?? {}),
    output_hash: typeof output === "string" && output.startsWith("sha256:") ? output : output === undefined ? undefined : hashContract(output),
    status,
    created_at: now,
    payload,
  });
}

export function createTerminalOutcome({ outcome, reasonCode, message, result, now = new Date().toISOString(), recoverable = false } = {}) {
  return parseTerminalOutcome({ schema_version: TERMINAL_OUTCOME_SCHEMA, outcome, reason_code: reasonCode, message, at: now, result_hash: result === undefined ? undefined : hashContract(result), recoverable });
}

export function validateBranch(value) {
  if (!value || value.schema_version !== BRANCH_SCHEMA || !WORKFLOW_BRANCH_STATES.includes(value.state)) throw new Error("Invalid workflow branch");
  return value;
}

export function publicWorkflowState(run) {
  const workflow = run?.workflow_state || createWorkflowState({ runId: run?.run_id, state: run?.state, phase: run?.phase, now: run?.updated_at });
  let validated;
  try {
    validated = validateWorkflowState(workflow);
  } catch {
    validated = createWorkflowState({ runId: run?.run_id, state: run?.state || "accepted", phase: run?.phase || "accepted", now: run?.updated_at || new Date().toISOString() });
  }
  return {
    schema_version: WORKFLOW_STATE_SCHEMA,
    run_id: validated.run_id,
    state: validated.state,
    phase: validated.phase,
    checkpoint_id: validated.checkpoint_id,
    branch_ids: [...validated.branch_ids],
    lease: validated.lease ? { lease_id: validated.lease.lease_id, owner_id: "worker", acquired_at: validated.lease.acquired_at, expires_at: validated.lease.expires_at, heartbeat_at: validated.lease.heartbeat_at } : null,
    retry: { attempt: validated.retry.attempt, max_attempts: validated.retry.max_attempts, last_error: validated.retry.last_error ? { code: validated.retry.last_error.code, recoverable: Boolean(validated.retry.last_error.recoverable) } : null },
    cancellation: { requested: validated.cancellation.requested, requested_at: validated.cancellation.requested_at || null, confirmed_at: validated.cancellation.confirmed_at || null },
    terminal_outcome: validated.terminal_outcome ? { outcome: validated.terminal_outcome.outcome, reason_code: validated.terminal_outcome.reason_code, message: validated.terminal_outcome.message, at: validated.terminal_outcome.at, recoverable: validated.terminal_outcome.recoverable } : null,
    updated_at: validated.updated_at,
  };
}

export function publicCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return { schema_version: CHECKPOINT_SCHEMA, checkpoint_id: checkpoint.checkpoint_id, run_id: checkpoint.run_id, kind: checkpoint.kind, phase: checkpoint.phase, sequence: checkpoint.sequence, input_hash: checkpoint.input_hash, output_hash: checkpoint.output_hash || null, status: checkpoint.status, created_at: checkpoint.created_at };
}

export function publicBranch(branch) {
  if (!branch) return null;
  return { schema_version: BRANCH_SCHEMA, branch_id: branch.branch_id, run_id: branch.run_id, kind: branch.kind, state: branch.state, attempt: branch.attempt, max_attempts: branch.max_attempts, checkpoint_id: branch.checkpoint_id, started_at: branch.started_at, completed_at: branch.completed_at, error: branch.error ? { code: branch.error.code, recoverable: Boolean(branch.error.recoverable) } : null, updated_at: branch.updated_at };
}

export { safeClone, parseLease, isoTimestamp };
