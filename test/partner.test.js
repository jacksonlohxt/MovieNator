import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IbmCompatibleReadOnlyAdapter } from "../src/partner-adapter.js";
import { createDefaultPartnerRegistry } from "../src/partner-defaults.js";
import { FileStore } from "../src/store.js";
import { MockEngine } from "../src/engine.js";
import { LocalMockPartnerAdapter } from "../src/partner-mock.js";
import { PartnerRegistry } from "../src/partner-registry.js";
import { PartnerOperationRunner } from "../src/partner-runtime.js";
import { PartnerContractError, assertReadOnlyOperation, createPartnerCapability, partnerReadiness } from "../src/partner-contracts.js";
import { MockSecretProvider } from "../src/secrets.js";
import { createApp } from "../src/server.js";
import { LEGACY_LOCAL_MOCK_ENDPOINTS, LOCAL_MOCK_ENDPOINT } from "../src/product-identity.js";

function registryFor(adapter, endpoints = [LOCAL_MOCK_ENDPOINT]) {
  const registry = new PartnerRegistry({ endpointAllowlist: endpoints });
  registry.register({ capability: adapter.capabilities(), adapter });
  return registry;
}

test("legacy local mock endpoint remains an allowlisted compatibility alias", () => {
  assert.equal(new PartnerRegistry().endpointAllowlist.has(LEGACY_LOCAL_MOCK_ENDPOINTS[0]), true);
});

function liveOptions(overrides = {}) {
  return {
    provider: { provider_id: "partner.ibm.pending", display_name: "IBM-compatible candidate", product_ref: "unconfirmed", confirmation_state: "pending" },
    endpointRef: "config://partners/ibm/pending",
    authMode: "oauth2_client_credentials",
    allowedOperations: [{ operation: "read_metadata", tool_ref: "pending.read_metadata", data_class: "metadata" }],
    scopeRef: "config://scope/synthetic",
    ...overrides,
  };
}

test("unknown provider, endpoint, tool, and capability fail before adapter use", async () => {
  const adapter = new LocalMockPartnerAdapter();
  const registry = registryFor(adapter);
  const runtime = new PartnerOperationRunner({ registry, timeoutMs: 100 });
  await assert.rejects(runtime.execute({ providerId: "unknown.provider", operation: "read_metadata" }), (error) => error.code === "UNKNOWN_PROVIDER");
  await assert.rejects(runtime.execute({ providerId: "mock-provider", operation: "publish" }), (error) => error.code === "UNKNOWN_CAPABILITY");
  assert.equal(adapter.calls.length, 0);
  assert.throws(() => registry.assertOperation("mock-provider", "read_metadata", { toolRef: "unregistered.tool" }), (error) => error.code === "UNKNOWN_TOOL");
  assert.throws(() => registry.assertEndpoint("mock-provider", "config://unapproved/live"), (error) => error.code === "ENDPOINT_NOT_ALLOWLISTED");
});

test("the capability contract accepts only explicitly registered read-only operations", () => {
  assertReadOnlyOperation("read_metadata");
  assertReadOnlyOperation("search_lineage");
  assert.throws(() => assertReadOnlyOperation("publish"), (error) => error.code === "UNKNOWN_CAPABILITY");
  assert.throws(() => createPartnerCapability({
    provider: { provider_id: "bad-provider", display_name: "Bad" },
    environment: "local",
    endpointRef: LOCAL_MOCK_ENDPOINT,
    authMode: "none_synthetic",
    allowedOperations: [{ operation: "write_metadata", tool_ref: "write_metadata", data_class: "metadata" }],
    dataClasses: ["metadata"],
  }), (error) => error.code === "UNKNOWN_CAPABILITY" || error.code === "MUTATING_OPERATION");
});

test("local mock partner can be injected into the existing readiness evidence seam", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-adapter-engine-"));
  const store = new FileStore(path.join(directory, "runs.json"));
  const provider = new LocalMockPartnerAdapter();
  const engine = new MockEngine({ store, provider });
  const request = { schema_version: "run-request@1", problem_statement: "Is the audience asset ready?", asset_hint: "season_2_audience_engagement" };
  const run = store.createRun({ request, requestHash: "adapter-engine", idempotencyHash: "adapter-engine", provenance: engine.provenance }).run;
  await engine.enqueue(run.run_id);
  assert.equal(store.getRun(run.run_id).decision, "READY");
  assert.deepEqual(provider.calls.map((call) => call.operation), ["resolve_asset", "describe_asset", "read_quality", "read_governance", "read_lineage"]);
});

