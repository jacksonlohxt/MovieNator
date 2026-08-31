// Automated browser end-to-end coverage for the promoted Producer Intake Decision Packet
// primary tab, using the seeded four-file Northline fixture described in docs/prd.md
// (Section "The first-five-minute hypothesis test"). This is the browser E2E the
// post-merge audit flagged as missing: it drives the real rendered DOM in a real
// browser engine (Playwright/Chromium), not a static HTML/JS regex check.
//
// The test is intentionally bounded: a hard per-test timeout, short per-action
// waits, and a guaranteed browser/server teardown in `t.after` so a stuck browser
// can never hang the suite. If no local Chromium build is available (for example
// an offline environment that has never run `npx playwright install`), the test
// skips instead of failing so `npm test` stays deterministic and network-free.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { buildProducerDecisionPacket } from "../src/producer-consolidation.js";

const ACTION_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 45_000;

function tempPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-producer-e2e-"));
  return path.join(directory, "runs.json");
}

// Same seeded four-file fixture as docs/prd.md and test/producer.test.js's
// `northlineEntries()`, plus one appended adversarial line on the primary
// screenplay. The ingestion pipeline strips tag-like text during normalization
// (see src/documents.js), so this line also proves the safety pipeline never
// stores literal markup, on top of the browser only ever assigning excerpt text
// via `.textContent`.
function northlineFixtureFiles() {
  return [
    {
      name: "northline-shooting-script.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "SHOOTING DRAFT 3\nSCENE 7 - INT. MILL - NIGHT\nMara enters the mill.\nNote: <img src=x onerror=window.__pwned=true> should never render as a live element.",
      ),
    },
    {
      name: "northline-location-access.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Permission status: permission pending\nOwner: Jo - Locations\nNo location hold is confirmed."),
    },
    {
      name: "northline-schedule-assumption.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Assumption: Scene 7 is on a Mill hold for 12 June"),
    },
    {
      name: "northline-budget-input.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Access rate: $1,200 per access day"),
    },
  ];
}

async function launchChromium() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { browser: null, reason: "the playwright package is not installed" };
  }
  try {
    const browser = await chromium.launch({ timeout: ACTION_TIMEOUT_MS });
    return { browser, reason: null };
  } catch (error) {
    return { browser: null, reason: `no local Chromium build is available (${error.message.split("\n")[0]})` };
  }
}

