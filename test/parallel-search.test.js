import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";
import { PRODUCER_PACKET_SCHEMA, PRODUCER_PACKET_SCHEMA_LEGACY, buildProducerDecisionPacket, parseProducerSource } from "../src/producer-consolidation.js";
import {
  ParallelSearchClient,
  ParallelSearchError,
  buildParallelEnrichmentRequests,
  createParallelEnrichedProducerBuilder,
  enrichProducerPacketWithParallelEvidence,
  mapParallelResultsToEvidence,
  readParallelApiKey,
  readParallelConfig,
} from "../src/parallel-search.js";

function tempPath(prefix = "movie-inator-parallel") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(directory, "runs.json");
}

function canonicalSource(filename, source_kind, text, extra = {}) {
  return parseProducerSource({ filename, source_kind, contentType: "text/plain", bytes: Buffer.from(text), ...extra });
}

function northlineEntries() {
  return [
    canonicalSource("northline-shooting-script.txt", "primary_screenplay", "SHOOTING DRAFT 3\nSCENE 7 - INT. MILL - NIGHT\nMara enters the mill."),
    canonicalSource("northline-location-access.txt", "location_access", "Permission status: permission pending\nOwner: Jo - Locations\nNo location hold is confirmed."),
    canonicalSource("northline-schedule-assumption.txt", "schedule_assumptions", "Assumption: Scene 7 is on a Mill hold for 12 June"),
    canonicalSource("northline-budget-input.txt", "budget_assumptions", "Access rate: $1,200 per access day"),
  ];
}

function minorStuntEntries() {
  return [
    canonicalSource("minor-script.txt", "primary_screenplay", "SCENE 1 - INT. GYM - DAY\nA 9-year-old child watches as the stunt double leaps from the roof."),
  ];
}

function canonicalPacket(entries = northlineEntries()) {
  return buildProducerDecisionPacket(entries, { createdAt: "2026-01-01T00:00:00.000Z" });
}

function legacyPacket() {
  const entries = [
    parseProducerSource({ filename: "script.txt", source_kind: "script", contentType: "text/plain", bytes: Buffer.from("INT. WAREHOUSE - NIGHT\nMara enters.") }),
    parseProducerSource({ filename: "director.txt", source_kind: "director_notes", contentType: "text/plain", bytes: Buffer.from("Location: Riverside Studio") }),
  ];
  return buildProducerDecisionPacket(entries, { createdAt: "2026-01-01T00:00:00.000Z" });
}

class MockParallelClient {
  constructor({ resultsByTopic = {}, failTopics = new Set(), failWith } = {}) {
    this.resultsByTopic = resultsByTopic;
    this.failTopics = failTopics;
    this.failWith = failWith;
    this.calls = [];
    this.config = readParallelConfig({ PARALLEL_API_KEY: "mock-key" });
  }

  async search({ objective, search_queries, mode }) {
    // Mirror the real SDK's request shape: snake_case body with objective + search_queries.
    this.calls.push({ objective, search_queries, mode });
    const topic = this.currentTopic;
    if (this.failTopics.has(topic)) throw this.failWith || new Error("synthetic failure");
    return this.resultsByTopic[topic] || { search_id: `search_${topic}`, session_id: "session_1", results: [] };
  }
}

// ParallelSearchClient.search() calls client.search(body, options); wrap a mock so it can still track
// which topic is being requested (the objective text encodes it) without changing the SDK-shaped call.
function mockClientTrackingTopic(options) {
  const mock = new MockParallelClient(options);
  const wrapped = {
    config: mock.config,
    calls: mock.calls,
    async search(body, requestOptions) {
      mock.currentTopic = /location_permit|permit lead times/i.test(body.objective || "") ? "location_permit"
        : /minor|child labor/i.test(body.objective || "") ? "minor_labor_rules"
        : /stunt/i.test(body.objective || "") ? "stunt_turnaround"
        : /vendor and day-rate/i.test(body.objective || "") ? "vendor_day_rate"
        : "unknown";
      return mock.search(body, requestOptions);
    },
  };
  return wrapped;
}

