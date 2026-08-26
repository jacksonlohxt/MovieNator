import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { LOCAL_MOCK_ENDPOINT, LOCAL_MOCK_TOOL_ENDPOINT, PRODUCT_DISPLAY_NAME, PRODUCT_IDENTIFIER } from "../src/product-identity.js";
import {
  LEGACY_SESSION_KEYS,
  SESSION_KEYS,
  modelResultStatus,
  partnerStatusFromProjection,
  readMigratedSessionValue,
  runtimeStatusFromReadiness,
  writeSessionValue,
} from "../web/session-state.js";

function tempPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-brand-"));
  return path.join(directory, "runs.json");
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("MovieInator identity uses the display name and machine-safe product identifier", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const packageLock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url)));
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const deployment = fs.readFileSync(new URL("../deploy/cloud-run.yaml", import.meta.url), "utf8");
  const schemaHost = fs.readFileSync(new URL("../schemas/partner-capability@1.json", import.meta.url), "utf8");

  assert.equal(PRODUCT_DISPLAY_NAME, "MovieInator");
  assert.equal(PRODUCT_IDENTIFIER, "movieinator");
  assert.equal(LOCAL_MOCK_ENDPOINT, "local://movieinator/mock");
  assert.equal(LOCAL_MOCK_TOOL_ENDPOINT, "local:movieinator-mock");
  assert.equal(packageJson.name, "movieinator");
  assert.equal(packageLock.name, "movieinator");
  assert.equal(packageLock.packages[""].name, "movieinator");
  assert.match(readme, /^# MovieInator$/m);
  assert.match(html, /<title>MovieInator - Evidence-backed filmmaker workflows<\/title>/);
  assert.match(html, /<h1 id="page-title">Turn your production sources into one decision packet\.<\/h1>/);
  assert.match(html, /Upload script/);
  assert.match(html, /Tell us what you want/);
  assert.match(html, /Create brief/);
  assert.match(html, /id="copy-brief"/);
  assert.match(html, /id="producer-files"/);
  assert.match(html, /id="producer-file-labels"/);
  assert.match(html, /Prepare intake packet/);
  assert.match(html, /data-workflow="producer"/);
  assert.match(html, /Script Brief and Audience Data Readiness remain available as compatibility workflows/);
  assert.match(html, /aria-label="Choose a MovieInator workflow"/);
  assert.match(deployment, /- name: movieinator/);
  assert.match(deployment, /- name: MOVIEINATOR_SECRET_REF/);
  assert.match(schemaHost, /https:\/\/movieinator\.local\/schemas/);
  assert.doesNotMatch(html, /Movie-Inator|Gemini Agents|Gemini-Agents/);
});

test("browser runtime state maps only safe readiness evidence", () => {
  assert.equal(runtimeStatusFromReadiness().state, "not-yet-checked");
  assert.equal(runtimeStatusFromReadiness({ mode: "mock-only", runtime_mode: "mock", google: { state: "disabled", configured: false }, model_backend: "fake" }).state, "mock");
  assert.equal(runtimeStatusFromReadiness({ ok: true, mode: "google_rest", runtime_mode: "adc_local", google: { state: "passed", configured: true }, model_backend: "google_rest" }).state, "live-gemini");
  assert.equal(runtimeStatusFromReadiness({ ok: false, mode: "google_rest", runtime_mode: "adc_local", google: { state: "failed", configured: true } }, { httpStatus: 503 }).state, "unavailable");
  assert.equal(runtimeStatusFromReadiness(null, { httpStatus: 503 }).state, "unavailable");
  assert.doesNotMatch(runtimeStatusFromReadiness({ mode: "mock-only", runtime_mode: "mock", google: { state: "disabled" }, model_backend: "fake" }).trustCopy, /prompt|credential/i);
});

