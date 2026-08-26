import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GoogleGenAI } from "@google/genai";
import { createApp, startServer } from "../src/server.js";
import { GeminiRestBackend, createGeminiReadiness, readGeminiConfig } from "../src/gemini-rest.js";
import { createManagedClient, PRODUCER_AGENT_CONTRACT } from "../src/producer-agent-boundary.js";

function tempPath(prefix = "google-runtime") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

/** Find a free loopback port so multiple startServer tests never collide on the default 4173. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function runRequest() {
  return { schema_version: "run-request@1", problem_statement: "Is this audience ready?", asset_hint: "season_2_audience_engagement", purpose: "marketing planning" };
}

const plan = {
  schema_version: "readiness-plan@1",
  workflow: "audience_data_readiness",
  asset_query: "season_2_audience_engagement",
  required_evidence: ["asset", "quality", "governance", "lineage"],
  clarification: null,
};

const draft = {
  schema_version: "brief-draft@1",
  headline: "Data readiness: READY",
  summary: "The configured checks were evaluated.",
  summary_evidence_ids: [],
  risks: [],
  recommendations: ["Confirm the planning purpose with the data steward."],
  cited_evidence_ids: [],
};

/** Fake transport used for both the readiness preflight ping and real generateContent calls. */
function fakeGenerateContentTransport() {
  const calls = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      let body = {};
      try {
        body = JSON.parse(request.body || "{}");
      } catch {
        body = {};
      }
      const instruction = body?.systemInstruction?.parts?.[0]?.text || "";
      if (!instruction) return { status: 200, body: "{}" };
      const value = instruction.includes("Request Interpreter") ? plan : draft;
      return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }) };
    },
  };
}

test("the accepted @google/genai SDK is genuinely constructed and shaped for the Interactions API", () => {
  assert.throws(() => createManagedClient({ googleConfig: {} }), (error) => error.code === "GOOGLE_CONFIGURATION_REQUIRED");
  assert.throws(() => createManagedClient({ googleConfig: { projectId: "demo-project" } }), (error) => error.code === "GOOGLE_CONFIGURATION_REQUIRED");
  const client = createManagedClient({ googleConfig: { projectId: "demo-project", location: "global" } });
  assert.equal(client instanceof GoogleGenAI, true);
  assert.equal(client.vertexai, true);
  assert.equal(client.project, "demo-project");
  assert.equal(client.location, "global");
  assert.equal(typeof client.interactions.create, "function");
});

test("a real GoogleGenAI client drives the managed producer-intake call path end to end without live network access", async (t) => {
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
  assert.equal((await readiness.check()).state, "passed");

  const client = createManagedClient({ googleConfig: config });
  assert.equal(client instanceof GoogleGenAI, true);
  const calls = [];
  client.interactions.create = async (request) => {
    calls.push(request);
    return (async function* events() {
      yield { event_type: "interaction.completed", interaction: { id: "interaction_real_sdk", status: "completed", hidden: "unleaked-provider-detail" } };
    })();
  };

  const app = createApp({ dataPath: tempPath(), env, googleReadiness: readiness, googleTokenProvider: async () => "test-token", agentGenaiClient: client });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const response = await fetch(`${base}/v1/agent/producer-intake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema_version: PRODUCER_AGENT_CONTRACT, packet_id: "packet_demo_12345678" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.status, "succeeded");
  assert.match(result.result.interaction_id_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, "managed-agent-123");
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].background, false);
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].input.includes("packet_demo_12345678"), true);
  assert.equal(JSON.stringify(result).includes("unleaked-provider-detail"), false);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
});

test("startServer runs a real awaited Gemini preflight at boot so the live REST call path is genuinely usable", async (t) => {
  const { calls, transport } = fakeGenerateContentTransport();
  const env = {
    PORT: String(await freePort()),
    RUNTIME_MODE: "adc_local",
    MODEL_BACKEND: "google_rest",
    GOOGLE_GEMINI_ENABLED: "true",
    GOOGLE_PROJECT_ID: "demo-project",
    GOOGLE_LOCATION: "us-central1",
    GOOGLE_MODEL_ID: "gemini-test-model",
    GOOGLE_AUTH_MODE: "injected-test-token",
  };
  const app = await startServer({ env, dataPath: tempPath(), googleTransport: transport, googleTokenProvider: async () => "test-token" });
  t.after(() => app.shutdown());

  assert.equal(app.model instanceof GeminiRestBackend, true);
  const readiness = app.googleReadiness.readiness();
  assert.equal(readiness.state, "passed");
  assert.equal(readiness.checked, true);
  assert.equal(readiness.passed, true);
  assert.equal(calls.filter((call) => call.purpose === "readiness_preflight").length, 1);

  const address = app.server.address();
  const base = `http://${address.address}:${address.port}`;
  const readyBody = await fetch(`${base}/readyz`).then((r) => r.json());
  assert.equal(readyBody.ok, true);
  assert.equal(readyBody.mode, "google_rest");
  assert.equal(readyBody.google.state, "passed");

  const accepted = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "start-server-live" },
    body: JSON.stringify(runRequest()),
  }).then((response) => response.json());
  await app.engine.waitForIdle(accepted.run_id);
  const run = app.store.getRun(accepted.run_id);
  assert.equal(run.state, "succeeded");
  assert.equal(run.result.provenance.model_backend.backend, "google_rest");
});

test("startServer fails closed at boot when a declared Cloud Run live configuration cannot pass its preflight", async () => {
  const env = {
    DEPLOYMENT_TARGET: "cloud_run",
    RUNTIME_MODE: "deployed_identity",
    MODEL_BACKEND: "google_rest",
    GOOGLE_GEMINI_ENABLED: "true",
    GOOGLE_PROJECT_ID: "demo-project",
    GOOGLE_LOCATION: "us-central1",
    GOOGLE_MODEL_ID: "gemini-test-model",
    GOOGLE_AUTH_MODE: "workload_identity",
  };
  await assert.rejects(
    startServer({ env, dataPath: tempPath(), googleTransport: async () => ({ status: 500, body: "{}" }), googleTokenProvider: async () => "test-token" }),
    (error) => error.code === "UNSAFE_CONFIGURATION",
  );
});

test("startServer keeps Google readiness fresh with a bounded periodic recheck so it does not silently go stale", async (t) => {
  let preflightCalls = 0;
  const transport = async (request) => {
    if (request.purpose === "readiness_preflight") preflightCalls += 1;
    return { status: 200, body: "{}" };
  };
  const env = {
    PORT: String(await freePort()),
    RUNTIME_MODE: "adc_local",
    MODEL_BACKEND: "google_rest",
    GOOGLE_GEMINI_ENABLED: "true",
    GOOGLE_PROJECT_ID: "demo-project",
    GOOGLE_LOCATION: "us-central1",
    GOOGLE_MODEL_ID: "gemini-test-model",
    GOOGLE_AUTH_MODE: "injected-test-token",
  };
  const app = await startServer({ env, dataPath: tempPath(), googleTransport: transport, googleTokenProvider: async () => "test-token", googleReadinessRefreshMs: 20 });
  t.after(() => app.shutdown());
  assert.equal(preflightCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(preflightCalls >= 2, true);
});
