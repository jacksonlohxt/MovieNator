import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import {
  MAX_PRODUCER_SOURCES,
  PRODUCER_PACKET_SCHEMA,
  PRODUCER_PACKET_SCHEMA_LEGACY,
  buildProducerDecisionPacket,
  parseProducerSource,
  producerBundleId,
  producerBundleManifestHash,
  safeProducerPacketProjection,
} from "../src/producer-consolidation.js";
import { MAX_DOCUMENT_BYTES, parseGroundingDocument } from "../src/documents.js";

function tempPath(prefix = "movie-inator-producer") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

function source(filename, source_kind, text) {
  return parseProducerSource({ filename, source_kind, contentType: "text/plain", bytes: Buffer.from(text) });
}

function bundleForm(entries, { schema = "producer-source-bundle@1", extra = undefined } = {}) {
  const form = new FormData();
  form.append("schema_version", schema);
  for (const entry of entries) {
    form.append("source_kind", entry.source_kind);
    form.append("file", new Blob([entry.text], { type: "text/plain" }), entry.filename);
  }
  if (extra) form.append(extra, "not allowed");
  return form;
}

function northlineEntries() {
  return [
    { filename: "northline-shooting-script.txt", source_kind: "primary_screenplay", text: "SHOOTING DRAFT 3\nSCENE 7 - INT. MILL - NIGHT\nMara enters the mill." , version_label: "shooting draft 3" },
    { filename: "northline-location-access.txt", source_kind: "location_access", text: "Permission status: permission pending\nOwner: Jo - Locations\nNo location hold is confirmed." },
    { filename: "northline-schedule-assumption.txt", source_kind: "schedule_assumptions", text: "Assumption: Scene 7 is on a Mill hold for 12 June" },
    { filename: "northline-budget-input.txt", source_kind: "budget_assumptions", text: "Access rate: $1,200 per access day" },
  ];
}

function canonicalBundleForm(entries = northlineEntries()) {
  const form = new FormData();
  form.append("manifest", JSON.stringify({ schema_version: "producer-source-bundle@1", sources: entries.map((entry, index) => ({ input_ref: `northline_${index + 1}`, filename: entry.filename, source_kind: entry.source_kind, ...(entry.version_label ? { version_label: entry.version_label } : {}) })) }));
  for (const entry of entries) form.append("file", new Blob([entry.text], { type: "text/plain" }), entry.filename);
  return form;
}

