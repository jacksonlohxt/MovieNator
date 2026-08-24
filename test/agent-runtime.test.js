import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { createGeminiReadiness, readGeminiConfig } from "../src/gemini-rest.js";
import { buildProducerDecisionPacket, parseProducerSource } from "../src/producer-consolidation.js";
import { PRODUCER_AGENT_CONTRACT, PRODUCER_AGENT_OPERATION, PRODUCER_AGENT_TOOL, GoogleInteractionsTransport, validateProducerAgentRequest } from "../src/producer-agent-boundary.js";

function tempPath(prefix = "movieinator-agent") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

function packet() {
  const source = parseProducerSource({ filename: "script.txt", source_kind: "script", contentType: "text/plain", bytes: Buffer.from("INT. STUDIO - NIGHT\nMara enters.") });
  return buildProducerDecisionPacket([source], { createdAt: "2026-08-14T00:00:00.000Z" });
}

async function startApp(t) {
  const app = createApp({ dataPath: tempPath() });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

function request(packetId, extra = {}) {
  return { schema_version: PRODUCER_AGENT_CONTRACT, packet_id: packetId, ...extra };
}

test("producer agent boundary exposes one allowlisted read-only tool with safe provenance", async (t) => {
  const { app, base } = await startApp(t);
  const stored = app.store.createProducerPacket(packet()).packet;
  const readinessResponse = await fetch(`${base}/v1/agent/readiness`);
  assert.equal(readinessResponse.status, 200);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.package.name, "@google/genai");
  assert.equal(readiness.package.version, "2.18.0");
  assert.deepEqual(readiness.contract.allowed_tools, [{ name: PRODUCER_AGENT_TOOL, operation: PRODUCER_AGENT_OPERATION, side_effects: false }]);
  assert.equal(readiness.contract.credentials, "none");
  assert.equal(readiness.contract.no_side_effect_mode, true);
  assert.equal(readiness.contract.publishing, false);
  assert.equal(readiness.contract.booking, false);
  assert.equal(readiness.contract.approval, false);
  assert.equal(readiness.contract.spending, false);
  assert.equal(readiness.contract.mutation, false);

  const response = await fetch(`${base}/v1/agent/producer-intake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request(stored.packet_id)) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "succeeded");
  assert.equal(result.agent.agent_id, "movieinator.producer-intake");
  assert.equal(result.agent.flow_id, "producer_intake_decision_packet");
  assert.deepEqual(result.tool_call, { name: PRODUCER_AGENT_TOOL, operation: PRODUCER_AGENT_OPERATION });
  assert.match(result.request_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.result_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.model.model_id, null);
  assert.equal(result.model.project_id, null);
  assert.equal(result.model.region, null);
  assert.equal(result.provenance.no_credentials, true);
  assert.equal(result.provenance.no_side_effect_mode, true);
  assert.equal(result.provenance.raw_provider_payload, false);
  assert.equal(result.provenance.raw_private_source_stored, false);
  assert.equal(result.provenance.hidden_reasoning_stored, false);
  assert.equal(result.result.packet.packet_id, stored.packet_id);
  assert.equal(result.result.packet.citations.every((citation) => citation.excerpt.length <= 900), true);
});

test("managed Interactions transport is injectable and projects no provider payload", async () => {
  const calls = [];
  const client = { interactions: { create: async (request) => {
    calls.push(request);
    return (async function* events() {
      yield { event_type: "interaction.complete", interaction: { id: "interaction_123", status: "completed", hidden: "private" } };
    }());
  } } };
  const transport = new GoogleInteractionsTransport({ client, agentId: "managed-agent-123" });
  const result = await transport.invoke({ packetId: "packet_demo_12345678" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.event_count, 1);
  assert.match(result.interaction_id_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls[0].agent, "managed-agent-123");
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].background, false);
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].input.includes("packet_demo_12345678"), true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("managed mode requires an actual injected readiness check and preserves the REST seam", async (t) => {
  assert.throws(() => createApp({ dataPath: tempPath("movieinator-invalid-agent"), env: { AGENT_RUNTIME_MODE: "managed_interactions" } }), /RUNTIME_MODE=deployed_identity/);
  const env = {
    RUNTIME_MODE: "deployed_identity",
    DEPLOYMENT_TARGET: "cloud_run",
    MODEL_BACKEND: "google_rest",
    GOOGLE_GEMINI_ENABLED: "true",
    GOOGLE_PROJECT_ID: "demo-project",
    GOOGLE_LOCATION: "global",
    GOOGLE_MODEL_ID: "operator-model",
    GOOGLE_AUTH_MODE: "workload_identity",
    AGENT_RUNTIME_MODE: "managed_interactions",
    AGENT_RUNTIME_AGENT_ID: "managed-agent-123",
  };
  const config = readGeminiConfig(env);
  const readiness = createGeminiReadiness({ config, tokenProvider: async () => "test-token", transport: async () => ({ status: 200 }) });
  await readiness.check();
  const calls = [];
  const app = createApp({
    dataPath: tempPath("movieinator-managed-agent"),
    env,
    googleReadiness: readiness,
    googleTokenProvider: async () => "test-token",
    agentInteractionsTransport: { invoke: async (input) => { calls.push(input); return { status: "succeeded", event_count: 1, interaction_id_hash: "sha256:interaction" }; } },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const agentReadiness = await (await fetch(`http://127.0.0.1:${app.server.address().port}/v1/agent/readiness`)).json();
  assert.equal(agentReadiness.mode, "managed_interactions");
  assert.equal(agentReadiness.state, "passed");
  assert.equal(agentReadiness.checked, true);
  assert.equal(agentReadiness.passed, true);
  assert.equal(agentReadiness.contract.interaction_api.version, "v1beta1");
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/agent/producer-intake`, { method: "POST", body: JSON.stringify(request("packet_demo_12345678")) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.interaction_id_hash, "sha256:interaction");
  assert.deepEqual(calls, [{ packetId: "packet_demo_12345678" }]);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
});

test("producer agent boundary rejects tool selection, arbitrary fields, and oversized identifiers", async (t) => {
  const { app, base } = await startApp(t);
  const stored = app.store.createProducerPacket(packet()).packet;
  assert.throws(() => validateProducerAgentRequest(request(stored.packet_id, { tool: "publish" })), (error) => error.code === "UNKNOWN_FIELD");
  assert.throws(() => validateProducerAgentRequest({ schema_version: PRODUCER_AGENT_CONTRACT, packet_id: "packet_" + "x".repeat(161) }), (error) => error.code === "TOO_LONG");
  const unknownField = await fetch(`${base}/v1/agent/producer-intake`, { method: "POST", body: JSON.stringify(request(stored.packet_id, { endpoint: "https://example.com" })) });
  assert.equal(unknownField.status, 400);
  const error = await unknownField.json();
  assert.equal(error.error.code, "UNKNOWN_FIELD");
  assert.equal(JSON.stringify(error).includes("https://example.com"), false);
  const missing = await fetch(`${base}/v1/agent/producer-intake`, { method: "POST", body: JSON.stringify(request("packet_missing123")) });
  assert.equal(missing.status, 404);
  assert.deepEqual((await missing.json()).error, { code: "PRODUCER_PACKET_NOT_FOUND", message: "Producer decision packet not found", field: "packet_id" });
});

test("existing health, readiness, producer retrieval, and tool routes remain compatible", async (t) => {
  const { base } = await startApp(t);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.runtime_mode, "mock");
  assert.equal(readyBody.agent_runtime.mode, "local_mock");
  assert.equal(readyBody.agent_runtime.no_side_effect_mode, true);
  assert.equal((await fetch(`${base}/v1/tools/readiness`)).status, 200);
  assert.equal((await fetch(`${base}/v1/logic/state`)).status, 200);
});