test("readParallelConfig is off by default and on only when PARALLEL_API_KEY is set", () => {
  const off = readParallelConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.configured, false);
  assert.equal(readParallelApiKey({}), undefined);

  const on = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  assert.equal(on.enabled, true);
  assert.equal(on.configured, true);
  assert.equal(on.mode, "advanced");
  assert.equal(readParallelApiKey({ PARALLEL_API_KEY: "sk-test" }), "sk-test");

  const explicitlyDisabled = readParallelConfig({ PARALLEL_API_KEY: "sk-test", PARALLEL_ENABLED: "false" });
  assert.equal(explicitlyDisabled.configured, true);
  assert.equal(explicitlyDisabled.enabled, false);

  const customMode = readParallelConfig({ PARALLEL_API_KEY: "sk-test", PARALLEL_SEARCH_MODE: "turbo" });
  assert.equal(customMode.mode, "turbo");

  // readParallelConfig never returns the raw key, so it is always safe to log or embed in provenance.
  assert.equal(JSON.stringify(on).includes("sk-test"), false);
});

test("ParallelSearchClient genuinely imports and calls the real parallel-web SDK when no client is injected", async () => {
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const client = new ParallelSearchClient({ config, apiKey: "sk-test" });
  const controller = new AbortController();
  controller.abort();
  // An already-aborted signal makes fetch reject before any socket is opened, so this proves the real
  // `Parallel` client is constructed and `.search()` is genuinely invoked with zero live network I/O.
  await assert.rejects(
    () => client.search({ objective: "test", searchQueries: ["film location permit lead time"], signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof ParallelSearchError);
      assert.equal(error.code, "canceled");
      return true;
    },
  );
});

test("ParallelSearchClient refuses to call when disabled and never touches the injected client", async () => {
  const client = new ParallelSearchClient({ config: readParallelConfig({}), client: new MockParallelClient() });
  await assert.rejects(() => client.search({ objective: "x", searchQueries: ["film location permit lead time"] }), (error) => {
    assert.equal(error.code, "missing_configuration");
    return true;
  });
});

test("ParallelSearchClient maps injected mock errors to bounded, typed error codes", async () => {
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const cases = [
    { error: Object.assign(new Error("denied"), { status: 401 }), code: "auth_denied" },
    { error: Object.assign(new Error("denied"), { status: 403 }), code: "auth_denied" },
    { error: Object.assign(new Error("limited"), { status: 429 }), code: "rate_limit" },
    { error: Object.assign(new Error("boom"), { status: 500 }), code: "server_failure" },
    { error: new Error("unknown"), code: "server_failure" },
  ];
  for (const { error, code } of cases) {
    const failing = { config, async search() { throw error; } };
    const client = new ParallelSearchClient({ config, client: failing });
    await assert.rejects(() => client.search({ objective: "x", searchQueries: ["film location permit lead time"] }), (thrown) => {
      assert.ok(thrown instanceof ParallelSearchError, `expected ParallelSearchError for status; got ${thrown}`);
      assert.equal(thrown.code, code);
      return true;
    });
  }
});

test("ParallelSearchClient sends the exact SDK-shaped request: objective, 2-3 short keyword queries, and mode", async () => {
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const mock = new MockParallelClient({ resultsByTopic: {} });
  mock.currentTopic = "location_permit";
  const client = new ParallelSearchClient({ config, client: mock });
  await client.search({ objective: "Research permit lead times", searchQueries: ["film location permit lead time", "location filming permit requirements"] });
  assert.equal(mock.calls.length, 1);
  const [call] = mock.calls;
  assert.equal(call.objective, "Research permit lead times");
  assert.ok(Array.isArray(call.search_queries));
  assert.ok(call.search_queries.length >= 1 && call.search_queries.length <= 3);
  for (const query of call.search_queries) {
    const wordCount = query.trim().split(/\s+/).length;
    assert.ok(wordCount >= 3 && wordCount <= 6, `query "${query}" must be 3-6 words`);
  }
  assert.equal(call.mode, "advanced");
});

