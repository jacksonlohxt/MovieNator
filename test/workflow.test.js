import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "../src/store.js";
import { FakeModel, MockEngine, MockProvider, READINESS_POLICY, evaluatePolicy } from "../src/engine.js";
import { ContractError, parseRunRequest } from "../src/contracts.js";
import { createApp } from "../src/server.js";
import { BoundedFunctionOrchestrator } from "../src/orchestrator.js";
import { ToolRegistry, createToolManifest } from "../src/tool-registry.js";

function tempStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-"));
  return new FileStore(path.join(directory, "runs.json"));
}

function requestFor(assetHint) {
  return { schema_version: "run-request@1", problem_statement: "Is this audience asset ready for marketing planning?", asset_hint: assetHint, purpose: "marketing planning" };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runFixture(assetHint, options = {}) {
  const store = tempStore();
  const engine = new MockEngine({ store, ...options });
  const request = requestFor(assetHint);
  const created = store.createRun({ request, requestHash: assetHint, idempotencyHash: assetHint }).run;
  await engine.enqueue(created.run_id);
  return { store, engine, run: store.getRun(created.run_id) };
}

test("request contract is strict and does not accept client authority fields", () => {
  assert.throws(() => parseRunRequest({ ...requestFor("ready"), provider: "google" }), (error) => error.code === "UNKNOWN_FIELD");
  for (const field of ["endpoint", "tool", "model", "threshold", "approved", "publish", "sql", "approval"]) {
    assert.throws(() => parseRunRequest({ ...requestFor("ready"), [field]: true }), (error) => error.code === "UNKNOWN_FIELD", field);
  }
  assert.throws(() => parseRunRequest({ ...requestFor("ready"), media_context: { unknown: "no" } }), (error) => error.code === "UNKNOWN_FIELD");
  assert.throws(() => parseRunRequest({ ...requestFor("ready"), time_window: { start: "2026-01-01T00:00:00Z", end: "2027-12-31T00:00:00Z" } }), (error) => error.code === "TIME_WINDOW_TOO_LARGE");
  const valid = parseRunRequest(requestFor("ready"));
  assert.equal(valid.schema_version, "run-request@1");
});

test("deterministic policy owns READY, REVIEW, BLOCKED, and UNKNOWN", () => {
  const base = (kind, status, facts = {}) => ({ evidence_id: `ev_${kind}`, check_kind: kind, status, facts });
  const complete = [base("asset", "complete", { asset_id: "a" }), base("quality", "complete", { completeness: 99, validity: 99 }), base("governance", "complete", { approved_purpose: true }), base("lineage", "complete", { truncated: false })];
  assert.equal(evaluatePolicy(complete).decision, "READY");
  assert.equal(evaluatePolicy([...complete.slice(0, 3), base("lineage", "timed_out")]).decision, "REVIEW");
  assert.equal(evaluatePolicy([...complete.slice(0, 2), base("governance", "complete", { hard_stop_code: "GOVERNANCE_HARD_STOP" }), complete[3]]).decision, "BLOCKED");
  assert.equal(evaluatePolicy([base("asset", "missing")]).decision, "UNKNOWN");
  assert.equal(evaluatePolicy(complete, { policy: READINESS_POLICY }).schema_version, "policy-decision@1");
});

test("mock engine completes pass, review, unknown, and clarification without downstream calls before selection", async () => {
  const pass = await runFixture("season_2_audience_engagement");
  assert.equal(pass.run.state, "succeeded");
  assert.equal(pass.run.decision, "READY");
  assert.equal(pass.store.listEvidence(pass.run.run_id).length, 4);
  assert.equal(pass.store.listEvidence(pass.run.run_id).every((item) => item.provenance === "Deterministic mock / Demo evidence"), true);

  const review = await runFixture("season_2_campaign_audience");
  assert.equal(review.run.decision, "REVIEW");
  assert.equal(review.store.listEvidence(review.run.run_id).find((item) => item.check_kind === "governance").status, "missing");

  const unknown = await runFixture("unknown_asset");
  assert.equal(unknown.run.decision, "UNKNOWN");
  assert.equal(unknown.run.result.checks.find((item) => item.check_kind === "asset").evidence_id, undefined);
  assert.equal(unknown.engine.provider.calls.some((call) => call.operation === "read_quality"), false);

  const provider = new MockProvider();
  const clarify = await runFixture("ambiguous_asset", { provider });
  assert.equal(clarify.run.state, "needs_input");
  assert.equal(clarify.run.terminal_outcome.outcome, "needs_input");
  assert.equal(clarify.run.clarification.candidates.length, 2);
  assert.deepEqual(provider.calls.map((call) => call.operation), ["resolve_asset"]);
  const child = await clarify.engine.clarify(clarify.run.run_id, "season_2_audience_engagement");
  await clarify.engine.waitForIdle(child.run_id);
  assert.equal(clarify.store.getRun(child.run_id).decision, "READY");
  assert.equal(clarify.store.getRun(child.run_id).parent_run_id, clarify.run.run_id);
  assert.equal(clarify.store.getRun(clarify.run.run_id).state, "needs_input");
});

test("startup reclaims persisted active leases and resumes the run", async () => {
  const store = tempStore();
  const request = requestFor("season_2_audience_engagement");
  const run = store.createRun({ request, requestHash: "restart", idempotencyHash: "restart" }).run;
  store.acquireLease(run.run_id, "stopped-worker", { ttlMs: 10 });
  const engine = new MockEngine({ store });
  engine.resumeActive();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await engine.waitForIdle(run.run_id);
  assert.equal(store.getRun(run.run_id).state, "succeeded");
});

test("active workflow leases renew during long-running provider work", async () => {
  const store = tempStore();
  const run = store.createRun({ request: requestFor("season_2_audience_engagement"), requestHash: "lease-renewal", idempotencyHash: "lease-renewal" }).run;
  let leaseBefore;
  let leaseAfter;
  class SlowProvider extends MockProvider {
    async resolve_asset(...args) {
      leaseBefore = store.getWorkflowState(run.run_id).lease;
      await sleep(45);
      leaseAfter = store.getWorkflowState(run.run_id).lease;
      return super.resolve_asset(...args);
    }
  }
  const engine = new MockEngine({ store, provider: new SlowProvider(), leaseTtlMs: 20, leaseRenewIntervalMs: 5 });
  await engine.enqueue(run.run_id);
  assert.equal(store.getRun(run.run_id).state, "succeeded");
  assert.notEqual(leaseBefore?.heartbeat_at, leaseAfter?.heartbeat_at);
});

test("lease expiry fences a stale worker before duplicate evidence or publication", async () => {
  let nowMs = Date.parse("2026-08-20T00:00:00.000Z");
  class ManualClock extends Date {
    constructor(value) { super(value === undefined ? nowMs : value); }
    static now() { return nowMs; }
  }
  let releaseDescribe;
  const describeGate = new Promise((resolve) => { releaseDescribe = resolve; });
  let describeStarted;
  const describeStartedPromise = new Promise((resolve) => { describeStarted = resolve; });
  class PausingProvider extends MockProvider {
    constructor() { super(); this.describeCalls = 0; }
    async describe_asset(...args) {
      this.describeCalls += 1;
      if (this.describeCalls === 1) {
        describeStarted();
        await describeGate;
      }
      return super.describe_asset(...args);
    }
  }
  const store = new FileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-lease-fence-")), "runs.json"), { clock: ManualClock });
  const provider = new PausingProvider();
  const run = store.createRun({ request: requestFor("season_2_audience_engagement"), requestHash: "lease-fence", idempotencyHash: "lease-fence" }).run;
  const stale = new MockEngine({ store, provider, clock: ManualClock, leaseTtlMs: 10, leaseRenewIntervalMs: 1_000 });
  stale.ownerId = "stale-owner";
  const staleJob = stale.enqueue(run.run_id);
  await describeStartedPromise;

  nowMs += 11;
  const replacement = new MockEngine({ store, provider, clock: ManualClock, leaseTtlMs: 10, leaseRenewIntervalMs: 1_000 });
  replacement.ownerId = "replacement-owner";
  replacement.resumeActive();
  for (let attempt = 0; attempt < 100 && store.listEvidence(run.run_id).length < 1; attempt += 1) await sleep(2);
  assert.equal(store.getWorkflowState(run.run_id).lease.owner_id, "replacement-owner");
  releaseDescribe();
  await Promise.all([staleJob, replacement.waitForIdle(run.run_id)]);

  assert.equal(store.getRun(run.run_id).state, "succeeded");
  assert.equal(store.listEvidence(run.run_id).length, 4);
  assert.equal(new Set(store.listEvidence(run.run_id).map((record) => record.check_kind)).size, 4);
  assert.equal(store.getEvents(run.run_id).filter((event) => event.type === "run.succeeded").length, 1);
});

test("tool time and call budgets are bounded by orchestration and run", async () => {
  const registry = new ToolRegistry();
  registry.register({
    manifest: createToolManifest({
      toolId: "fixture.read",
      operations: ["read"],
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] },
      timeoutMs: 1000,
      maxCalls: 1,
    }),
    handler: async ({ signal }) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: "late" }), 100);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({ status: "aborted" });
      }, { once: true });
    }),
  });
  const proposal = { schema_version: "tool-call-proposal@1", calls: [{ call_id: "read_once", tool_id: "fixture.read", operation: "read", arguments: {} }] };
  const orchestrator = new BoundedFunctionOrchestrator({ registry, maxTotalMs: 10 });
  const timedOut = await orchestrator.executeProposal(proposal, { run_id: "run-a" });
  assert.equal(timedOut.results[0].error.code, "TOOL_TIMEOUT");
  const exhausted = await registry.execute({ toolId: "fixture.read", operation: "read", input: {}, context: { run_id: "run-a" } });
  assert.equal(exhausted.error.code, "TOOL_BUDGET_EXHAUSTED");
  const nextRun = await registry.execute({ toolId: "fixture.read", operation: "read", input: {}, context: { run_id: "run-b" }, timeoutMs: 10 });
  assert.equal(nextRun.error.code, "TOOL_TIMEOUT");
});