test(
  "producer browser E2E renders the four-file fixture, both-sided conflict, ledger, citation focus return, and safe copy/export",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const app = createApp({
      dataPath: tempPath(),
      producerBuilder: async (sources, options) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return buildProducerDecisionPacket(sources, options);
      },
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    t.after(() => app.server.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;

    const { browser, reason } = await launchChromium();
    if (!browser) {
      t.skip(`Skipping browser E2E: ${reason}. Run "npx playwright install chromium" to enable it.`);
      return;
    }
    t.after(() => browser.close());

    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.addInitScript(() => {
      window.__copiedHandoffText = null;
      const stub = async (text) => {
        window.__copiedHandoffText = text;
      };
      Object.defineProperty(navigator, "clipboard", { value: { writeText: stub }, configurable: true });
    });

    await page.goto(base, { waitUntil: "domcontentloaded" });

    // The Producer Intake Decision Packet is the default primary tab and User mode
    // is selected without requiring a technical details surface.
    await assert.doesNotReject(page.waitForSelector("#producer-section:not([hidden])", { timeout: ACTION_TIMEOUT_MS }));
    const heroTitle = await page.textContent("#page-title");
    assert.match(heroTitle, /decision packet/i);
    const producerTabPressed = await page.getAttribute('[data-workflow="producer"]', "aria-pressed");
    assert.equal(producerTabPressed, "true");
    assert.equal(await page.locator("[data-producer-mode]").count(), 2);
    assert.equal(await page.getAttribute('[data-producer-mode="user"]', "aria-checked"), "true");

    // Step 1: upload and label the four-file bundle.
    await page.setInputFiles("#producer-files", northlineFixtureFiles());
    const rowCountAfterSelect = await page.locator("#producer-file-labels .producer-file-row").count();
    assert.equal(rowCountAfterSelect, 4);
    const defaultKinds = await page.$$eval("#producer-file-labels select", (selects) => selects.map((select) => select.value));
    assert.deepEqual(defaultKinds, ["primary_screenplay", "location_access", "schedule_assumptions", "budget_assumptions"]);

    await page.click("#submit-producer");
    await page.waitForSelector("#producer-bundle-summary:not([hidden])");
    const inventoryRows = page.locator("#producer-source-inventory tbody tr");
    assert.equal(await inventoryRows.count(), 4);
    const inventoryText = await page.textContent("#producer-source-inventory");
    for (const filename of ["northline-shooting-script.txt", "northline-location-access.txt", "northline-schedule-assumption.txt", "northline-budget-input.txt"]) {
      assert.match(inventoryText, new RegExp(filename.replace(/\./g, "\\.")));
    }

    // Step 2: optional decision context, then generate the packet.
    await page.fill("#producer-decision-context", "Confirm Mill access before locking Scene 7's shoot date.");
    // Changing presentation while the run is pending must not restart or alter it.
    await page.click('[data-producer-mode="developer"]');
    await page.click("#submit-producer-packet");
    await page.waitForSelector("#producer-developer-run-evidence:not([hidden])");
    await page.waitForSelector("#producer-result:not([hidden])");
    await page.waitForSelector("#producer-developer-details:not([hidden])");
    assert.equal(await page.getAttribute('[data-producer-mode="developer"]', "aria-checked"), "true");

    // User mode keeps the same result but focuses it on consequential gaps.
    await page.click('[data-producer-mode="user"]');
    await page.waitForSelector("#producer-user-result:not([hidden])");
    assert.equal(await page.getAttribute('[data-producer-mode="user"]', "aria-checked"), "true");
    assert.doesNotMatch(await page.textContent("#producer-user-result"), /actor count|actors:/i);
    assert.match(await page.textContent("#producer-user-result"), /Packet ready for human review/);
    const userPriorityText = await page.textContent("#producer-user-priorities");
    assert.match(userPriorityText, /Evidence state|Owner|Why it matters|Next action/);
    assert.match(userPriorityText, /Schedule assumption conflicts with location access evidence/);
    assert.match(userPriorityText, /Inspect citation/);
    assert.equal(await page.locator("#producer-developer-details").isHidden(), true);
    assert.equal(await page.locator(".developer-only-action").first().isHidden(), true);

    // The focused view remains understandable at a narrow responsive width.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.textContent("#producer-user-result"), /What needs attention first/);
    assert.ok(await page.locator('[data-producer-mode="user"]').isVisible());
    await page.setViewportSize({ width: 1280, height: 960 });

    // Developer mode keeps the complete packet available without changing the result.
    await page.click('[data-producer-mode="developer"]');
    await page.waitForSelector("#producer-developer-details:not([hidden])");
    assert.equal(await page.getAttribute('[data-producer-mode="developer"]', "aria-checked"), "true");

    // Scene 7 is present with its exact source heading.
    const sceneText = await page.textContent("#producer-scenes");
    assert.match(sceneText, /SCENE 7 - INT\. MILL - NIGHT/);
    assert.doesNotMatch(sceneText, /actor count|actors:/i);
    assert.doesNotMatch(await page.textContent("#producer-developer-details"), /actor counts?|actors:/i);
    const elementText = await page.textContent("#producer-elements");
    assert.match(elementText, /location_or_set|Location or set|SCENE 7/i);
    const budgetRiskText = await page.textContent("#producer-budget-risks");
    assert.match(budgetRiskText, /Budget-risk observation/i);
    const coverageGapText = await page.textContent("#producer-coverage-gaps");
    assert.match(coverageGapText, /No props requirement|props/i);

    // A conflict is shown with both sides, not a silently resolved precedence.
    const conflictCard = page.locator("#producer-conflicts .producer-evidence-card").first();
    await assert.doesNotReject(conflictCard.waitFor({ state: "visible" }));
    const conflictText = await conflictCard.innerText();
    assert.match(conflictText, /Mill hold for 12 June/);
    assert.match(conflictText, /No location hold is confirmed/);
    assert.match(conflictText, /Resolving question:/);
    const conflictCitationCount = await conflictCard.locator(".evidence-button").count();
    assert.ok(conflictCitationCount >= 2, "both conflicting assertions keep their own citations");

    // The budget/schedule ledger shows the externally supplied input without a total.
    const ledgerText = await page.textContent("#producer-budget-inputs");
    assert.match(ledgerText, /\$1,200/);
    assert.match(ledgerText, /access day/);
    assert.match(ledgerText, /Mill hold for 12 June/);
    assert.doesNotMatch(ledgerText, /\btotal\b/i);

    // An owner and a handoff-ready next action are visible on the open register.
    const registerText = await page.textContent("#producer-questions");
    assert.match(registerText, /Jo - Locations/);
    assert.match(registerText, /obtain or record the access evidence/);
    const nextStepsText = await page.textContent("#producer-next-steps");
    assert.match(nextStepsText, /Jo - Locations/);
    assert.match(nextStepsText, /obtain or record the access evidence/);

    // Citation open renders bounded source text (never HTML) and returns focus
    // to the exact control that opened it.
    const sceneCitation = page.locator("#producer-scenes .evidence-button").first();
    const invokingButtonText = await sceneCitation.textContent();
    await sceneCitation.focus();
    await sceneCitation.click();
    await page.waitForSelector("#evidence-drawer:not([hidden])");
    const drawerText = await page.textContent("#evidence-content");
    assert.match(drawerText, /SCENE 7 - INT\. MILL - NIGHT/);
    assert.doesNotMatch(drawerText, /<img/i, "the adversarial payload must never appear as a live tag in the rendered excerpt");
    const liveImgCount = await page.locator("#evidence-content img").count();
    assert.equal(liveImgCount, 0, "the excerpt must be assigned as text, never parsed as HTML");
    const pwned = await page.evaluate(() => window.__pwned);
    assert.equal(pwned, undefined, "no injected script from source text may execute");

    await page.keyboard.press("Escape");
    await page.waitForSelector("#evidence-drawer", { state: "hidden" });
    const activeElementText = await page.evaluate(() => document.activeElement?.textContent || "");
    assert.equal(activeElementText, invokingButtonText, "focus returns to the exact control that opened the citation");

    // Copy read-only handoff and verify safe, allowlisted export routes.
    await page.click("#copy-producer-handoff");
    await page.waitForFunction(() => document.querySelector("#producer-copy-status")?.textContent?.length > 0);
    const copyStatus = await page.textContent("#producer-copy-status");
    assert.match(copyStatus, /copied/i);
    const copiedText = await page.evaluate(() => window.__copiedHandoffText);
    assert.ok(copiedText && copiedText.length > 0, "the copied handoff is non-empty");
    assert.match(copiedText, /Scene 7|SCENE 7/i);

    for (const [id, format] of [["#export-producer-markdown", "markdown"], ["#export-producer-json", "json"], ["#export-producer-csv", "csv"]]) {
      const href = await page.getAttribute(id, "href");
      assert.match(href, /\/v1\/producer-packets\/.+\/handoff\?format=/);
      const response = await page.request.get(new URL(href, base).toString());
      assert.equal(response.status(), 200);
      const body = await response.text();
      assert.ok(body.length > 0, `${format} export is non-empty`);
      assert.doesNotMatch(body, /<img[^>]*onerror/i, `${format} export never carries live markup`);
      assert.doesNotMatch(body, /actor_count|actor count|actors:/i, `${format} export omits actor-count presentation`);
      if (format === "json") assert.equal(Object.hasOwn(JSON.parse(body).scene_index[0], "actor_count"), false);
    }

    // Never render source text as HTML anywhere in the rendered result.
    const strayScriptCount = await page.locator("#producer-result script").count();
    assert.equal(strayScriptCount, 0);
    const strayImgCount = await page.locator("#producer-result img").count();
    assert.equal(strayImgCount, 0);

    assert.deepEqual(pageErrors, [], "the browser must not raise an uncaught error during the flow");
  },
);