test("buildParallelEnrichmentRequests deterministically selects topics relevant to the bundle, capped at maxTopics", () => {
  const packet = canonicalPacket();
  const requests = buildParallelEnrichmentRequests(packet, { maxTopics: 2 });
  assert.deepEqual(requests.map((request) => request.topic), ["location_permit", "vendor_day_rate"]);
  assert.ok(requests.every((request) => request.objective.includes("Singapore")));
  for (const request of requests) {
    assert.ok(request.objective.length > 0);
    assert.ok(request.searchQueries.length >= 1 && request.searchQueries.length <= 3);
  }
  // Same input always produces the same requests (no randomness).
  assert.deepEqual(buildParallelEnrichmentRequests(packet, { maxTopics: 2 }), requests);

  const minorStuntPacket = canonicalPacket(minorStuntEntries());
  const minorStuntRequests = buildParallelEnrichmentRequests(minorStuntPacket, { maxTopics: 4 });
  assert.deepEqual(minorStuntRequests.map((request) => request.topic), ["location_permit", "minor_labor_rules", "stunt_turnaround"]);

  assert.deepEqual(buildParallelEnrichmentRequests(packet, { maxTopics: 1 }).map((request) => request.topic), ["location_permit"]);

  const regionalPacket = { ...packet, target_region: "United Kingdom" };
  const regionalLocationRequest = buildParallelEnrichmentRequests(regionalPacket, { maxTopics: 1 })[0];
  assert.match(regionalLocationRequest.objective, /United Kingdom/);
  assert.ok(regionalLocationRequest.searchQueries.every((query) => query.includes("United Kingdom")));
});

test("mapParallelResultsToEvidence produces cited, clearly-labelled external evidence and drops unsafe URLs", () => {
  const response = {
    results: [
      { title: "City Film Office Permit Guide", url: "https://film.example.gov/permits", excerpts: ["Typical lead time is 10 business days."] },
      { title: "Bad result", url: "javascript:alert(1)", excerpts: ["should be dropped"] },
      { title: "No excerpt result", url: "https://example.com/no-excerpt", excerpts: [] },
    ],
  };
  const { evidenceItems, citations } = mapParallelResultsToEvidence({ topic: "location_permit", objective: "obj", searchQueries: ["q1"], response, maxResultsPerTopic: 5 });
  assert.equal(citations.length, 2);
  assert.equal(evidenceItems.length, 2);
  const [first, second] = evidenceItems;
  assert.equal(first.classification, "externally_researched_fact");
  assert.equal(first.evidence_state, "externally_researched_not_verified");
  assert.equal(first.citation_ids.length, 1);
  assert.match(first.text, /City Film Office Permit Guide/);
  assert.equal(second.text.includes("did not return an excerpt"), true);
  const [citation] = citations;
  assert.equal(citation.media_type, "text/html");
  assert.equal(citation.source_kind, "external_research");
  assert.equal(citation.source_locations[0].section, "https://film.example.gov/permits");
  assert.ok(citation.excerpt.includes("10 business days"));
});

test("enrichProducerPacketWithParallelEvidence is a no-op when Parallel is not configured, with zero client calls", async () => {
  const packet = canonicalPacket();
  const client = new MockParallelClient();
  const enriched = await enrichProducerPacketWithParallelEvidence(packet, { client, config: readParallelConfig({}) });
  assert.deepEqual(enriched.external_evidence, []);
  assert.equal(enriched.provenance.external_evidence_enabled, false);
  assert.equal(enriched.provenance.external_evidence_provider, null);
  assert.equal(client.calls.length, 0);
  assert.equal(enriched.citations.length, packet.citations.length);
});

test("enrichProducerPacketWithParallelEvidence never runs for the legacy compatibility packet contract", async () => {
  const packet = legacyPacket();
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA_LEGACY);
  const client = new MockParallelClient();
  const enriched = await enrichProducerPacketWithParallelEvidence(packet, { client, config: readParallelConfig({ PARALLEL_API_KEY: "sk-test" }) });
  assert.equal(enriched, packet);
  assert.equal(client.calls.length, 0);
});

