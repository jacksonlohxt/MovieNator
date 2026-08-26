import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createAuditEvent, AuditRecorder } from "../src/audit.js";
import { MockSecretProvider, parseSecretReference, SecretManagerProvider, createSecretProvider } from "../src/secrets.js";
import { createGeminiReadiness, readGeminiConfig } from "../src/gemini-rest.js";
import { GEMINI_SAFETY_POLICY, GEMINI_SAFETY_SETTINGS, RateLimiter, redactForAudit } from "../src/safety.js";
import { RuntimeConfigError, readRuntimeConfig, readPartnerConfig } from "../src/runtime-config.js";
import { createPartnerCapability } from "../src/partner-contracts.js";

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

test("the Cloud Run manifest is a structurally real, credential-free deployment template", () => {
  const manifest = fs.readFileSync(new URL("../deploy/cloud-run.yaml", import.meta.url), "utf8");
  assert.match(manifest, /^apiVersion: serving\.knative\.dev\/v1$/m);
  assert.match(manifest, /^kind: Service$/m);
  assert.match(manifest, /^\s+image: <OPERATOR_SELECTED_ARTIFACT_IMAGE>$/m);
  assert.match(manifest, /^\s+containerPort: 8080$/m);
  assert.match(manifest, /^\s+serviceAccountName: <OPERATOR_SELECTED_RUNTIME_SERVICE_ACCOUNT>$/m);
  assert.match(manifest, /^\s+traffic:$/m);
  assert.match(manifest, /^\s+latestRevision: true$/m);
  assert.match(manifest, /^\s+autoscaling\.knative\.dev\/maxScale: "\d+"$/m);

  // Every documented env var this manifest sets must be one `readGeminiConfig`,
  // `readRuntimeConfig`, or `producer-agent-boundary.js` actually reads, so the
  // manifest cannot silently drift from the code it configures.
  const envNames = [...manifest.matchAll(/^\s+- name: ([A-Z0-9_]+)$/gm)].map(([, name]) => name);
  assert.deepEqual(
    [...envNames].sort(),
    [
      "AGENT_RUNTIME_AGENT_ID",
      "AGENT_RUNTIME_MODE",
      "DEPLOYMENT_TARGET",
      "GOOGLE_AUTH_MODE",
      "GOOGLE_GEMINI_ENABLED",
      "GOOGLE_GEMINI_READINESS",
      "GOOGLE_LOCATION",
      "GOOGLE_MODEL_ID",
      "GOOGLE_PROJECT_ID",
      "GOOGLE_PUBLISHER",
      "GOOGLE_REST_API_VERSION",
      "GRACEFUL_SHUTDOWN_MS",
      "MODEL_BACKEND",
      "MOVIEINATOR_SECRET_REF",
      "PORT",
      "REQUEST_TIMEOUT_MS",
      "RUNTIME_MODE",
    ].sort(),
  );

  // No real secret value, only a Secret Manager resource-name reference.
  const secretLine = manifest.match(/- name: MOVIEINATOR_SECRET_REF\n\s+value: "([^"]+)"/)[1];
  assert.match(secretLine, /^projects\/<OPERATOR_SELECTED_PROJECT_NUMBER>\/secrets\/<OPERATOR_SELECTED_SECRET_NAME>\/versions\/latest$/);
  assert.equal(/AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(manifest), false);
});

test("server-owned partner configuration accepts only capability references", () => {
  const capability = createPartnerCapability({
    provider: { provider_id: "future.config", display_name: "Future configured partner", confirmation_state: "confirmed" },
    environment: "staging",
    endpointRef: "config://partners/future",
    authMode: "oauth2_client_credentials",
    credentialRef: secretRef,
    scopeRef: "config://scope/future",
    allowedOperations: [{ operation: "read_metadata", tool_ref: "future.read_metadata" }],
    dataClasses: ["metadata"],
    enabled: true,
  });
  const config = readRuntimeConfig({ PARTNER_CAPABILITY_JSON: JSON.stringify(capability) });
  assert.equal(config.partner.provider.provider_id, "future.config");
  assert.equal(config.secretReferenceCount, 1);
  assert.deepEqual(config.secretReferences, [{ name: "partner.credential_ref", reference: secretRef }]);
  assert.equal(createSecretProvider({ env: { PARTNER_CAPABILITY_JSON: "configured" }, references: [secretRef], tokenProvider: async () => "test-token", transport: async () => ({ status: 200 }) }) instanceof SecretManagerProvider, true);
  assert.deepEqual(readPartnerConfig({}), undefined);
  assert.throws(() => readPartnerConfig({ PARTNER_CAPABILITY_JSON: JSON.stringify({ ...capability, credential_ref: "not-a-secret" }) }), RuntimeConfigError);
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