test("browser model outcome distinguishes live, mock, fallback, and missing evidence", () => {
  assert.equal(modelResultStatus({ backend: "google_rest" }).state, "live-gemini");
  assert.equal(modelResultStatus({ backend: "fake" }).state, "mock");
  assert.equal(modelResultStatus({ backend: "google_rest", fallback: true }).state, "deterministic-fallback");
  assert.equal(modelResultStatus().state, "unavailable");
  assert.match(modelResultStatus({ backend: "google_rest", fallback: true }).copy, /API supplied this verified result/);
});

test("browser partner state keeps synthetic evidence explicit and fails safe", () => {
  const synthetic = partnerStatusFromProjection({ environment: "local", auth_mode: "none_synthetic", provider: { provider_id: "mock-provider", display_name: "Local partner" }, readiness: { state: "ready" } });
  assert.equal(synthetic.state, "ready");
  assert.match(`${synthetic.label} ${synthetic.detail}`, /synthetic/i);
  const unavailable = partnerStatusFromProjection(null, { requestFailed: true });
  assert.equal(unavailable.state, "unavailable");
  assert.match(unavailable.detail, /could not be checked/i);
});

test("legacy readiness session state migrates without losing the old value", () => {
  const storage = memoryStorage({ [LEGACY_SESSION_KEYS.readinessRun[0]]: "run_legacy" });
  assert.equal(readMigratedSessionValue(storage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun), "run_legacy");
  assert.equal(storage.getItem(SESSION_KEYS.readinessRun), "run_legacy");
  assert.equal(storage.getItem(LEGACY_SESSION_KEYS.readinessRun[0]), "run_legacy");
  for (const legacyKey of LEGACY_SESSION_KEYS.readinessRun.slice(1)) {
    const legacyStorage = memoryStorage({ [legacyKey]: "run_legacy" });
    assert.equal(readMigratedSessionValue(legacyStorage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun), "run_legacy");
    assert.equal(legacyStorage.getItem(SESSION_KEYS.readinessRun), "run_legacy");
    assert.equal(legacyStorage.getItem(legacyKey), "run_legacy");
  }

  const groundingStorage = memoryStorage({ [LEGACY_SESSION_KEYS.groundingDocument[0]]: "doc_legacy" });
  assert.equal(readMigratedSessionValue(groundingStorage, SESSION_KEYS.groundingDocument, LEGACY_SESSION_KEYS.groundingDocument), "doc_legacy");
  assert.equal(groundingStorage.getItem(SESSION_KEYS.groundingDocument), "doc_legacy");
  writeSessionValue(groundingStorage, SESSION_KEYS.groundingRun, "run_grounding");
  assert.equal(groundingStorage.getItem(SESSION_KEYS.groundingRun), "run_grounding");
});

test("direct MovieInator routes preserve the mock shell and browser module", async (t) => {
  const app = createApp({ dataPath: tempPath() });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>MovieInator/);

  const appScript = await fetch(`${base}/app.js`);
  assert.equal(appScript.status, 200);
  assert.match(await appScript.text(), /session-state\.js/);

  const sessionScript = await fetch(`${base}/session-state.js`);
  assert.equal(sessionScript.status, 200);
  const sessionText = await sessionScript.text();
  assert.match(sessionText, /movieinator-readiness-run-id/);
  assert.match(sessionText, /movie-inator-readiness-run-id/);
  assert.match(sessionText, /gemini-agents-run-id/);

  const readiness = await fetch(`${base}/readyz`).then((response) => response.json());
  assert.equal(readiness.mode, "mock-only");
  assert.equal(readiness.google.state, "disabled");

  const partners = await fetch(`${base}/v1/partners`).then((response) => response.json());
  assert.equal(partners.providers[0].endpoint_ref, LOCAL_MOCK_ENDPOINT);
  const logic = await fetch(`${base}/v1/logic/state`).then((response) => response.json());
  assert.equal(logic.database.server_id, `${PRODUCT_IDENTIFIER}-local-database`);
});