async function startApp(t) {
  const app = createApp({ dataPath: tempPath() });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

const mixedEntries = [
  { filename: "script.txt", source_kind: "script", text: "OPENING\nINT. WAREHOUSE - NIGHT\nMara enters the warehouse." },
  { filename: "director.txt", source_kind: "director_notes", text: "Location: Riverside Studio\nThe director requires a quiet, tense performance." },
  { filename: "cast.txt", source_kind: "cast_actor_notes", text: "ROLE: Mara - Ana\nStunt: harness rehearsal is pending." },
  { filename: "location.txt", source_kind: "location_production_notes", text: "LOCATION: Warehouse 12\nPermit status: pending." },
  { filename: "schedule.txt", source_kind: "schedule", text: "VERSION: 2\nSHOOT DATE: 2026-08-22\nCall time: 06:00." },
  { filename: "budget.txt", source_kind: "budget", text: "BUDGET: $12,000\nContingency: $1,000." },
  { filename: "lighting.txt", source_kind: "department_notes", text: "Lighting: practical fixtures and a night setup." },
];

test("producer consolidation keeps mixed source kinds, exact locations, and citation integrity", () => {
  const sources = mixedEntries.map((entry) => source(entry.filename, entry.source_kind, entry.text));
  const packet = buildProducerDecisionPacket(sources, { createdAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA_LEGACY);
  assert.equal(packet.workflow, "producer_consolidation");
  assert.equal(packet.source_inventory.length, mixedEntries.length);
  assert.deepEqual(packet.source_inventory.map((item) => item.source_kind), mixedEntries.map((entry) => entry.source_kind));
  assert.equal(packet.source_inventory.every((item) => item.source_id.startsWith("source_")), true);
  assert.equal(packet.source_inventory.find((item) => item.source_kind === "schedule").version_provenance.source_version, "2");
  assert.equal(packet.source_inventory.find((item) => item.source_kind === "schedule").version_provenance.source_version_status, "stated_in_uploaded_source");
  assert.equal(packet.version_provenance.sources.length, mixedEntries.length);
  assert.equal(packet.reconciliation.topics.some((topic) => topic.topic === "location"), true);
  assert.equal(packet.executive_summary.claim_type, "fact");
  assert.equal(packet.production_decisions.every((item) => item.claim_type === "inference"), true);
  assert.equal(packet.gaps_or_questions.every((item) => item.claim_type === "unknown"), true);
  assert.equal(packet.locations_and_timing.some((item) => item.text === "INT. WAREHOUSE - NIGHT"), true);
  assert.equal(packet.locations_and_timing.some((item) => item.text === "LOCATION: Warehouse 12"), true);
  assert.equal(packet.locations_and_timing.some((item) => item.text === "SHOOT DATE: 2026-08-22"), true);
  assert.equal(packet.cast_role_demands.some((item) => item.text.includes("ROLE: Mara - Ana")), true);
  assert.equal(packet.department_requirements.some((item) => item.text.includes("Lighting: practical fixtures")), true);
  const citationIds = new Set(packet.citations.map((citation) => citation.citation_id));
  for (const item of [packet.executive_summary, ...packet.production_decisions, ...packet.locations_and_timing, ...packet.cast_role_demands, ...packet.department_requirements, ...packet.risks_or_conflicts, ...packet.gaps_or_questions]) {
    assert.ok(item.citation_ids.length > 0, item.text);
    for (const citationId of item.citation_ids) assert.equal(citationIds.has(citationId), true, citationId);
  }
  const locationCitation = packet.citations.find((citation) => citation.excerpt.includes("LOCATION: Warehouse 12"));
  assert.ok(locationCitation);
  assert.equal(locationCitation.source_kind, "location_production_notes");
  assert.equal(locationCitation.source_locations[0].section, "Document");
  assert.match(locationCitation.excerpt, /Permit status: pending/);
});

test("producer packet surfaces contradictions as conflicts and does not invent missing facts", () => {
  const packet = buildProducerDecisionPacket([
    source("director.txt", "director_notes", "Location: Riverside Studio\nThe director wants a warm look."),
    source("location.txt", "location_production_notes", "LOCATION: Warehouse 12"),
    source("script.txt", "script", "OPENING\nMara enters."),
  ], { createdAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(packet.risks_or_conflicts.some((item) => item.kind === "conflict" && item.text.includes("Riverside Studio") && item.text.includes("Warehouse 12")), true);
  assert.equal(packet.cross_document_conflicts.length, 1);
  assert.equal(packet.reconciliation.topics.find((topic) => topic.topic === "location").status, "conflict");
  assert.equal(packet.gaps_or_questions.some((item) => item.text.includes("No budget amount is established") && item.claim_type === "unknown"), true);
  assert.equal(packet.decision_register.some((item) => item.priority === "high" && item.owner_role === "producer" && item.type === "question"), true);
  assert.equal(packet.handoff.status, "review_required");
  assert.equal(packet.handoff.open_register_ids.length, packet.decision_register.length);
  assert.equal(JSON.stringify(packet).includes("permit status is approved"), false);
  assert.equal(JSON.stringify(packet).includes("approved permit"), false);
});

test("producer reconciliation identifies duplicate source content without hiding the source records", () => {
  const first = source("schedule.txt", "schedule", "SHOOT DATE: 2026-08-22");
  const copy = source("schedule-copy.txt", "schedule", "SHOOT DATE: 2026-08-22");
  const packet = buildProducerDecisionPacket([first, copy], { createdAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(packet.source_inventory.length, 2);
  assert.equal(packet.reconciliation.duplicate_groups.length, 1);
  assert.equal(packet.reconciliation.duplicate_groups[0].duplicate_count, 2);
  assert.deepEqual(packet.reconciliation.duplicate_groups[0].filenames, ["schedule.txt", "schedule-copy.txt"]);
});

test("producer source identity is stable while source labels remain distinct", () => {
  const first = source("notes.txt", "schedule", "SHOOT DATE: 2026-08-22");
  const renamed = source("renamed.txt", "schedule", "SHOOT DATE: 2026-08-22");
  const otherKind = source("notes.txt", "budget", "SHOOT DATE: 2026-08-22");
  assert.equal(first.document_id, renamed.document_id);
  assert.equal(first.source_id, renamed.source_id);
  assert.equal(first.source_id === otherKind.source_id, false);
  assert.equal(first.source_label, "Schedule");
  assert.equal(otherKind.source_label, "Budget");
});

test("producer HTTP flow returns a safe packet and preserves packet retrieval", async (t) => {
  const { app, base } = await startApp(t);
  const accepted = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) });
  assert.equal(accepted.status, 202);
  const accepted_body = await accepted.json();
  assert.equal(accepted_body.status, "pending");
  assert.ok(["accepted", "queued", "running", "succeeded"].includes(accepted_body.state) || accepted_body.state === undefined);
  await app.producerEngine.waitForIdle(accepted_body.packet_id);
  const packet = await (await fetch(`${base}/v1/producer-packets/${accepted_body.packet_id}`)).json();
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA_LEGACY);
  assert.equal(packet.bundle_id, null);
  assert.equal(packet.source_inventory.length, mixedEntries.length);
  assert.equal(JSON.stringify(packet).includes("prompt"), false);
  assert.equal(JSON.stringify(packet).includes("chunks"), false);
  assert.equal(packet.citations.every((citation) => citation.excerpt.length <= 900), true);
  const duplicate = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(mixedEntries) });
  assert.equal(duplicate.status, 200);
  const retrieved = await fetch(`${base}/v1/producer-packets/${packet.packet_id}`);
  assert.equal(retrieved.status, 200);
  assert.deepEqual(await retrieved.json(), packet);
  const citation = packet.citations[0];
  const citationResponse = await fetch(`${base}/v1/producer-packets/${packet.packet_id}/citations/${citation.citation_id}`);
  assert.equal(citationResponse.status, 200);
  assert.equal((await citationResponse.json()).citation_id, citation.citation_id);
  assert.equal((await fetch(`${base}/v1/producer-packets/unknown`)).status, 404);
  assert.equal(app.store.getProducerPacket(packet.packet_id).provenance.external, false);
});

