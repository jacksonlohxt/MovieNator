import assert from "node:assert/strict";
import test from "node:test";
import { createAuditEvent, AuditRecorder } from "../src/audit.js";
import { MockSecretProvider, parseSecretReference, SecretManagerProvider } from "../src/secrets.js";
import { createGeminiReadiness, readGeminiConfig } from "../src/gemini-rest.js";
import { GEMINI_SAFETY_POLICY, GEMINI_SAFETY_SETTINGS, RateLimiter, redactForAudit } from "../src/safety.js";
import { RuntimeConfigError, readRuntimeConfig } from "../src/runtime-config.js";

const live = {
  RUNTIME_MODE: "deployed_identity",
  DEPLOYMENT_TARGET: "cloud_run",
  MODEL_BACKEND: "google_rest",
  GOOGLE_GEMINI_ENABLED: "true",
  GOOGLE_GEMINI_READINESS: "passed",
  GOOGLE_PROJECT_ID: "demo-project",
  GOOGLE_LOCATION: "us-central1",
  GOOGLE_MODEL_ID: "gemini-test",
  GOOGLE_AUTH_MODE: "workload_identity",
};

const secretRef = "projects/demo-project/secrets/example/versions/latest";

test("runtime configuration keeps mock, ADC local, and deployed identity explicit", async () => {
  assert.equal(readRuntimeConfig({}).mode, "mock");
  assert.equal(readRuntimeConfig({ RUNTIME_MODE: "mock", NODE_ENV: "production" }).mode, "mock");
  const local = {
    RUNTIME_MODE: "adc_local",
    DEPLOYMENT_TARGET: "local",
    MODEL_BACKEND: "google_rest",
    GOOGLE_GEMINI_ENABLED: "true",
    GOOGLE_GEMINI_READINESS: "passed",
    GOOGLE_PROJECT_ID: "demo-project",
    GOOGLE_LOCATION: "us-central1",
    GOOGLE_MODEL_ID: "gemini-test",
    GOOGLE_AUTH_MODE: "adc",
  };
  assert.throws(() => readRuntimeConfig(local), /active operator check/);
  assert.throws(() => readRuntimeConfig(live), /active operator readiness check/);
  const localReadiness = createGeminiReadiness({ config: readGeminiConfig(local), tokenProvider: async () => "test-token", transport: async () => ({ status: 200 }) });
  const liveReadiness = createGeminiReadiness({ config: readGeminiConfig(live), tokenProvider: async () => "test-token", transport: async () => ({ status: 200 }) });
  assert.equal((await localReadiness.check()).state, "passed");
  assert.equal((await liveReadiness.check()).state, "passed");
  assert.equal(readRuntimeConfig(local, { googleReadiness: localReadiness }).mode, "adc_local");
  assert.equal(readRuntimeConfig(live, { googleReadiness: liveReadiness }).mode, "deployed_identity");
  assert.equal(readRuntimeConfig({ ...live, MOVIEINATOR_SECRET_REF: secretRef }, { googleReadiness: liveReadiness }).secretReferenceCount, 1);
  assert.equal(readRuntimeConfig({ ...live, MOVIE_INATOR_SECRET_REF: secretRef }, { googleReadiness: liveReadiness }).secretReferenceCount, 1);
  assert.throws(() => readRuntimeConfig({ ...live, GOOGLE_MODEL_ID: "" }), RuntimeConfigError);
  assert.throws(() => readRuntimeConfig({ NODE_ENV: "production" }), /explicit/);
  assert.throws(() => readRuntimeConfig({ ...live, MOVIE_INATOR_SECRET_REF: "not-a-value" }, { googleReadiness: liveReadiness }), /Secret Manager/);
});

test("secret references are runtime-only and providers are injectable", async () => {
  assert.deepEqual(parseSecretReference(secretRef), { resourceName: secretRef, projectId: "demo-project", secretId: "example", version: "latest" });
  const mock = new MockSecretProvider({ values: { [secretRef]: "test-only-secret" } });
  assert.equal(await mock.read(secretRef), "test-only-secret");
  assert.deepEqual(mock.reads, [secretRef]);
  const calls = [];
  const provider = new SecretManagerProvider({ tokenProvider: async () => "test-token", transport: async (request) => { calls.push(request); return { status: 200, body: JSON.stringify({ payload: { data: Buffer.from("test-only-secret").toString("base64") } }) }; } });
  assert.equal(await provider.read(secretRef), "test-only-secret");
  assert.equal(calls[0].url.includes(secretRef), true);
  assert.equal(calls[0].headers.authorization, "Bearer test-token");
});

test("safety settings and audit projections are fixed and bounded", () => {
  assert.equal(GEMINI_SAFETY_SETTINGS.length, 4);
  assert.equal(GEMINI_SAFETY_POLICY.max_output_tokens, 768);
  const limiter = new RateLimiter({ limit: 1 });
  assert.equal(limiter.allow("test"), true);
  assert.equal(limiter.allow("test"), false);
  const audited = createAuditEvent({ type: "safety_block", mode: "deployed_identity", code: "semantic_invalid", attributes: { prompt: "private prompt", question: "private question", token: "secret-value", safe: "ok" } });
  const json = JSON.stringify(audited);
  assert.equal(json.includes("private prompt"), false);
  assert.equal(json.includes("private question"), false);
  assert.equal(json.includes("secret-value"), false);
  assert.equal(json.includes("safe"), true);
  assert.equal(JSON.stringify(redactForAudit({ response: "private provider response", api_key: "secret" })).includes("private provider response"), false);
  const recorder = new AuditRecorder();
  recorder.record({ type: "configuration_state", mode: "mock", attributes: { target: "local" } });
  assert.equal(recorder.events.length, 1);
});