test("tool idempotency separates authorized tools and operations", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  const outputSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] };
  for (const toolId of ["fixture.alpha", "fixture.beta"]) {
    registry.register({
      manifest: createToolManifest({ toolId, operations: toolId === "fixture.alpha" ? ["read", "inspect"] : ["read"], inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema, maxCalls: 10 }),
      handler: async () => { calls += 1; return { status: "ok" }; },
    });
  }
  const orchestrator = new BoundedFunctionOrchestrator({ registry });
  const proposal = (toolId, operation) => ({ schema_version: "tool-call-proposal@1", calls: [{ call_id: "same_call", tool_id: toolId, operation, arguments: {} }] });
  const first = await orchestrator.executeProposal(proposal("fixture.alpha", "read"), { run_id: "cache-run" });
  const second = await orchestrator.executeProposal(proposal("fixture.alpha", "inspect"), { run_id: "cache-run" });
  const third = await orchestrator.executeProposal(proposal("fixture.beta", "read"), { run_id: "cache-run" });
  assert.equal(first.results[0].duplicate, undefined);
  assert.equal(second.results[0].duplicate, undefined);
  assert.equal(third.results[0].duplicate, undefined);
  assert.equal(calls, 3);
});

test("tool budget scopes use bounded eviction", async () => {
  const registry = new ToolRegistry({ maxBudgetScopes: 2 });
  registry.register({
    manifest: createToolManifest({ toolId: "fixture.eviction", operations: ["read"], inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string" } }, required: ["status"] }, maxCalls: 1 }),
    handler: async () => ({ status: "ok" }),
  });
  const execute = (run_id) => registry.execute({ toolId: "fixture.eviction", operation: "read", input: {}, context: { run_id } });
  assert.equal((await execute("run-a")).status, "succeeded");
  assert.equal((await execute("run-b")).status, "succeeded");
  assert.equal((await execute("run-a")).error.code, "TOOL_BUDGET_EXHAUSTED");
  assert.equal((await execute("run-c")).status, "succeeded");
  assert.equal((await execute("run-a")).status, "succeeded");
});

test("bounded recovery preserves original and retry creates a successful child", async () => {
  const result = await runFixture("recovery_demo");
  assert.equal(result.run.state, "failed");
  assert.equal(result.run.error.recoverable, true);
  const child = await result.engine.retry(result.run.run_id);
  await result.engine.waitForIdle(child.run_id);
  const childRun = result.store.getRun(child.run_id);
  assert.equal(childRun.state, "succeeded");
  assert.equal(childRun.decision, "READY");
  assert.equal(childRun.parent_run_id, result.run.run_id);
  assert.equal(result.store.getRun(result.run.run_id).state, "failed");
});

test("writer output is verified and unsafe fake output falls back to deterministic template", async () => {
  const result = await runFixture("season_2_audience_engagement", { model: new FakeModel({ failDraft: true }) });
  assert.equal(result.run.state, "succeeded");
  assert.equal(result.run.result.decision, "READY");
  assert.equal(result.run.result.headline, "Data readiness: READY");
  assert.equal(result.run.result.summary.includes("<"), false);
  assert.equal(result.run.result.recommendations.length <= 3, true);

  class UnsafeProvider extends MockProvider {
    async read_quality() {
      return { status: "complete", facts: { source: "https://not-approved.example/row" }, units: {}, source_reference: "<script>unsafe</script>" };
    }
  }
  const unsafe = await runFixture("season_2_audience_engagement", { provider: new UnsafeProvider() });
  assert.equal(unsafe.run.state, "succeeded");
  assert.equal(unsafe.run.result.decision, "REVIEW");
  assert.equal(JSON.stringify(unsafe.run.result).includes("https://"), false);
  assert.equal(JSON.stringify(unsafe.run.result).includes("<script>"), false);
});

test("cancellation wins over queued work and publishes no late result", async () => {
  const store = tempStore();
  const engine = new MockEngine({ store });
  const request = requestFor("season_2_audience_engagement");
  const run = store.createRun({ request, requestHash: "cancel", idempotencyHash: "cancel" }).run;
  engine.enqueue(run.run_id);
  const canceled = engine.requestCancel(run.run_id);
  assert.equal(canceled.state, "canceled");
  await engine.waitForIdle(run.run_id);
  const finalRun = store.getRun(run.run_id);
  assert.equal(finalRun.state, "canceled");
  assert.equal(finalRun.result, null);
  assert.equal(store.listEvidence(run.run_id).length, 0);
});

test("HTTP API is durable, idempotent, safe, and event-readable", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-http-"));
  const app = createApp({ dataPath: path.join(directory, "runs.json") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const body = requestFor("season_2_audience_engagement");
  const headers = { "content-type": "application/json", "Idempotency-Key": "same-key" };
  const first = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(first.status, 202);
  const firstProjection = await first.json();
  const duplicate = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(duplicate.status, 202);
  const duplicateProjection = await duplicate.json();
  assert.equal(duplicateProjection.run_id, firstProjection.run_id);
  const reused = await fetch(`${base}/v1/runs`, { method: "POST", headers, body: JSON.stringify({ ...body, purpose: "different" }) });
  assert.equal(reused.status, 409);
  const forbidden = await fetch(`${base}/v1/runs`, { method: "POST", headers: { ...headers, "Idempotency-Key": "forbidden" }, body: JSON.stringify({ ...body, publish: true }) });
  assert.equal(forbidden.status, 400);

  await app.engine.waitForIdle(firstProjection.run_id);
  const projection = await fetch(`${base}/v1/runs/${firstProjection.run_id}`);
  const result = await projection.json();
  assert.equal(result.status, "READY");
  const eventResponse = await fetch(`${base}/v1/runs/${firstProjection.run_id}/events`);
  const eventText = await eventResponse.text();
  assert.match(eventText, /run\.accepted/);
  assert.match(eventText, /run\.succeeded/);
  assert.match(eventText, /Deterministic mock/);
  const evidenceId = result.result.checks.find((item) => item.check_kind === "quality").evidence_id;
  const evidenceResponse = await fetch(`${base}/v1/runs/${firstProjection.run_id}/evidence/${evidenceId}`);
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.source_label, "Demo evidence");
  assert.equal(Object.hasOwn(evidence, "source_reference"), false);
});