test("enrichProducerPacketWithParallelEvidence merges cited external evidence into the strict packet when enabled", async () => {
  const packet = canonicalPacket();
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA);
  const client = mockClientTrackingTopic({
    resultsByTopic: {
      location_permit: { search_id: "search_1", session_id: "s1", results: [{ title: "Permit Office", url: "https://permits.example.gov/mill", excerpts: ["Lead time is typically 2-4 weeks."] }] },
      vendor_day_rate: { search_id: "search_2", session_id: "s1", results: [{ title: "Rate Guide", url: "https://rates.example.com/locations", excerpts: ["Typical access day rates range from $500-$2,500."] }] },
    },
  });
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const enriched = await enrichProducerPacketWithParallelEvidence(packet, { client, config });

  assert.equal(client.calls.length, 2);
  assert.equal(enriched.provenance.external_evidence_enabled, true);
  assert.equal(enriched.provenance.external_evidence_provider, "parallel-web");
  assert.equal(enriched.external_evidence.length, 2);
  for (const item of enriched.external_evidence) {
    assert.equal(item.classification, "externally_researched_fact");
    assert.equal(item.evidence_state, "externally_researched_not_verified");
    assert.equal(item.citation_ids.length, 1);
  }
  const newCitationIds = enriched.external_evidence.flatMap((item) => item.citation_ids);
  for (const citationId of newCitationIds) assert.ok(enriched.cited_citation_ids.includes(citationId));
  const externalCitations = enriched.citations.filter((citation) => citation.source_kind === "external_research");
  assert.equal(externalCitations.length, 2);
  assert.ok(externalCitations.some((citation) => citation.source_locations[0].section === "https://permits.example.gov/mill"));
  assert.ok(enriched.limitations.some((line) => line.includes("Parallel Search")));
  // Original deterministic content is untouched.
  assert.deepEqual(enriched.scene_index, packet.scene_index);
  assert.deepEqual(enriched.exact_facts, packet.exact_facts);
  assert.equal(enriched.citations.length, packet.citations.length + 2);
});

test("enrichProducerPacketWithParallelEvidence degrades a Parallel failure to a bounded unavailable row instead of failing the packet", async () => {
  const packet = canonicalPacket();
  const client = mockClientTrackingTopic({ failTopics: new Set(["location_permit", "vendor_day_rate"]), failWith: Object.assign(new Error("rate limited"), { status: 429 }) });
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const enriched = await enrichProducerPacketWithParallelEvidence(packet, { client, config });
  assert.equal(enriched.external_evidence.length, 2);
  for (const item of enriched.external_evidence) {
    assert.equal(item.classification, "open_question");
    assert.equal(item.evidence_state, "unavailable");
    assert.deepEqual(item.citation_ids, []);
  }
  assert.equal(enriched.citations.length, packet.citations.length);
  assert.equal(enriched.provenance.external_evidence_enabled, true);
});