test("producer HTTP boundary rejects unknown fields, malformed labels, and oversized bundles", async (t) => {
  const { base } = await startApp(t);
  const unknown = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm([{ filename: "script.txt", source_kind: "script", text: "Mara enters." }], { extra: "unsafe" }) });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "UNKNOWN_FIELD");
  const malformed = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm([{ filename: "script.txt", source_kind: "provider:gemini", text: "Mara enters." }]) });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_SOURCE_KIND");
  const tooMany = await fetch(`${base}/v1/producer-packets`, { method: "POST", body: bundleForm(Array.from({ length: MAX_PRODUCER_SOURCES + 1 }, (_, index) => ({ filename: `source-${index}.txt`, source_kind: "other", text: "A bounded note." }))) });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error.code, "INVALID_BUNDLE");
  assert.throws(() => parseProducerSource({ filename: "too-large.txt", source_kind: "other", contentType: "text/plain", bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }), (error) => error.code === "DOCUMENT_TOO_LARGE");
  assert.throws(() => parseGroundingDocument({ filename: "bad.pdf", contentType: "application/pdf", bytes: Buffer.from("not a pdf") }), (error) => error.code === "INVALID_PDF");
});

test("safe producer projection is bounded and strips internal source chunks", () => {
  const packet = buildProducerDecisionPacket([source("secret.txt", "other", "A source says api_key=do-not-leak.")]);
  const safe = safeProducerPacketProjection(packet);
  assert.equal(JSON.stringify(safe).includes("chunks"), false);
  assert.equal(JSON.stringify(safe).includes("do-not-leak"), false);
  assert.equal(safe.source_inventory[0].source_kind, "other");
  assert.equal(safe.citations.every((citation) => citation.excerpt.length <= 900), true);
});

