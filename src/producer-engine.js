import { ContractError, safeId } from "./contracts.js";
import { buildProducerDecisionPacket, safeProducerPacketProjection } from "./producer-consolidation.js";

const TERMINAL_PRODUCER_RUN_STATES = new Set(["succeeded", "failed"]);

/**
 * ProducerPacketEngine queues one immutable producer packet run per accepted request and executes it off
 * the request path, matching the queued/running/succeeded pattern already used by the audience-readiness
 * and grounded-brief engines. The run's `packet_id` is assigned at creation (content-derived for a first
 * attempt, freshly minted for a retry child) and never changes; once a run reaches `succeeded` or `failed`
 * it is never mutated again. A recoverable failure can only be retried through `retry()`, which always
 * creates a brand-new child run with its own packet_id, a `parent_packet_id` link back to the original,
 * and leaves the original run's result, provenance, and error untouched.
 */
export class ProducerPacketEngine {
  constructor({ store, audit, builder = buildProducerDecisionPacket, provenance } = {}) {
    if (!store) throw new Error("ProducerPacketEngine requires a store");
    this.store = store;
    this.audit = audit;
    this.builder = builder;
    this.provenanceFn = typeof provenance === "function" ? provenance : () => ({ schema_version: "producer-provenance@1", mode: "demo", backend: "local-deterministic-consolidation", external: false, read_only: true });
    this.jobs = new Map();
  }

  provenance() {
    return this.provenanceFn();
  }

  create({ sources, packetId, bundleId = null, bundleManifestHash = null, decisionContext = "" }) {
    const result = this.store.createProducerRun({ packetId, bundleId, bundleManifestHash, decisionContext, sources, provenance: this.provenance() });
    if (result.created) this.enqueue(packetId);
    return result;
  }

  enqueue(packetId) {
    if (this.jobs.has(packetId)) return this.jobs.get(packetId);
    const job = Promise.resolve()
      .then(() => this.execute(packetId))
      .catch((error) => {
        const run = this.store.getProducerRun(packetId);
        if (run && !TERMINAL_PRODUCER_RUN_STATES.has(run.state)) {
          this.store.markProducerRunFailed(packetId, { class: error.code || "producer_packet_failed", message: "The producer packet run stopped safely before a verified result was available.", recoverable: true });
          this.store.appendProducerRunEvent(packetId, "producer_run.failed", "recovery", "failed", "Producer packet run needs recovery", { recoverable: true });
          this.audit?.record({ type: "request_outcome", outcome: "failed", mode: this.provenance()?.backend || "local-deterministic-consolidation", runId: packetId, code: error.code || "producer_packet_failed", attributes: { workflow: "producer_consolidation", recoverable: true } });
        }
        return this.store.getProducerRun(packetId);
      })
      .finally(() => this.jobs.delete(packetId));
    this.jobs.set(packetId, job);
    return job;
  }

  async waitForIdle(packetId) {
    const job = this.jobs.get(packetId);
    if (job) await job;
    return this.store.getProducerRun(packetId);
  }

  async retry(packetId) {
    const run = this.store.getProducerRun(packetId);
    if (!run) throw new ContractError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet run not found");
    if (run.state !== "failed") throw new ContractError("PRODUCER_PACKET_NOT_RETRYABLE", "Only a failed producer packet run can be retried; this run is already terminal", "packet_id");
    const childPacketId = `packet_${safeId("retry").split("_")[1]}`;
    const child = this.store.createProducerRun({
      packetId: childPacketId,
      bundleId: run.bundle_id,
      bundleManifestHash: run.bundle_manifest_hash,
      decisionContext: run.decision_context,
      sources: run.sources,
      parentPacketId: packetId,
      retryCount: (run.retry_count || 0) + 1,
      provenance: this.provenance(),
    }).run;
    this.enqueue(child.packet_id);
    return child;
  }

  async execute(packetId) {
    let run = this.store.getProducerRun(packetId);
    if (!run || TERMINAL_PRODUCER_RUN_STATES.has(run.state)) return run;
    run = this.store.transitionProducerRun(packetId, "queued", { phase: "queued", progress: { stage: "queued" } });
    this.store.appendProducerRunEvent(packetId, "producer_run.queued", "queue", "queued", "Producer packet run queued", { source_count: run.sources.length });
    run = this.store.transitionProducerRun(packetId, "running", { phase: "reconciling", progress: { stage: "reconciling" } });
    this.store.appendProducerRunEvent(packetId, "producer_run.reconciling", "reconcile", "running", "Reconciling supplied sources", { bundle_id: run.bundle_id });
    const packet = this.builder(run.sources, {
      bundleId: run.bundle_id || undefined,
      bundleManifestHash: run.bundle_manifest_hash || undefined,
      decisionContext: run.decision_context || "",
      overridePacketId: packetId,
    });
    this.store.appendProducerRunEvent(packetId, "producer_run.verifying", "verify", "running", "Checking citation IDs and safe fields", { citation_count: packet.citations?.length || 0 });
    this.store.addProducerRunResult(packetId, packet);
    this.store.appendProducerRunEvent(packetId, "producer_run.succeeded", "projection", "succeeded", "Producer packet ready", { citation_count: packet.citations?.length || 0 });
    this.audit?.record({ type: "request_outcome", outcome: "succeeded", mode: this.provenance()?.backend || "local-deterministic-consolidation", runId: packetId, attributes: { workflow: "producer_consolidation" } });
    return this.store.getProducerRun(packetId);
  }
}

/** Project a producer packet run for the safe HTTP surface: the terminal packet body once succeeded, or a
 * bounded pending/failed progress projection while the run is still active or after a recoverable failure.
 */
export function projectProducerRun(run, store) {
  if (!run) return undefined;
  const events = store.getProducerRunEvents(run.packet_id);
  const lastEventSeq = events.at(-1)?.seq || 0;
  if (run.state === "succeeded") {
    const packet = store.getProducerPacket(run.packet_id);
    return { ...safeProducerPacketProjection(packet), state: run.state, phase: run.phase, retry_count: run.retry_count || 0, parent_packet_id: run.parent_packet_id || null, last_event_seq: lastEventSeq, recovery: null };
  }
  return {
    schema_version: run.schema_version,
    workflow: "producer_consolidation",
    status: run.state === "failed" ? "failed" : "pending",
    state: run.state,
    phase: run.phase,
    packet_id: run.packet_id,
    bundle_id: run.bundle_id || null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    last_event_seq: lastEventSeq,
    progress: run.progress,
    result: null,
    parent_packet_id: run.parent_packet_id || null,
    retry_count: run.retry_count || 0,
    provenance: run.provenance || null,
    recovery: run.error ? { recoverable: run.error.recoverable, message: run.error.message, actions: run.error.recoverable ? ["retry"] : [] } : null,
    limitations: ["This producer packet run has not reached a terminal state.", "No booking, approval, permission, safety clearance, rights conclusion, or budget total is produced by this run."],
  };
}