test("local mock partner is credential-free and deterministic across evidence classes", async () => {
  const adapter = new LocalMockPartnerAdapter();
  const registry = registryFor(adapter);
  const runtime = new PartnerOperationRunner({ registry });
  const result = await runtime.execute({ providerId: "mock-provider", operation: "resolve_asset", input: { query: "season_2_audience_engagement" }, deliveryId: "delivery-1" });
  assert.equal(result.status, "complete");
  assert.equal(result.data.asset.asset_id, "asset_demo_001");
  assert.equal(result.provenance.redacted, true);
  assert.equal(adapter.readiness().state, "ready");
  const telemetry = await runtime.execute({ providerId: "mock-provider", operation: "read_telemetry", input: {}, deliveryId: "delivery-telemetry" });
  assert.equal(telemetry.data.facts?.request_count, 0);
});

test("missing auth is a readiness failure and makes zero transport calls", async () => {
  let transportCalls = 0;
  const adapter = new IbmCompatibleReadOnlyAdapter({ ...liveOptions(), transport: async () => { transportCalls += 1; return { status: "complete" }; } });
  const registry = registryFor(adapter, ["config://partners/ibm/pending"]);
  const runtime = new PartnerOperationRunner({ registry });
  assert.equal(runtime.readiness("partner.ibm.pending").state, "missing_auth");
  const result = await runtime.execute({ providerId: "partner.ibm.pending", operation: "read_metadata", input: { asset_id: "asset_demo_001" } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error_class, "missing_auth");
  assert.equal(transportCalls, 0);
});

test("invalid credential references fail closed before transport", async () => {
  let transportCalls = 0;
  const secretProvider = new MockSecretProvider({ values: {} });
  const adapter = new IbmCompatibleReadOnlyAdapter({
    ...liveOptions({
      provider: { provider_id: "future.invalid", display_name: "Future invalid", confirmation_state: "confirmed" },
      endpointRef: "config://partners/invalid",
      credentialRef: "config://not-a-secret-manager-reference",
      enabled: true,
      secretProvider,
      transport: async () => { transportCalls += 1; },
    }),
  });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter, ["config://partners/invalid"]) });
  assert.equal(runtime.readiness("future.invalid").state, "missing_auth");
  const result = await runtime.execute({ providerId: "future.invalid", operation: "read_metadata" });
  assert.equal(result.error_class, "missing_auth");
  assert.equal(transportCalls, 0);
});

test("generic live transport receives opaque references and normalized input only", async () => {
  const secretRef = "projects/demo-project/secrets/partner-auth/versions/latest";
  const requests = [];
  const secretProvider = new MockSecretProvider({ values: { [secretRef]: "do-not-forward" } });
  const adapter = new IbmCompatibleReadOnlyAdapter({
    ...liveOptions({
      provider: { provider_id: "future.transport", display_name: "Future transport", confirmation_state: "confirmed" },
      endpointRef: "config://partners/transport",
      credentialRef: secretRef,
      enabled: true,
      secretProvider,
      transport: async (request) => { requests.push(request); return { status: "complete", token: "do-not-forward" }; },
    }),
  });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter, ["config://partners/transport"]) });
  const result = await runtime.execute({ providerId: "future.transport", operation: "read_metadata", input: { asset_id: "  asset_demo_001\u0000 ", nested: { label: "  Demo  " } } });
  assert.equal(result.status, "complete");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].credential_ref, secretRef);
  assert.equal(requests[0].endpoint_ref, "config://partners/transport");
  assert.deepEqual(requests[0].input, { asset_id: "asset_demo_001", nested: { label: "Demo" } });
  assert.equal(JSON.stringify(requests[0]).includes("do-not-forward"), false);
  assert.deepEqual(secretProvider.reads, [secretRef]);
});