test("createParallelEnrichedProducerBuilder composes the deterministic builder with Parallel enrichment", async () => {
  const client = mockClientTrackingTopic({
    resultsByTopic: { location_permit: { results: [{ title: "Permit Office", url: "https://permits.example.gov/mill", excerpts: ["ok"] }] }, vendor_day_rate: { results: [] } },
  });
  const config = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const build = createParallelEnrichedProducerBuilder({ baseBuilder: buildProducerDecisionPacket, parallelClient: client, parallelConfig: config });
  const packet = await build(northlineEntries(), { createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(packet.schema_version, PRODUCER_PACKET_SCHEMA);
  assert.equal(packet.external_evidence.length, 1);
  assert.equal(packet.provenance.external_evidence_enabled, true);
});

function bundleForm(entries) {
  const form = new FormData();
  form.append("manifest", JSON.stringify({ schema_version: "producer-source-bundle@1", sources: entries.map((entry, index) => ({ input_ref: `northline_${index + 1}`, filename: entry.filename, source_kind: entry.source_kind })) }));
  for (const entry of entries) form.append("file", new Blob([entry.text], { type: "text/plain" }), entry.filename);
  return form;
}

const northlineFormEntries = [
  { filename: "northline-shooting-script.txt", source_kind: "primary_screenplay", text: "SHOOTING DRAFT 3\nSCENE 7 - INT. MILL - NIGHT\nMara enters the mill." },
  { filename: "northline-location-access.txt", source_kind: "location_access", text: "Permission status: permission pending\nOwner: Jo - Locations\nNo location hold is confirmed." },
  { filename: "northline-schedule-assumption.txt", source_kind: "schedule_assumptions", text: "Assumption: Scene 7 is on a Mill hold for 12 June" },
  { filename: "northline-budget-input.txt", source_kind: "budget_assumptions", text: "Access rate: $1,200 per access day" },
];

async function startApp(t, options = {}) {
  const app = createApp({ dataPath: tempPath(), ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test("the full producer HTTP flow keeps Parallel enrichment off by default and makes zero client calls", async (t) => {
  const { app, base } = await startApp(t);
  assert.equal(app.parallelConfig.enabled, false);
  const bundleResponse = await fetch(`${base}/v1/producer-source-bundles`, { method: "POST", body: bundleForm(northlineFormEntries) });
  const bundle = await bundleResponse.json();
  const accepted = await fetch(`${base}/v1/producer-source-bundles/${bundle.bundle_id}/packets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "producer-intake-request@1", bundle_id: bundle.bundle_id }) }).then((response) => response.json());
  await app.producerEngine.waitForIdle(accepted.packet_id);
  const packet = await (await fetch(`${base}/v1/producer-packets/${accepted.packet_id}`)).json();
  assert.equal(packet.status, "succeeded");
  assert.deepEqual(packet.external_evidence, []);
  assert.equal(packet.provenance.external_evidence_enabled, false);
});

test("the full producer HTTP flow enriches the strict packet with cited Parallel evidence when configured", async (t) => {
  const client = mockClientTrackingTopic({
    resultsByTopic: {
      location_permit: { results: [{ title: "Permit Office", url: "https://permits.example.gov/mill", excerpts: ["Lead time is typically 2-4 weeks."] }] },
      vendor_day_rate: { results: [{ title: "Rate Guide", url: "https://rates.example.com/locations", excerpts: ["Typical rates: $500-$2,500 per day."] }] },
    },
  });
  const parallelConfig = readParallelConfig({ PARALLEL_API_KEY: "sk-test" });
  const { app, base } = await startApp(t, { parallelClient: client, parallelConfig });
  assert.equal(app.parallelConfig.enabled, true);
  const bundleResponse = await fetch(`${base}/v1/producer-source-bundles`, { method: "POST", body: bundleForm(northlineFormEntries) });
  const bundle = await bundleResponse.json();
  const accepted = await fetch(`${base}/v1/producer-source-bundles/${bundle.bundle_id}/packets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "producer-intake-request@1", bundle_id: bundle.bundle_id }) }).then((response) => response.json());
  await app.producerEngine.waitForIdle(accepted.packet_id);
  const packet = await (await fetch(`${base}/v1/producer-packets/${accepted.packet_id}`)).json();
  assert.equal(packet.status, "succeeded");
  assert.equal(packet.external_evidence.length, 2);
  assert.equal(packet.provenance.external_evidence_enabled, true);
  assert.equal(packet.provenance.external_evidence_provider, "parallel-web");
  const permitCitation = packet.citations.find((citation) => citation.source_locations?.[0]?.section === "https://permits.example.gov/mill");
  assert.ok(permitCitation, "the exact Parallel result URL must be present as a citation");
  assert.equal(permitCitation.media_type, "text/html");

  // The bounded read-only handoff export also surfaces the externally researched evidence.
  const markdown = await (await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/handoff?format=markdown`)).text();
  assert.match(markdown, /External evidence \(Parallel Search/);
  const json = await (await fetch(`${base}/v1/producer-packets/${accepted.packet_id}/handoff?format=json`)).json();
  assert.equal(json.external_evidence.length, 2);
  assert.equal(client.calls.length, 2);
});
