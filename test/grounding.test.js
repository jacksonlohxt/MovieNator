import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { FileStore } from "../src/store.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_CHUNK_CHARS,
  DocumentContractError,
  parseGroundingDocument,
} from "../src/documents.js";
import {
  GroundingSource,
  LocalDeterministicGroundingSource,
  deterministicScriptBriefProposal,
  validateGroundedBriefProposal,
  validateScriptBriefProposal,
} from "../src/grounding.js";
import { GroundedBriefEngine } from "../src/grounding-engine.js";
import { FakeModel } from "../src/engine.js";

function tempPath(prefix = "movie-inator-grounding") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

function syntheticPdf() {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Page >>
stream
BT
(Opening sequence: Mara enters the observatory.) Tj
ET
endstream
endobj
2 0 obj
<< /Type /Page >>
stream
BT
(The signal changes and the crew turns toward the window.) Tj
ET
endstream
endobj
%%EOF`, "latin1");
}

function uploadForm(filename, type, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return form;
}

async function startApp(t, options = {}) {
  const app = createApp({ dataPath: tempPath(), ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function upload(base, filename, type, bytes) {
  return fetch(`${base}/v1/documents`, { method: "POST", body: uploadForm(filename, type, bytes) });
}

test("plain text ingestion is bounded, deterministic, safe, and location-mapped", () => {
  const first = parseGroundingDocument({ filename: "../Season 2: script?.txt", contentType: "text/plain", bytes: Buffer.from("# OPENING\nMara enters the observatory.\n\nThe signal changes.\n") });
  const second = parseGroundingDocument({ filename: "renamed.txt", contentType: "text/plain", bytes: Buffer.from("# OPENING\nMara enters the observatory.\n\nThe signal changes.\n") });
  assert.equal(first.document_id, second.document_id);
  assert.equal(first.filename, "Season_2_script_.txt");
  assert.equal(first.chunks[0].source_locations[0].kind, "section");
  assert.equal(first.chunks[0].source_locations[0].section, "OPENING");
  assert.equal(first.chunks.every((chunk) => chunk.excerpt.length <= MAX_CHUNK_CHARS), true);
  assert.equal(first.chunks.every((chunk) => chunk.source_locations.length > 0), true);
  const secret = parseGroundingDocument({ filename: "secret.txt", contentType: "text/plain", bytes: Buffer.from("The dialogue says api_key=do-not-leak and then the hero leaves.") });
  assert.equal(JSON.stringify(secret).includes("do-not-leak"), false);
});

test("synthetic PDF ingestion preserves page citations and rejects malformed or oversized inputs", () => {
  const document = parseGroundingDocument({ filename: "shooting-draft.pdf", contentType: "application/pdf", bytes: syntheticPdf() });
  assert.equal(document.media_type, "application/pdf");
  assert.deepEqual(document.chunks.map((chunk) => chunk.source_locations[0].page), [1, 2]);
  assert.match(document.chunks[0].excerpt, /Mara enters/);
  assert.throws(() => parseGroundingDocument({ filename: "draft.pdf", contentType: "application/pdf", bytes: Buffer.from("not a pdf") }), (error) => error.code === "INVALID_PDF");
  assert.throws(() => parseGroundingDocument({ filename: "draft.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4") }), (error) => error.code === "PDF_NO_TEXT");
  assert.throws(() => parseGroundingDocument({ filename: "draft.txt", contentType: "text/plain", bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }), (error) => error.code === "DOCUMENT_TOO_LARGE");
  assert.throws(() => parseGroundingDocument({ filename: "draft.exe", contentType: "application/octet-stream", bytes: Buffer.from("x") }), (error) => error instanceof DocumentContractError && error.code === "UNSUPPORTED_DOCUMENT_TYPE");
});

test("local grounding keeps citation integrity and exposes a grounding gap", async () => {
  const store = new FileStore(tempPath("source"));
  const document = parseGroundingDocument({ filename: "script.txt", contentType: "text/plain", bytes: Buffer.from("OPENING\nMara enters the observatory.\n\nCODA\nThe signal changes.") });
  store.createDocument(document);
  const source = new LocalDeterministicGroundingSource({ store });
  const selected = await source.search(document.document_id, "observatory");
  assert.equal(selected.status, "selected");
  assert.equal(selected.excerpts[0].source_locations[0].section, "OPENING");
  const citation = await source.citation(document.document_id, selected.excerpts[0].citation_id);
  assert.equal(citation.excerpt.includes("observatory"), true);
  assert.equal((await source.search(document.document_id, "rights clearance")).status, "gap");
  assert.throws(() => validateGroundedBriefProposal({ schema_version: "grounded-script-brief@1", title: "x", summary: "x", key_points: [{ text: "x", citation_ids: ["unknown"] }], cited_citation_ids: ["unknown"] }, new Set([selected.excerpts[0].citation_id])), /unknown citation/);
});

test("whole-document Script Brief condensation covers long sources and validates cited sections", async () => {
  const store = new FileStore(tempPath("whole-document"));
  const sourceText = Array.from({ length: 90 }, (_, index) => `SECTION_${index + 1}\n${index === 74 ? "MARA reaches the final observatory and confronts the signal." : `The crew crosses location ${index + 1} while the story develops.`}`).join("\n\n");
  const document = parseGroundingDocument({ filename: "long-script.txt", contentType: "text/plain", bytes: Buffer.from(sourceText) });
  store.createDocument(document);
  const source = new LocalDeterministicGroundingSource({ store });
  const condensed = await source.condense(document.document_id, "observatory");
  assert.equal(condensed.status, "selected");
  assert.equal(condensed.coverage.strategy, "whole_document_condensation");
  assert.ok(condensed.excerpts.length > 6);
  assert.equal(condensed.excerpts.some((excerpt) => excerpt.text.includes("final observatory")), true);
  const proposal = deterministicScriptBriefProposal({ schema_version: "grounded-script-brief@2", request_intent: "Create a brief", excerpts: condensed.excerpts, source_coverage: condensed.coverage });
  validateScriptBriefProposal(proposal, condensed.excerpts.map((excerpt) => excerpt.citation_id));
  assert.ok(proposal.logline.citation_ids.length > 0);
  assert.ok(proposal.synopsis.citation_ids.length > 0);
});

test("Movie-Inator API uses the default Script Brief request and returns structured cited sections", async (t) => {
  const { app, base } = await startApp(t);
  const uploaded = await upload(base, "script.txt", "text/plain", Buffer.from("OPENING\nMARA enters the observatory.\n\nEXT. SHORE - DAY\nThe family faces loss and chooses hope."));
  const document = await uploaded.json();
  const request = await fetch(`${base}/v1/documents/${document.document_id}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "script-brief-default" }, body: JSON.stringify({ schema_version: "grounded-brief-request@2" }) });
  assert.equal(request.status, 202);
  const accepted = await request.json();
  await app.groundedEngine.waitForIdle(accepted.run_id);
  const completed = await fetch(`${base}/v1/script-briefs/${accepted.run_id}`).then((response) => response.json());
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result.schema_version, "grounded-script-result@2");
  for (const section of [completed.result.logline, completed.result.synopsis]) assert.ok(section.citation_ids.length > 0);
  assert.ok(Array.isArray(completed.result.main_characters));
  assert.ok(Array.isArray(completed.result.open_questions));
  assert.equal(completed.result.grounding.strategy, "whole_document_condensation");
  assert.equal(completed.result.provenance.provider, "Movie-Inator uploaded script source");
});