test("injected readiness checks control live readiness and remain fail closed", async () => {
  let transportCalls = 0;
  const secretRef = "projects/demo-project/secrets/partner-auth/versions/latest";
  const adapter = new IbmCompatibleReadOnlyAdapter({
    ...liveOptions({
      provider: { provider_id: "future.degraded", display_name: "Future degraded", confirmation_state: "confirmed" },
      endpointRef: "config://partners/degraded",
      credentialRef: secretRef,
      enabled: true,
      secretProvider: new MockSecretProvider({ values: { [secretRef]: "opaque-test-secret" } }),
      readiness: ({ capability, now }) => partnerReadiness({ capability, state: "degraded", checkedAt: now, reasonCodes: ["INJECTED_HEALTH_CHECK_FAILED"] }),
      transport: async () => { transportCalls += 1; },
    }),
  });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter, ["config://partners/degraded"]) });
  assert.equal(runtime.readiness("future.degraded").state, "degraded");
  assert.deepEqual(runtime.readiness("future.degraded").reason_codes, ["INJECTED_HEALTH_CHECK_FAILED"]);
  const result = await runtime.execute({ providerId: "future.degraded", operation: "read_metadata" });
  assert.equal(result.error_class, "not_ready");
  assert.equal(transportCalls, 0);
});

test("direct adapter invocation still rejects unknown and mutating operations", async () => {
  let transportCalls = 0;
  const adapter = new IbmCompatibleReadOnlyAdapter({ ...liveOptions({ credentialRef: "config://not-a-secret", transport: async () => { transportCalls += 1; } }) });
  await assert.rejects(adapter.invoke("publish"), (error) => error.code === "UNKNOWN_CAPABILITY");
  await assert.rejects(adapter.invoke("delete_asset"), (error) => error.code === "UNKNOWN_CAPABILITY");
  assert.equal(transportCalls, 0);
});

test("timeout retries once within a bounded attempt budget", async () => {
  const adapter = new LocalMockPartnerAdapter({ faultPlan: { read_quality: [{ kind: "timeout" }] } });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter), timeoutMs: 15, backoffMs: 0 });
  const result = await runtime.execute({ providerId: "mock-provider", operation: "read_quality", input: { asset_id: "asset_demo_001" } });
  assert.equal(result.status, "complete");
  assert.equal(result.attempt, 2);
  assert.equal(adapter.calls.length, 2);
  assert.equal(runtime.eventsFor("mock-provider").some((event) => event.event_type === "partner.operation.failed" && event.state === "retrying"), true);
});

test("redacted events and projections never expose raw secrets", async () => {
  const adapter = new LocalMockPartnerAdapter();
  const originalInvoke = adapter.invoke.bind(adapter);
  adapter.invoke = async (...args) => ({ ...(await originalInvoke(...args)), token: "super-secret", raw_payload: { password: "secret" }, note: "Bearer abc123" });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter) });
  const result = await runtime.execute({ providerId: "mock-provider", operation: "read_metadata", input: { asset_id: "asset_demo_001" }, deliveryId: "redact-1" });
  const serialized = JSON.stringify({ result, events: runtime.eventsFor("mock-provider"), projection: runtime.projections() });
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("raw_payload"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes(LOCAL_MOCK_ENDPOINT), true);
});

test("duplicate delivery is idempotent and does not call the partner twice", async () => {
  const adapter = new LocalMockPartnerAdapter();
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter) });
  const first = await runtime.execute({ providerId: "mock-provider", operation: "read_metadata", input: { asset_id: "asset_demo_001" }, deliveryId: "same-delivery" });
  const second = await runtime.execute({ providerId: "mock-provider", operation: "read_metadata", input: { asset_id: "asset_demo_001" }, deliveryId: "same-delivery" });
  assert.equal(adapter.calls.length, 1);
  assert.equal(first.response_hash, second.response_hash);
  assert.equal(second.duplicate_delivery, true);
});

