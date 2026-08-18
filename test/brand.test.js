import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { LEGACY_SESSION_KEYS, SESSION_KEYS, readMigratedSessionValue, writeSessionValue } from "../web/session-state.js";

function tempPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movie-inator-brand-"));
  return path.join(directory, "runs.json");
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("Movie-Inator identity uses the display name and machine-safe package identifier", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const packageLock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url)));
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

  assert.equal(packageJson.name, "movie-inator");
  assert.equal(packageLock.name, "movie-inator");
  assert.equal(packageLock.packages[""].name, "movie-inator");
  assert.match(readme, /^# Movie-Inator$/m);
  assert.match(html, /<title>Movie-Inator - Evidence-backed filmmaker workflows<\/title>/);
  assert.match(html, /aria-label="Choose a Movie-Inator workflow"/);
  assert.doesNotMatch(html, /Gemini Agents/);
});

test("legacy readiness session state migrates without losing the old value", () => {
  const storage = memoryStorage({ [LEGACY_SESSION_KEYS.readinessRun[0]]: "run_legacy" });

  assert.equal(readMigratedSessionValue(storage, SESSION_KEYS.readinessRun, LEGACY_SESSION_KEYS.readinessRun), "run_legacy");
  assert.equal(storage.getItem(SESSION_KEYS.readinessRun), "run_legacy");
  assert.equal(storage.getItem(LEGACY_SESSION_KEYS.readinessRun[0]), "run_legacy");

  writeSessionValue(storage, SESSION_KEYS.groundingRun, "run_grounding");
  assert.equal(storage.getItem(SESSION_KEYS.groundingRun), "run_grounding");
});

test("direct Movie-Inator routes preserve the mock shell and browser module", async (t) => {
  const app = createApp({ dataPath: tempPath() });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<title>Movie-Inator/);

  const appScript = await fetch(`${base}/app.js`);
  assert.equal(appScript.status, 200);
  assert.match(await appScript.text(), /session-state\.js/);

  const sessionScript = await fetch(`${base}/session-state.js`);
  assert.equal(sessionScript.status, 200);
  assert.match(await sessionScript.text(), /gemini-agents-run-id/);

  const readiness = await fetch(`${base}/readyz`).then((response) => response.json());
  assert.equal(readiness.mode, "mock-only");
  assert.equal(readiness.google.state, "disabled");
});
