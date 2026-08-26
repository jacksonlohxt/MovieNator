import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProducerDecisionPacket, parseProducerSource } from "../src/producer-consolidation.js";

export const EVALUATION_SCHEMA = "producer-intake-evaluation@1";
export const FIXTURE_SCHEMA = "producer-intake-evaluation-fixture@1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_DIR = path.join(HERE, "fixtures");
export const DEFAULT_OUTPUT_DIR = path.join(HERE, "results");

function asText(value) {
  return typeof value === "string" ? value : "";
}

function normalize(value) {
  return asText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").trim();
}

function containsText(haystack, needle) {
  const haystackValue = normalize(haystack);
  const needleValue = normalize(needle);
  return Boolean(needleValue) && haystackValue.includes(needleValue);
}

function round(value) {
  return Number(value.toFixed(4));
}

function metric(found, total) {
  return {
    found,
    total,
    score: total ? round(found / total) : null,
    status: total ? "scored" : "not_applicable",
  };
}

function locationMatches(actual, expected) {
  if (!actual || !expected) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function citationsFor(record, packet) {
  const ids = Array.isArray(record?.citation_ids) ? record.citation_ids : [];
  return ids.map((id) => packet.citations.find((citation) => citation.citation_id === id)).filter(Boolean);
}

function sourceIdsForFilename(packet, filename) {
  return new Set((packet.source_manifest || packet.source_inventory || []).filter((source) => source.filename === filename).map((source) => source.source_id));
}

function directRecordText(record) {
  if (!record || typeof record !== "object") return "";
  return record.value || record.text || record.original_wording || record.question || record.scene_heading || record.scene_reference || record.title || record.next_action || record.evidence_needed || "";
}

function claimRecords(packet) {
  const sections = [
    "exact_facts",
    "scene_index",
    "production_elements",
    "locations_and_timing",
    "cast_role_demands",
    "department_requirements",
    "schedule_inputs",
    "budget_inputs",
    "rights_access_logistics",
  ];
  return sections.flatMap((section) => (packet[section] || []).map((record) => ({ section, record })));
}

function seededConflictRecords(packet) {
  return (packet.conflicts || []).map((record) => ({
    ...record,
    searchableText: [record.title, record.kind, record.question, ...(record.assertions || []).map(directRecordText)].filter(Boolean).join(" "),
  }));
}

function seededUnknownRecords(packet) {
  return [
    ...(packet.gaps_and_next_steps || []).map((record) => ({ ...record, searchableText: directRecordText(record) })),
    ...(packet.decision_question_register || []).map((record) => ({ ...record, searchableText: directRecordText(record) })),
    ...(packet.rights_access_logistics || []).filter((record) => record.classification === "open_question").map((record) => ({ ...record, searchableText: directRecordText(record) })),
  ];
}

function findKnownFact(packet, expected) {
  const expectedSourceIds = sourceIdsForFilename(packet, expected.source_filename);
  return claimRecords(packet).find(({ record }) => {
    const text = directRecordText(record);
    if (!containsText(text, expected.value)) return false;
    const citations = citationsFor(record, packet);
    return citations.some((citation) => expectedSourceIds.has(citation.source_id));
  });
}

function scoreConflicts(packet, targets) {
  const records = seededConflictRecords(packet);
  const details = targets.map((target) => {
    const match = records.find((record) => (target.kind ? record.kind === target.kind : true) && (target.assertion_terms || []).every((term) => containsText(record.searchableText, term)));
    return { target_id: target.target_id, found: Boolean(match), matched_kind: match?.kind || null };
  });
  return { ...metric(details.filter((item) => item.found).length, targets.length), details };
}

function scoreUnknowns(packet, targets) {
  const records = seededUnknownRecords(packet);
  const details = targets.map((target) => {
    const match = records.find((record) => (target.terms || []).every((term) => containsText(record.searchableText, term)));
    return { target_id: target.target_id, found: Boolean(match), matched_entry_id: match?.entry_id || match?.gap_id || null };
  });
  return { ...metric(details.filter((item) => item.found).length, targets.length), details };
}

function scoreCitations(packet, targets) {
  const details = targets.map((target) => {
    const match = findKnownFact(packet, target);
    const citations = match ? citationsFor(match.record, packet) : [];
    const expectedSourceIds = sourceIdsForFilename(packet, target.source_filename);
    const validCitation = citations.find((citation) => expectedSourceIds.has(citation.source_id)
      && containsText(citation.excerpt, target.source_text_contains)
      && citation.source_locations.some((location) => locationMatches(location, target.location)));
    return {
      target_id: target.target_id,
      found: Boolean(match),
      citation_ids: citations.map((citation) => citation.citation_id),
      accurate: Boolean(validCitation),
      citation_id: validCitation?.citation_id || null,
      reason: validCitation ? "source, excerpt, and declared location matched" : "no cited excerpt matched the expected source location and claim",
    };
  });
  return { ...metric(details.filter((item) => item.accurate).length, targets.length), details };
}

function atomicClaimRecords(packet) {
  const records = claimRecords(packet).filter(({ record }) => !["open_question", "conflict"].includes(record.classification));
  const conflicts = (packet.conflicts || []).flatMap((conflict) => (conflict.assertions || []).map((record) => ({ section: "conflict_assertion", record })));
  const all = [...records, ...conflicts];
  const seen = new Set();
  return all.filter(({ record }) => {
    const text = directRecordText(record);
    const citationIds = Array.isArray(record.citation_ids) ? record.citation_ids : [];
    if (!text || !citationIds.length) return false;
    const key = `${normalize(text)}|${citationIds.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreUnsupportedClaims(packet) {
  const details = atomicClaimRecords(packet).map(({ section, record }) => {
    const citations = citationsFor(record, packet);
    const supported = citations.some((citation) => containsText(citation.excerpt, directRecordText(record)));
    return {
      section,
      claim: directRecordText(record),
      classification: record.classification || null,
      citation_ids: Array.isArray(record.citation_ids) ? record.citation_ids : [],
      supported,
      reason: supported ? "claim text appears in a cited source excerpt" : "claim text does not appear in any cited source excerpt",
    };
  });
  const unsupported = details.filter((item) => !item.supported);
  return {
    ...metric(unsupported.length, details.length),
    false_positive_invention_rate: details.length ? round(unsupported.length / details.length) : null,
    supported_claims: details.length - unsupported.length,
    unsupported_claims: unsupported,
    unsupported_claim_count: unsupported.length,
    evaluated_claims: details.length,
  };
}

export function comparisonScaffolds() {
  return [
    {
      system_id: "notebooklm",
      display_name: "NotebookLM",
      status: "not_run",
      mode: "offline_scaffold",
      input_shape: "same synthetic source bundle, preregistered prompt, and five-minute handoff task",
      run_metadata: { operator_id: null, prompt_id: null, started_at: null, completed_at: null },
      metric_fields: ["time_to_meeting_ready_packet_ms", "conflict_recall", "unknown_gap_recall", "citation_verification_time_ms", "correction_rate", "handoff_acceptance"],
      metrics: null,
      note: "No NotebookLM call, login, upload, or network request is made by this harness.",
    },
    {
      system_id: "incumbent_production_workflow",
      display_name: "Incumbent production workflow",
      status: "not_run",
      mode: "offline_scaffold",
      input_shape: "same synthetic source bundle, preregistered operator steps, and scoring rubric",
      run_metadata: { operator_id: null, prompt_id: null, started_at: null, completed_at: null },
      metric_fields: ["time_to_meeting_ready_packet_ms", "conflict_recall", "unknown_gap_recall", "citation_verification_time_ms", "correction_rate", "handoff_acceptance"],
      metrics: null,
      note: "No incumbent tool, account, provider, or network request is used. An authorized later run must populate this record.",
    },
  ];
}

function fixtureManifestPaths(fixtureDir) {
  return fs.readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fixtureDir, entry.name, "manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .sort();
}

export function loadFixture(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema_version !== FIXTURE_SCHEMA) throw new Error(`Unsupported evaluation fixture schema in ${manifestPath}`);
  if (!manifest.fixture_id || !Array.isArray(manifest.sources) || !manifest.ground_truth) throw new Error(`Malformed evaluation fixture: ${manifestPath}`);
  const directory = path.dirname(manifestPath);
  const sources = manifest.sources.map((source) => {
    const sourcePath = path.join(directory, source.file);
    const bytes = fs.readFileSync(sourcePath);
    return {
      ...source,
      filename: source.filename || path.basename(sourcePath),
      contentType: source.content_type || "text/plain",
      bytes,
    };
  });
  return { ...manifest, manifest_path: manifestPath, sources };
}

export function scorePacket(packet, groundTruth = {}) {
  return {
    conflict_recall: scoreConflicts(packet, groundTruth.conflicts || []),
    unknown_gap_recall: scoreUnknowns(packet, groundTruth.unknowns || []),
    citation_accuracy: scoreCitations(packet, groundTruth.known_facts || []),
    false_positive_invention: scoreUnsupportedClaims(packet),
  };
}

export function evaluateFixture(fixture, { now = () => new Date().toISOString() } = {}) {
  const parsedSources = fixture.sources.map((source) => parseProducerSource({
    filename: source.filename,
    contentType: source.contentType,
    bytes: source.bytes,
    source_kind: source.source_kind,
    input_ref: source.input_ref,
    department: source.department,
    version_label: source.version_label,
    status_label: source.status_label,
    relationships: source.relationships,
    source_note: source.source_note,
  }));
  const packet = buildProducerDecisionPacket(parsedSources, { createdAt: "2026-01-01T00:00:00.000Z" });
  const scores = scorePacket(packet, fixture.ground_truth);
  return {
    schema_version: EVALUATION_SCHEMA,
    fixture_id: fixture.fixture_id,
    description: fixture.description,
    status: "completed",
    generated_at: now(),
    packet: {
      schema_version: packet.schema_version,
      packet_id: packet.packet_id,
      bundle_id: packet.bundle_id,
      status: packet.status,
      source_count: packet.source_manifest?.length || 0,
      citation_count: packet.citations?.length || 0,
      provenance: packet.provenance,
    },
    ground_truth: fixture.ground_truth,
    seeded_ground_truth_counts: {
      conflicts: (fixture.ground_truth.conflicts || []).length,
      unknowns: (fixture.ground_truth.unknowns || []).length,
      known_facts: (fixture.ground_truth.known_facts || []).length,
    },
    scores,
    comparison_scaffolds: comparisonScaffolds(),
    methodology: {
      conflict_recall: "A seeded conflict is found only when its expected kind and both assertion terms appear in one packet conflict.",
      unknown_gap_recall: "A seeded unknown is found only when all expected terms appear in a packet gap, question, or explicitly open access row.",
      citation_accuracy: "A known fact must be emitted and cite the expected source filename, source excerpt, and exact parser location.",
      false_positive_invention: "The audit covers cited atomic packet claims in evidence sections. Synthesized executive prose and absence-only questions are excluded because they are not atomic source claims.",
    },
  };
}

function aggregateMetric(results, scoreKey) {
  const metrics = results.map((result) => result.scores[scoreKey]).filter((metricValue) => metricValue.total > 0);
  const total = metrics.reduce((sum, value) => sum + value.total, 0);
  const unsupported = scoreKey === "false_positive_invention"
    ? metrics.reduce((sum, value) => sum + value.unsupported_claim_count, 0)
    : 0;
  const found = scoreKey === "false_positive_invention"
    ? unsupported
    : metrics.reduce((sum, value) => sum + value.found, 0);
  const output = metric(found, total);
  if (scoreKey === "false_positive_invention") {
    output.false_positive_invention_rate = total ? round(unsupported / total) : null;
    output.supported_claims = total - unsupported;
    output.unsupported_claims = unsupported;
    output.unsupported_claim_count = unsupported;
    output.evaluated_claims = total;
  }
  return output;
}

export function evaluateFixtures({ fixtureDir = DEFAULT_FIXTURE_DIR, fixtureIds = undefined, outputDir = undefined, now = () => new Date().toISOString() } = {}) {
  const manifests = fixtureManifestPaths(fixtureDir);
  const selected = fixtureIds?.length ? manifests.filter((manifestPath) => fixtureIds.includes(JSON.parse(fs.readFileSync(manifestPath, "utf8")).fixture_id)) : manifests;
  if (!selected.length) throw new Error("No evaluation fixtures selected");
  const results = selected.map((manifestPath) => evaluateFixture(loadFixture(manifestPath), { now }));
  const aggregate = {
    schema_version: EVALUATION_SCHEMA,
    report_type: "aggregate",
    generated_at: now(),
    fixture_count: results.length,
    fixtures: results.map((result) => ({ fixture_id: result.fixture_id, status: result.status })),
    scores: {
      conflict_recall: aggregateMetric(results, "conflict_recall"),
      unknown_gap_recall: aggregateMetric(results, "unknown_gap_recall"),
      citation_accuracy: aggregateMetric(results, "citation_accuracy"),
      false_positive_invention: aggregateMetric(results, "false_positive_invention"),
    },
    comparison_scaffolds: comparisonScaffolds(),
    limitations: [
      "Fixtures are synthetic and do not establish customer value, market demand, or workplace handoff acceptance.",
      "NotebookLM and incumbent comparisons are structural scaffolds only and have status not_run.",
      "The false-positive audit is limited to atomic cited evidence rows and does not score synthesized prose.",
    ],
  };
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const result of results) {
      fs.writeFileSync(path.join(outputDir, `${result.fixture_id}.json`), `${JSON.stringify(result, null, 2)}\n`);
      fs.writeFileSync(path.join(outputDir, `${result.fixture_id}.md`), renderFixtureSummary(result));
    }
    fs.writeFileSync(path.join(outputDir, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDir, "summary.md"), renderAggregateSummary(aggregate, results));
  }
  return { results, aggregate };
}

function scoreLabel(value) {
  return value.score === null ? "n/a" : `${(value.score * 100).toFixed(1)}% (${value.found}/${value.total})`;
}

export function renderFixtureSummary(result) {
  return `# Offline producer intake evaluation: ${result.fixture_id}\n\n${result.description}\n\nStatus: **${result.status}**\n\n## Scores\n\n| Metric | Result |\n| --- | ---: |\n| Seeded conflict recall | ${scoreLabel(result.scores.conflict_recall)} |\n| Seeded unknown/gap recall | ${scoreLabel(result.scores.unknown_gap_recall)} |\n| Citation accuracy | ${scoreLabel(result.scores.citation_accuracy)} |\n| False-positive/invention rate | ${result.scores.false_positive_invention.false_positive_invention_rate === null ? "n/a" : `${(result.scores.false_positive_invention.false_positive_invention_rate * 100).toFixed(1)}%`} (${result.scores.false_positive_invention.unsupported_claim_count}/${result.scores.false_positive_invention.evaluated_claims}) |\n\n## Comparison scaffolds\n\n| System | Status |\n| --- | --- |\n${result.comparison_scaffolds.map((scaffold) => `| ${scaffold.display_name} | **${scaffold.status}** |`).join("\n")}\n\nNo live or paid comparison call was made.\n`;
}

export function renderAggregateSummary(aggregate, results) {
  return `# Offline producer intake evaluation\n\nSynthetic, credential-free evaluation of the deterministic Producer Intake packet builder. This is a measurement scaffold, not customer validation.\n\n## Aggregate scores\n\n| Metric | Result |\n| --- | ---: |\n| Seeded conflict recall | ${scoreLabel(aggregate.scores.conflict_recall)} |\n| Seeded unknown/gap recall | ${scoreLabel(aggregate.scores.unknown_gap_recall)} |\n| Citation accuracy | ${scoreLabel(aggregate.scores.citation_accuracy)} |\n| False-positive/invention rate | ${(aggregate.scores.false_positive_invention.false_positive_invention_rate * 100).toFixed(1)}% (${aggregate.scores.false_positive_invention.unsupported_claims}/${aggregate.scores.false_positive_invention.evaluated_claims}) |\n\n## Fixtures\n\n| Fixture | Conflict recall | Unknown/gap recall | Citation accuracy | False-positive/invention rate |\n| --- | ---: | ---: | ---: | ---: |\n${results.map((result) => `| ${result.fixture_id} | ${scoreLabel(result.scores.conflict_recall)} | ${scoreLabel(result.scores.unknown_gap_recall)} | ${scoreLabel(result.scores.citation_accuracy)} | ${(result.scores.false_positive_invention.false_positive_invention_rate * 100).toFixed(1)}% |`).join("\n")}\n\n## Structural comparison scaffolds\n\n| System | Status |\n| --- | --- |\n${aggregate.comparison_scaffolds.map((scaffold) => `| ${scaffold.display_name} | **${scaffold.status}** |`).join("\n")}\n\nNotebookLM and the incumbent workflow were not run. No network, account, provider, or paid service is used by this command.\n`;
}