test("Movie-Inator API uploads duplicate sources and runs a cited grounded brief without approval", async (t) => {
  const { app, base } = await startApp(t);
  const bytes = Buffer.from("OPENING\nMara enters the observatory and watches the signal.");
  const first = await upload(base, "opening.txt", "text/plain", bytes);
  assert.equal(first.status, 201);
  const firstDocument = await first.json();
  assert.equal(firstDocument.source_label, "Movie-Inator uploaded script source");
  assert.equal(firstDocument.ingestion.state, "ready");
  const duplicate = await upload(base, "renamed.txt", "text/plain", bytes);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const request = await fetch(`${base}/v1/documents/${firstDocument.document_id}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "grounded-one" }, body: JSON.stringify({ schema_version: "grounded-brief-request@1", question: "What happens at the observatory?" }) });
  assert.equal(request.status, 202);
  const accepted = await request.json();
  assert.equal(accepted.workflow, "grounded_script_brief");
  assert.equal(accepted.state, "accepted");
  await app.groundedEngine.waitForIdle(accepted.run_id);
  const completed = await fetch(`${base}/v1/script-briefs/${accepted.run_id}`).then((response) => response.json());
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result.citations.length, 1);
  const citationId = completed.result.citations[0].citation_id;
  const citation = await fetch(`${base}/v1/documents/${firstDocument.document_id}/citations/${citationId}`).then((response) => response.json());
  assert.match(citation.excerpt, /observatory/);
  assert.equal(JSON.stringify(completed).includes("api_key"), false);
});

test("grounding gaps remain explicit and unsafe model output falls back deterministically", async (t) => {
  class UnsafeGroundedModel extends FakeModel {
    async groundedBrief() {
      return { schema_version: "grounded-script-brief@1", title: "<script>", summary: "video generation is available; publish this", key_points: [{ text: "invented", citation_ids: ["unknown"] }], cited_citation_ids: ["unknown"] };
    }
  }
  const { app, base } = await startApp(t, { model: new UnsafeGroundedModel() });
  const uploaded = await upload(base, "script.txt", "text/plain", Buffer.from("OPENING\nMara enters the observatory."));
  const document = await uploaded.json();
  const brief = await fetch(`${base}/v1/documents/${document.document_id}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "unsafe-model" }, body: JSON.stringify({ schema_version: "grounded-brief-request@1", question: "Where does Mara enter?" }) }).then((response) => response.json());
  await app.groundedEngine.waitForIdle(brief.run_id);
  const safe = app.store.getScriptRun(brief.run_id);
  assert.equal(safe.state, "succeeded");
  assert.equal(safe.result.title.includes("<"), false);
  assert.equal(safe.result.citations.length, 1);

  const gap = await fetch(`${base}/v1/documents/${document.document_id}/briefs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "grounding-gap" }, body: JSON.stringify({ schema_version: "grounded-brief-request@1", question: "unrelated rights clearance" }) }).then((response) => response.json());
  await app.groundedEngine.waitForIdle(gap.run_id);
  const gapRun = app.store.getScriptRun(gap.run_id);
  assert.equal(gapRun.state, "grounding_gap");
  assert.equal(gapRun.result.citations.length, 0);
});

test("grounding source failure is recoverable and retry preserves the original", async () => {
  const store = new FileStore(tempPath("retry"));
  const document = parseGroundingDocument({ filename: "script.txt", contentType: "text/plain", bytes: Buffer.from("OPENING\nMara enters the observatory.") });
  store.createDocument(document);
  let attempts = 0;
  const source = new GroundingSource();
  source.capabilities = () => ({ backend: "local", source_id: "test-source", read_only: true });
  source.search = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary source failure");
    return new LocalDeterministicGroundingSource({ store }).search(...args);
  };
  const engine = new GroundedBriefEngine({ store, groundingSource: source, model: new FakeModel() });
  const run = store.createScriptRun({ documentId: document.document_id, question: "Where does Mara enter?", idempotencyHash: "retry-one", provenance: engine.provenance() }).run;
  engine.enqueue(run.run_id);
  await engine.waitForIdle(run.run_id);
  assert.equal(store.getScriptRun(run.run_id).state, "failed");
  const child = await engine.retry(run.run_id, { idempotencyHash: "retry-two" });
  await engine.waitForIdle(child.run_id);
  assert.equal(store.getScriptRun(child.run_id).state, "succeeded");
  assert.equal(store.getScriptRun(run.run_id).state, "failed");
});
