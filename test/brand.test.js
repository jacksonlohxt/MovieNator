import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { LOCAL_MOCK_ENDPOINT, LOCAL_MOCK_TOOL_ENDPOINT, PRODUCT_DISPLAY_NAME, PRODUCT_IDENTIFIER } from "../src/product-identity.js";
import { LEGACY_SESSION_KEYS, SESSION_KEYS, readMigratedSessionValue, writeSessionValue } from "../web/session-state.js";

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

test("MovieNator identity uses the display name and machine-safe product identifier", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const packageLock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url)));
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const deployment = fs.readFileSync(new URL("../deploy/cloud-run.yaml", import.meta.url), "utf8");
  const schemaHost = fs.readFileSync(new URL("../schemas/partner-capability@1.json", import.meta.url), "utf8");

  assert.equal(PRODUCT_DISPLAY_NAME, "MovieNator");
  assert.equal(PRODUCT_IDENTIFIER, "movieinator");
  assert.equal(LOCAL_MOCK_ENDPOINT, "local://movieinator/mock");
  assert.equal(LOCAL_MOCK_TOOL_ENDPOINT, "local:movieinator-mock");
  assert.equal(packageJson.name, "movieinator");
  assert.equal(packageLock.name, "movieinator");
  assert.equal(packageLock.packages[""].name, "movieinator");
  assert.match(readme, /^# MovieNator$/m);
  assert.match(html, /<title>MovieNator - Evidence-backed filmmaker workflows<\/title>/);
  assert.match(html, /<h1 id="page-title">Turn your script into a useful brief\.<\/h1>/);
  assert.match(html, /Upload script/);
  assert.match(html, /Tell us what you want/);
  assert.match(html, /Create brief/);
  assert.match(html, /id="copy-brief"/);
  assert.match(html, /<summary><span>Developer details<\/span>/);
  assert.match(html, /aria-label="Choose a MovieNator workflow"/);
  assert.match(deployment, /- name: movieinator/);
  assert.match(deployment, /- name: MOVIEINATOR_SECRET_REF/);
  assert.match(schemaHost, /https:\/\/movieinator\.local\/schemas/);
  assert.doesNotMatch(html, /Movie-Inator|Gemini Agents|Gemini-Agents/);
});

test("legacy browser session keys migrate without losing old values", () => {
  const legacyKeys = [LEGACY_SESSION_KEYS.readinessRun[0], LEGACY_SESSION_KEYS.readinessRun[1]];
  for (const legacyKey of legacyKeys) {
    const storage = memoryStorage({ [legacyKey]: "run_legacy" });
    assert.equal(readMigratedSessionValue(storage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun), "run_legacy");
    assert.equal(storage.getItem(SESSION_KEYS.readinessRun), "run_legacy");
    assert.equal(storage.getItem(legacyKey), "run_legacy");
  }

  const groundingStorage = memoryStorage({ [LEGACY_SESSION_KEYS.groundingDocument[0]]: "doc_legacy" });
  assert.equal(readMigratedSessionValue(groundingStorage, SESSION_KEYS.groundingDocument, LEGACY_SESSION_KEYS.groundingDocument), "doc_legacy");
  assert.equal(groundingStorage.getItem(SESSION_KEYS.groundingDocument), "doc_legacy");
  writeSessionValue(groundingStorage, SESSION_KEYS.groundingRun, "run_grounding");
  assert.equal(groundingStorage.getItem(SESSION_KEYS.groundingRun), "run_grounding");
});

test("direct MovieNator routes preserve the mock shell and browser module", async (t) => {
  const app = createApp({ dataPath: tempPath() });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>MovieNator/);

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
