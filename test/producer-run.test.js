import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { PRODUCER_PACKET_SCHEMA_LEGACY, buildProducerDecisionPacket } from "../src/producer-consolidation.js";

function tempPath(prefix = "movie-inator-producer-run") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

function bundleForm(entries) {
  const form = new FormData();
  form.append("schema_version", "producer-source-bundle@1");
  for (const entry of entries) {
    form.append("source_kind", entry.source_kind);
    form.append("file", new Blob([entry.text], { type: "text/plain" }), entry.filename);
  }
  return form;
}

const mixedEntries = [
  { filename: "script.txt", source_kind: "script", text: "OPENING\nINT. WAREHOUSE - NIGHT\nMara enters the warehouse." },
  { filename: "director.txt", source_kind: "director_notes", text: "Location: Riverside Studio\nThe director requires a quiet, tense performance." },
];

async function startApp(t, options = {}) {
  const app = createApp({ dataPath: tempPath(), ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test("producer packet creation queues an immutable run and never builds synchronously in the request", async (t) => {
  const { app, base } = await startApp(t);
  const accepted = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.status, "pending");
  assert.equal(acceptedBody.state, "accepted");
  assert.equal(acceptedBody.result, null);
  assert.ok(acceptedBody.packet_id.startsWith("packet_"));
  // The 202 response body is a snapshot of the run at acceptance time, taken before the background job
  // was scheduled; it proves the packet is never built inside the request even though this deterministic
  // pipeline may finish very quickly afterward.

  const finalRun = await app.producerEngine.waitForIdle(acceptedBody.packet_id);
  assert.equal(finalRun.state, "succeeded");
  const completed = await fetch(`${base}/v1/producer-packets/${acceptedBody.packet_id}`).then((response) => response.json());
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.schema_version, PRODUCER_PACKET_SCHEMA_LEGACY);
  assert.equal(completed.packet_id, acceptedBody.packet_id);
  assert.equal(app.store.getProducerPacket(acceptedBody.packet_id).status, "succeeded");

  const duplicate = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.packet_id, acceptedBody.packet_id);
  assert.equal(duplicateBody.status, "succeeded");
});

test("producer packet SSE events stream reports queued, running, and terminal progress with cursor support", async (t) => {
  const { app, base } = await startApp(t);
  const accepted = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) }).then((response) => response.json());
  await app.producerEngine.waitForIdle(accepted.packet_id);

  const fullStream = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/events`);
  assert.equal(fullStream.status, 200);
  assert.match(fullStream.headers.get("content-type") || "", /text\/event-stream/);
  const fullText = await fullStream.text();
  assert.match(fullText, /producer_run\.accepted/);
  assert.match(fullText, /producer_run\.queued/);
  assert.match(fullText, /producer_run\.reconciling/);
  assert.match(fullText, /producer_run\.verifying/);
  assert.match(fullText, /producer_run\.succeeded/);
  assert.match(fullText, /"schema_version":"run-event@1"/);
  const firstEventId = Number(fullText.match(/^id: (\d+)/m)?.[1]);
  assert.equal(firstEventId, 1);

  const resumed = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/events?cursor=${firstEventId}`);
  const resumedText = await resumed.text();
  assert.equal(resumedText.includes("producer_run.accepted"), false);
  assert.match(resumedText, /producer_run\.succeeded/);

  const headerResumed = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/events`, { headers: { "last-event-id": String(firstEventId) } });
  const headerResumedText = await headerResumed.text();
  assert.equal(headerResumedText.includes("producer_run.accepted"), false);

  const missing = await fetch(`${base}/v1/producer-packets/unknown-packet/events`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "PRODUCER_PACKET_NOT_FOUND");
});

test("a recoverable producer packet failure can be retried into an immutable, unrelated child run", async (t) => {
  let calls = 0;
  const flakyBuilder = (sources, options) => {
    calls += 1;
    if (calls === 1) throw new Error("simulated transient reconciliation failure");
    return buildProducerDecisionPacket(sources, options);
  };
  const { app, base } = await startApp(t, { producerBuilder: flakyBuilder });

  const accepted = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) }).then((response) => response.json());
  await app.producerEngine.waitForIdle(accepted.packet_id);

  const failed = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}`).then((response) => response.json());
  assert.equal(failed.status, "failed");
  assert.equal(failed.state, "failed");
  assert.equal(failed.recovery.recoverable, true);
  assert.deepEqual(failed.recovery.actions, ["retry"]);
  assert.equal(app.store.getProducerPacket(accepted.packet_id), undefined);

  const retryResponse = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(retryResponse.status, 202);
  const child = await retryResponse.json();
  assert.notEqual(child.packet_id, accepted.packet_id);
  assert.equal(child.parent_packet_id, accepted.packet_id);
  assert.equal(child.status, "pending");

  await app.producerEngine.waitForIdle(child.packet_id);
  const childResult = await fetch(`${base}/v1/producer-packets/${child.packet_id}`).then((response) => response.json());
  assert.equal(childResult.status, "succeeded");
  assert.equal(childResult.parent_packet_id, accepted.packet_id);
  assert.equal(childResult.source_inventory.length, mixedEntries.length);

  // The original failed run is never mutated by the retry: its state, error, and lack of a stored
  // packet remain exactly as they were before the child was created.
  const originalAfterRetry = await fetch(`${base}/v1/producer-packets/${accepted.packet_id}`).then((response) => response.json());
  assert.equal(originalAfterRetry.status, "failed");
  assert.deepEqual(originalAfterRetry.recovery, failed.recovery);
  assert.equal(app.store.getProducerPacket(accepted.packet_id), undefined);

  // A terminal succeeded run cannot itself be retried; that is a bounded client conflict.
  const terminalRetry = await fetch(`${base}/v1/producer-packets/${child.packet_id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(terminalRetry.status, 409);
  assert.equal((await terminalRetry.json()).error.code, "PRODUCER_PACKET_NOT_RETRYABLE");

  // Retrying an unknown packet is a bounded not-found error.
  const unknownRetry = await fetch(`${base}/v1/producer-packets/unknown-packet/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unknownRetry.status, 404);

  // Retry rejects a non-empty body.
  const badRetryBody = await fetch(`${base}/v1/producer-packets/${child.packet_id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unexpected: true }) });
  assert.equal(badRetryBody.status, 400);
});

test("a canonical bundle producer packet run resumes on process restart if left active", async (t) => {
  const dataPath = tempPath("resume");
  const first = createApp({ dataPath });
  first.store.createProducerRun({ packetId: "packet_resume_test", bundleId: null, sources: [], provenance: null });
  // Simulate a process restart against the same durable store file: a fresh app instance must pick up
  // the still-active run and drive it to a terminal state without a second creation request.
  const second = createApp({ dataPath });
  await second.producerEngine.waitForIdle("packet_resume_test");
  const resumed = second.store.getProducerRun("packet_resume_test");
  assert.equal(resumed.state, "failed");
  assert.equal(resumed.error.recoverable, true);
});