test("stale readiness and circuit-open behavior fail closed with safe fallback", async () => {
  const adapter = new LocalMockPartnerAdapter({ faultPlan: { read_quality: [{ kind: "unavailable" }, { kind: "unavailable" }] } });
  const originalReadiness = adapter.readiness.bind(adapter);
  adapter.readiness = () => ({ ...originalReadiness(), state: "ready", checked_at: "2020-01-01T00:00:00.000Z" });
  const runtime = new PartnerOperationRunner({ registry: registryFor(adapter), timeoutMs: 100, backoffMs: 0, circuit: { failureThreshold: 2, cooldownMs: 60_000 } });
  assert.equal(runtime.readiness("mock-provider", { maxAgeMs: 1 }).state, "stale");
  const first = await runtime.execute({ providerId: "mock-provider", operation: "read_quality", input: { asset_id: "asset_demo_001" } });
  assert.equal(first.status, "unavailable");
  const callsAfterFirst = adapter.calls.length;
  const second = await runtime.execute({ providerId: "mock-provider", operation: "read_quality", input: { asset_id: "asset_demo_001" } });
  assert.equal(second.error_class, "circuit_open");
  assert.equal(second.provider_fallback_used, false);
  assert.equal(adapter.calls.length, callsAfterFirst);
});

test("future IBM-compatible shape stays pending and credential-gated", () => {
  const adapter = new IbmCompatibleReadOnlyAdapter(liveOptions());
  assert.equal(adapter.capabilities().provider.confirmation_state, "pending");
  assert.equal(adapter.capabilities().enabled, false);
  assert.equal(adapter.capabilities().endpoint_ref, "config://partners/ibm/pending");
  assert.equal(adapter.capabilities().auth_mode, "oauth2_client_credentials");
});

test("server-owned capability configuration registers a future adapter without vendor semantics", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-live-seam-"));
  const secretRef = "projects/demo-project/secrets/partner-auth/versions/latest";
  const capability = createPartnerCapability({
    provider: { provider_id: "future.configured", display_name: "Future configured partner", product_ref: "exact-product-record-pending", confirmation_state: "confirmed" },
    environment: "staging",
    endpointRef: "config://partners/configured",
    authMode: "oauth2_client_credentials",
    credentialRef: secretRef,
    scopeRef: "config://scope/configured",
    allowedOperations: [{ operation: "read_metadata", tool_ref: "future.read_metadata", data_class: "metadata" }],
    dataClasses: ["metadata"],
    enabled: true,
  });
  const secretProvider = new MockSecretProvider({ values: { [secretRef]: "opaque-test-secret" } });
  const calls = [];
  const app = createApp({
    env: {},
    dataPath: path.join(directory, "runs.json"),
    partnerConfig: capability,
    secretProvider,
    partnerTransportFactory: ({ secretProvider: injected }) => async (request) => {
      assert.equal(injected, secretProvider);
      calls.push(request);
      return { status: "complete", facts: { source: "contract-test" } };
    },
  });
  assert.deepEqual(app.partnerRegistry.list().map((entry) => entry.provider.provider_id), ["mock-provider", "future.configured"]);
  assert.equal(app.partnerRuntime.readiness("future.configured").state, "ready");
  const result = await app.partnerRuntime.execute({ providerId: "future.configured", operation: "read_metadata", input: { asset_id: " asset_demo_001 " } });
  assert.equal(result.status, "complete");
  assert.equal(calls[0].credential_ref, secretRef);
  assert.equal(JSON.stringify(app.partnerRuntime.projections()).includes("opaque-test-secret"), false);
});

test("API exposes safe partner status and evidence provenance without raw payloads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-partners-"));
  const app = createApp({ dataPath: path.join(directory, "runs.json") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const list = await fetch(`${base}/v1/partners`).then((response) => response.json());
  assert.equal(list.providers.length, 1);
  assert.equal(list.providers[0].provider.provider_id, "mock-provider");
  assert.equal(list.providers[0].readiness.state, "ready");
  assert.equal(JSON.stringify(list).includes("raw_payload"), false);
  assert.equal(JSON.stringify(list).includes("credential_ref"), false);
  const readiness = await fetch(`${base}/v1/partners/mock-provider/readiness`).then((response) => response.json());
  assert.equal(readiness.state, "ready");
  const ready = await fetch(`${base}/readyz`).then((response) => response.json());
  assert.equal(ready.partners[0].readiness.state, "ready");
  const runResponse = await fetch(`${base}/v1/runs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "partner-projection" }, body: JSON.stringify({ schema_version: "run-request@1", problem_statement: "Is the audience asset ready?", asset_hint: "season_2_audience_engagement" }) });
  const runProjection = await runResponse.json();
  assert.equal(runProjection.partner_status[0].readiness.state, "ready");
  assert.equal((await fetch(`${base}/v1/partners/unknown`)).status, 404);
});