test("Northline Producer Intake proof preserves classifications, hashes, both conflict sides, and exact next action", () => {
  const entries = northlineEntries();
  const sources = entries.map((entry, index) => parseProducerSource({ ...entry, contentType: "text/plain", bytes: Buffer.from(entry.text), input_ref: `northline_${index + 1}` }));
  const packet = buildProducerDecisionPacket(sources, { createdAt: "2026-08-23T00:00:00.000Z" });
  assert.equal(packet.source_manifest.length, 4);
  assert.equal(packet.source_manifest.find((item) => item.source_kind === "primary_screenplay").version_label, "shooting draft 3");
  assert.equal(packet.source_manifest.find((item) => item.source_kind === "location_access").status_label, "permission pending");
  assert.equal(packet.source_manifest.every((item) => /^src_[a-z0-9]+$/.test(item.source_id) && /^sha256:[a-f0-9]+$/.test(item.content_hash)), true);
  assert.equal(packet.exact_facts.some((item) => item.value === "SCENE 7 - INT. MILL - NIGHT" && item.classification === "source_fact" && item.evidence_state === "established"), true);
  assert.equal(packet.scene_index[0].citation_ids.length, 1);
  assert.equal(packet.citations.find((item) => item.citation_id === packet.scene_index[0].citation_ids[0]).excerpt.includes("SCENE 7 - INT. MILL - NIGHT"), true);
  assert.equal(packet.budget_inputs[0].value, "$1,200");
  assert.equal(packet.budget_inputs[0].unit, "access day");
  assert.equal(packet.budget_inputs[0].currency, "USD");
  assert.equal(packet.budget_inputs[0].classification, "externally_supplied_fact");
  assert.equal(packet.budget_inputs[0].evidence_state, "supplied_not_verified");
  assert.equal(Object.hasOwn(packet.budget_inputs[0], "total"), false);
  assert.equal(packet.rights_access_logistics.some((item) => item.owner === "Jo - Locations" && item.priority === "unset"), true);
  assert.equal(packet.conflicts.length, 1);
  assert.equal(packet.conflicts[0].assertions.length, 2);
  assert.match(packet.conflicts[0].assertions[0].text, /Mill hold/);
  assert.match(packet.conflicts[0].assertions[1].text, /No location hold is confirmed/);
  assert.equal(packet.decision_question_register[0].priority, "unset");
  assert.equal(packet.decision_question_register[0].next_action, "obtain or record the access evidence");
  assert.equal(packet.gaps_and_next_steps[0].next_action, "obtain or record the access evidence");
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(packet.bundle_id, producerBundleId(sources));
  assert.equal(packet.provenance.mode, "demo");
  assert.equal(packet.provenance.retention_state, "local");
  assert.equal(packet.provenance.contract_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(packet.provenance.bundle_manifest_hash, producerBundleManifestHash(sources));
  assert.match(packet.provenance.source_manifest_hash, /^sha256:[a-f0-9]+$/);
  assert.equal(packet.provenance.fallback_used, false);
  assert.equal(packet.provenance.grounding_strategy, "bounded_source_manifest_and_deterministic_reconciliation");
  const safe = safeProducerPacketProjection(packet);
  assert.equal(safe.schema_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(safe.bundle_id, packet.bundle_id);
});

test("strict Producer Intake bundle and handoff routes provide safe failures, citations, copy/export projections", async (t) => {
  const { app, base } = await startApp(t);
  const accepted = await fetch(`${base}/v1/producer-source-bundles`, { method: "POST", body: canonicalBundleForm() });
  assert.equal(accepted.status, 201);
  const bundle = await accepted.json();
  assert.equal(bundle.source_count, 4);
  assert.equal(bundle.source_manifest.every((source) => source.content_hash.startsWith("sha256:")), true);
  const retrievedBundle = await fetch(`${base}/v1/producer-source-bundles/${bundle.bundle_id}`);
  assert.equal(retrievedBundle.status, 200);
  const packetResponse = await fetch(`${base}/v1/producer-source-bundles/${bundle.bundle_id}/packets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "producer-intake-request@1", bundle_id: bundle.bundle_id }) });
  assert.equal(packetResponse.status, 202);
  const packetAccepted = await packetResponse.json();
  assert.equal(packetAccepted.status, "pending");
  await app.producerEngine.waitForIdle(packetAccepted.packet_id);
  const packet = await (await fetch(`${base}/v1/producer-packets/${packetAccepted.packet_id}`)).json();
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(packet.bundle_id, bundle.bundle_id);
  assert.equal(packet.provenance.contract_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(packet.provenance.bundle_manifest_hash, bundle.manifest_hash);
  assert.equal(packet.scene_index[0].scene_heading, "SCENE 7 - INT. MILL - NIGHT");
  const citation = packet.citations.find((item) => item.excerpt.includes("SCENE 7 - INT. MILL - NIGHT"));
  assert.ok(citation);
  assert.equal((await fetch(`${base}/v1/producer-packets/${packet.packet_id}/citations/${citation.citation_id}`)).status, 200);
  const markdown = await fetch(`${base}/v1/producer-packets/${packet.packet_id}/handoff?format=markdown`);
  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /obtain or record the access evidence/);
  const jsonHandoff = await fetch(`${base}/v1/producer-packets/${packet.packet_id}/handoff?format=json`);
  assert.equal(jsonHandoff.status, 200);
  const handoff = await jsonHandoff.json();
  assert.equal(handoff.schema_version, "producer-read-only-handoff@1");
  assert.equal(JSON.stringify(handoff).includes("Mara enters"), false);
  const csvHandoff = await fetch(`${base}/v1/producer-packets/${packet.packet_id}/handoff?format=csv`);
  assert.equal(csvHandoff.status, 200);
  assert.match(csvHandoff.headers.get("content-type") || "", /text\/csv/);
  const csvText = await csvHandoff.text();
  assert.match(csvText, /^"section","label","classification","evidence_state","value","owner","priority","citation_ids"/);
  assert.match(csvText, /obtain or record the access evidence/);
  assert.equal(csvText.includes("Mara enters"), false);
  const badFormat = await fetch(`${base}/v1/producer-packets/${packet.packet_id}/handoff?format=xml`);
  assert.equal(badFormat.status, 400);
  assert.equal((await badFormat.json()).error.code, "UNSUPPORTED_EXPORT_FORMAT");

  const noPrimaryEntries = northlineEntries().map((entry) => ({ ...entry }));
  noPrimaryEntries[0].source_kind = "other";
  const noPrimary = await fetch(`${base}/v1/producer-source-bundles`, { method: "POST", body: canonicalBundleForm(noPrimaryEntries) });
  assert.equal(noPrimary.status, 400);
  assert.equal((await noPrimary.json()).error.code, "PRIMARY_SOURCE_REQUIRED");
  assert.equal(app.store.getProducerPacket(packet.packet_id).provenance.external, false);
});

test("producer browser DOM contract exposes proof sections, citation focus hooks, safe copy, and exports", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "web/index.html"), "utf8");
  const app = fs.readFileSync(path.join(process.cwd(), "web/app.js"), "utf8");
  for (const id of ["producer-source-inventory", "producer-facts", "producer-scenes", "producer-budget-inputs", "producer-access", "producer-conflicts", "producer-questions", "producer-next-steps", "copy-producer-handoff", "export-producer-markdown", "export-producer-json", "export-producer-csv", "evidence-drawer"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /openProducerCitation/);
  assert.match(app, /lastFocused = document\.activeElement/);
  assert.match(app, /copyProducerHandoff/);
  assert.match(app, /handoff\?format=markdown/);
  assert.match(app, /handoff\?format=json/);
  assert.match(app, /handoff\?format=csv/);
  assert.match(app, /textContent = citation\.excerpt/);
});
