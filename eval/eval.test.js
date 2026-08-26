import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_FIXTURE_DIR,
  EVALUATION_SCHEMA,
  evaluateFixture,
  evaluateFixtures,
  loadFixture,
  scorePacket,
} from "./harness.js";

const fixedNow = () => "2026-01-01T00:00:00.000Z";

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "movieinator-eval-"));
}

test("offline fixtures contain known ground truth and score the deterministic builder", () => {
  const report = evaluateFixtures({ fixtureDir: DEFAULT_FIXTURE_DIR, now: fixedNow });
  assert.equal(report.aggregate.schema_version, EVALUATION_SCHEMA);
  assert.equal(report.aggregate.fixture_count, 3);

  const northline = report.results.find((result) => result.fixture_id === "northline-conflict");
  assert.ok(northline);
  assert.deepEqual(northline.scores.conflict_recall, {
    found: 1,
    total: 1,
    score: 1,
    status: "scored",
    details: [{ target_id: "mill-hold-vs-no-hold", found: true, matched_kind: "schedule_location_access" }],
  });
  assert.equal(northline.scores.unknown_gap_recall.score, 1);
  assert.equal(northline.scores.citation_accuracy.score, 1);
  assert.equal(northline.scores.false_positive_invention.false_positive_invention_rate, 0);
  assert.ok(northline.scores.false_positive_invention.evaluated_claims > 0);
  assert.ok(northline.comparison_scaffolds.every((scaffold) => scaffold.status === "not_run"));
  assert.deepEqual(northline.comparison_scaffolds[0].metric_fields, ["time_to_meeting_ready_packet_ms", "conflict_recall", "unknown_gap_recall", "citation_verification_time_ms", "correction_rate", "handoff_acceptance"]);
  assert.equal(northline.comparison_scaffolds[0].metrics, null);

  const archive = report.results.find((result) => result.fixture_id === "archivegap-missing-access");
  assert.ok(archive);
  assert.equal(archive.scores.unknown_gap_recall.score, 1);
  assert.equal(archive.scores.citation_accuracy.score, 1);

  assert.equal(report.aggregate.scores.conflict_recall.score, 1);
  assert.equal(report.aggregate.scores.unknown_gap_recall.score, 1);
  assert.equal(report.aggregate.scores.citation_accuracy.score, 1);
  assert.equal(report.aggregate.scores.false_positive_invention.false_positive_invention_rate, 0);
});

test("evaluation writes JSON and human-readable reports per fixture and in aggregate", () => {
  const outputDir = tempDirectory();
  const report = evaluateFixtures({ outputDir, now: fixedNow });
  for (const result of report.results) {
    assert.ok(fs.existsSync(path.join(outputDir, `${result.fixture_id}.json`)));
    assert.match(fs.readFileSync(path.join(outputDir, `${result.fixture_id}.md`), "utf8"), /Scores/);
  }
  assert.match(fs.readFileSync(path.join(outputDir, "aggregate.json"), "utf8"), /"report_type": "aggregate"/);
  assert.match(fs.readFileSync(path.join(outputDir, "summary.md"), "utf8"), /Aggregate scores/);
});

test("unsupported atomic claims are counted as inventions", () => {
  const scores = scorePacket({
    citations: [{ citation_id: "citation-1", excerpt: "The source says a park is available.", source_locations: [] }],
    exact_facts: [{ value: "A mill is booked", classification: "source_fact", citation_ids: ["citation-1"] }],
  });
  assert.equal(scores.false_positive_invention.unsupported_claim_count, 1);
  assert.equal(scores.false_positive_invention.evaluated_claims, 1);
  assert.equal(scores.false_positive_invention.false_positive_invention_rate, 1);
});

test("citation scoring is tied to the exact source location, not merely a matching value", () => {
  const fixture = loadFixture(path.join(DEFAULT_FIXTURE_DIR, "northline", "manifest.json"));
  const result = evaluateFixture({
    ...fixture,
    ground_truth: {
      ...fixture.ground_truth,
      known_facts: fixture.ground_truth.known_facts.map((fact) => fact.target_id === "scene-7-heading"
        ? { ...fact, location: { ...fact.location, line_start: 99 } }
        : fact),
    },
  }, { now: fixedNow });
  assert.equal(result.scores.citation_accuracy.found, 3);
  assert.equal(result.scores.citation_accuracy.total, 4);
  assert.equal(result.scores.citation_accuracy.details.find((item) => item.target_id === "scene-7-heading").accurate, false);
});
