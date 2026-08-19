import {
  BUNDLE_SCHEMA,
  CHECK_KINDS,
  CancellationError,
  ContractError,
  DECISION_SCHEMA,
  DECISIONS,
  DRAFT_SCHEMA,
  EVIDENCE_STATUSES,
  MAX_ATTEMPTS,
  MOCK_FRESH_UNTIL,
  MOCK_OBSERVED_AT,
  PLAN_SCHEMA,
  POLICY_VERSION,
  PROVENANCE,
  ProviderError,
  REQUIRED_EVIDENCE,
  RESULT_SCHEMA,
  RETRYABLE_PROVIDER_ERRORS,
  TERMINAL_STATES,
  WORKFLOW,
  combineProvenance,
  containsUnsafeText,
  hashValue,
  normalizeText,
  redactText,
  safeId,
  safeSourceLink,
  stableStringify,
  validateDraft,
  validateEvidenceBundle,
  validatePlan,
} from "./contracts.js";
import { ModelGateway } from "./model-gateway.js";
import { deterministicGroundedBriefProposal } from "./grounding.js";
export { ModelGateway } from "./model-gateway.js";
export { GeminiRestBackend } from "./gemini-rest.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const READINESS_POLICY = Object.freeze({
  version: POLICY_VERSION,
  quality_warning_threshold: { completeness: 95, validity: 95 },
  freshness: "fresh_until",
  hard_stop_codes: ["GOVERNANCE_HARD_STOP"],
  note: "Recommended mock policy proposal. It is not legal, privacy, rights, or publishing approval.",
});

const FIXTURES = Object.freeze({
  ready: { asset_id: "asset_demo_001", display_name: "Season 2 audience engagement", fixture: "ready" },
  review: { asset_id: "asset_demo_002", display_name: "Season 2 campaign audience", fixture: "review" },
  blocked: { asset_id: "asset_demo_003", display_name: "Season 2 restricted audience", fixture: "blocked" },
  denied: { asset_id: "asset_demo_004", display_name: "Season 2 audience with restricted governance", fixture: "denied" },
  stale: { asset_id: "asset_demo_005", display_name: "Season 2 stale audience", fixture: "stale" },
  conflict: { asset_id: "asset_demo_007", display_name: "Season 2 conflicting audience", fixture: "conflict" },
  recovery: { asset_id: "asset_demo_006", display_name: "Recovery demonstration audience", fixture: "recovery" },
});

function lower(value) {
  return String(value || "").toLocaleLowerCase();
}

function fixtureFor(query, isRetry = false) {
  const text = lower(query);
  if (isRetry && text.includes("recovery")) return FIXTURES.ready;
  if (text.includes("blocked") || text.includes("hard_stop")) return FIXTURES.blocked;
  if (text.includes("denied")) return FIXTURES.denied;
  if (text.includes("stale")) return FIXTURES.stale;
  if (text.includes("conflict")) return FIXTURES.conflict;
  if (text.includes("recovery") || text.includes("timeout") || text.includes("unavailable")) return FIXTURES.recovery;
  if (text.includes("review") || text.includes("campaign") || text.includes("missing")) return FIXTURES.review;
  return FIXTURES.ready;
}

/**
 * Deterministic read-only fixture adapter. It exposes semantic operations only.
 * It intentionally has no arbitrary tool, URL, SQL, or mutation method.
 */
export class MockProvider {
  constructor({ clock = Date } = {}) {
    this.clock = clock;
    this.calls = [];
    this.manifest = Object.freeze({
      provider_id: "mock-provider",
      provider_backend: "MockProvider",
      version: "demo-fixtures@1",
      scope_reference: "Demo Media Workspace",
      transport: "in-process",
      auth_mode: "none-synthetic-only",
      read_only: true,
      operations: ["resolve_asset", "describe_asset", "read_quality", "read_governance", "read_lineage"],
      manifest_hash: hashValue("mock-provider|demo-fixtures@1|read-only"),
    });
  }

  capabilities() {
    return this.manifest;
  }

  #record(operation) {
    this.calls.push({ operation, at: new Date(this.clock()).toISOString() });
  }

  async resolve_asset(context, query) {
    this.#record("resolve_asset");
    await sleep(8);
    const text = lower(query);
    if (text.includes("ambiguous") || text.includes("multiple") || text === "audience") {
      return {
        status: "multiple",
        candidates: [
          { candidate_id: "season_2_audience_engagement", asset_id: "asset_demo_001", display_name: "Season 2 audience engagement", workspace: "Demo Media Workspace", last_observed_at: MOCK_OBSERVED_AT },
          { candidate_id: "season_2_campaign_audience", asset_id: "asset_demo_002", display_name: "Season 2 campaign audience", workspace: "Demo Media Workspace", last_observed_at: MOCK_OBSERVED_AT },
        ],
      };
    }
    if (text.includes("unknown") || text.includes("no_such") || text.includes("not found")) {
      return { status: "none", candidates: [] };
    }
    const fixture = fixtureFor(text, context.retry_count > 0);
    return {
      status: "resolved",
      asset: {
        ...fixture,
        workspace: "Demo Media Workspace",
        last_observed_at: MOCK_OBSERVED_AT,
      },
    };
  }

  async describe_asset(context, asset) {
    this.#record("describe_asset");
    await sleep(8);
    return {
      status: "complete",
      facts: { asset_id: asset.asset_id, display_name: asset.display_name, workspace: asset.workspace },
      units: {},
      source_reference: `Demo fixture ${asset.asset_id}`,
    };
  }

  async read_quality(context, asset) {
    this.#record("read_quality");
    await sleep(12);
    if (asset.fixture === "recovery" && context.retry_count === 0) throw new ProviderError("unavailable", "Demo evidence provider unavailable", { retryable: true });
    if (asset.fixture === "stale") {
      return { status: "stale", facts: { completeness: 98.1, validity: 97.4 }, units: { completeness: "percent", validity: "percent" }, source_reference: `Demo quality fixture ${asset.asset_id}` };
    }
    if (asset.fixture === "conflict") {
      return { status: "complete", facts: { completeness: 99.7, validity: 99.2, conflict: true }, units: { completeness: "percent", validity: "percent" }, source_reference: `Demo conflicting quality fixture ${asset.asset_id}` };
    }
    return { status: "complete", facts: { completeness: 99.7, validity: 99.2, duplicate_rate: 0.3 }, units: { completeness: "percent", validity: "percent", duplicate_rate: "percent" }, source_reference: `Demo quality fixture ${asset.asset_id}` };
  }

  async read_governance(context, asset, purpose) {
    this.#record("read_governance");
    await sleep(12);
    if (asset.fixture === "recovery" && context.retry_count === 0) throw new ProviderError("unavailable", "Demo evidence provider unavailable", { retryable: true });
    if (asset.fixture === "denied") throw new ProviderError("denied", "Governance evidence access was denied", { retryable: false, status: 403 });
    if (asset.fixture === "blocked") {
      return { status: "complete", facts: { approved_purpose: false, hard_stop_code: "GOVERNANCE_HARD_STOP", note: "Configured governance hard stop" }, units: {}, source_reference: `Demo governance fixture ${asset.asset_id}` };
    }
    if (asset.fixture === "review") {
      return { status: "missing", facts: { approved_purpose: false }, units: {}, source_reference: `Demo governance gap ${asset.asset_id}` };
    }
    return { status: "complete", facts: { approved_purpose: true, purpose: purpose || "marketing planning", classification: "internal-demo" }, units: {}, source_reference: `Demo governance fixture ${asset.asset_id}` };
  }

  async read_lineage(context, asset) {
    this.#record("read_lineage");
    await sleep(12);
    if (asset.fixture === "recovery" && context.retry_count === 0) throw new ProviderError("unavailable", "Demo evidence provider unavailable", { retryable: true });
    return { status: "complete", facts: { upstream_count: 2, downstream_count: asset.fixture === "review" ? 7 : 4, truncated: false }, units: { upstream_count: "nodes", downstream_count: "nodes" }, source_reference: `Demo lineage fixture ${asset.asset_id}` };
  }
}

/** FakeModel exercises the same plan and brief schemas without external calls. */
export class FakeModel extends ModelGateway {
  constructor({ failDraft = false } = {}) {
    super();
    this.failDraft = failDraft;
    this.calls = [];
  }

  provenance() {
    return {
      backend: "fake",
      model_id: null,
      location: null,
      api_version: null,
      prompt_id: "fake-model@1",
      prompt_hash: null,
      schema_version: null,
      schema_hash: null,
      generation_config_hash: null,
    };
  }

  async plan(request) {
    this.calls.push("plan");
    await sleep(4);
    const query = request.asset_hint || request.media_context?.asset_type || extractAssetQuery(request.problem_statement);
    return {
      schema_version: PLAN_SCHEMA,
      workflow: WORKFLOW,
      asset_query: query || undefined,
      container_query: request.container_hint,
      purpose: request.purpose,
      time_window: request.time_window,
      required_evidence: [...REQUIRED_EVIDENCE],
      clarification: null,
    };
  }

  async draft(input) {
    this.calls.push("draft");
    await sleep(4);
    if (this.failDraft) return { schema_version: DRAFT_SCHEMA, headline: "<unsafe>", summary: "javascript:bad", recommendations: ["unbounded"], risks: [] };
    const { decision, records } = input;
    const completeIds = records.filter((record) => record.status === "complete").map((record) => record.evidence_id);
    const gaps = records.filter((record) => record.status !== "complete");
    const summaryEvidenceIds = completeIds.slice(0, 4);
    const description = {
      READY: "All configured quality, governance, and lineage checks are present and fresh for this demo asset.",
      REVIEW: "The demo evidence shows a material gap or caution. A person should complete the next checks before relying on this brief.",
      BLOCKED: "Configured demo governance evidence contains a hard stop for this stated planning purpose.",
      UNKNOWN: "The configured demo evidence could not establish one authoritative asset and usable checks.",
    }[decision];
    return {
      schema_version: DRAFT_SCHEMA,
      headline: `Data readiness: ${decision}`,
      summary: description,
      summary_evidence_ids: summaryEvidenceIds,
      risks: gaps.slice(0, 5).map((record) => ({
        severity: decision === "BLOCKED" ? "high" : "medium",
        kind: "evidence_gap",
        text: `${capitalize(record.check_kind)} evidence is ${record.status.replaceAll("_", " ")}.`,
        evidence_ids: record.status === "complete" ? [record.evidence_id] : [],
      })),
      recommendations: recommendationsFor(decision, gaps),
      cited_evidence_ids: completeIds,
    };
  }

  async groundedBrief(input) {
    this.calls.push("groundedBrief");
    await sleep(4);
    return deterministicGroundedBriefProposal(input);
  }
}

function extractAssetQuery(problem) {
  const match = String(problem).match(/(?:dataset|asset|audience)\s+["']?([a-z0-9_-]{3,})/i);
  return match?.[1] || undefined;
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function recommendationsFor(decision, gaps) {
  const recommendations = [];
  if (decision === "READY") {
    recommendations.push("Confirm the brief's planning purpose with the data steward.", "Review the latest downstream consumers before changing the asset schema.");
  } else {
    for (const gap of gaps) {
      if (gap.check_kind === "governance") recommendations.push("Confirm the approved marketing purpose with the data steward.");
      if (gap.check_kind === "quality") recommendations.push("Run the current quality check before using the asset in a campaign brief.");
      if (gap.check_kind === "lineage") recommendations.push("Review bounded downstream consumers before changing the asset schema.");
      if (gap.status === "unavailable" || gap.status === "timed_out") recommendations.push("Retry the demo evidence run or ask an operator to inspect the configured source.");
    }
    if (decision === "BLOCKED") recommendations.unshift("Resolve the configured governance hard stop with the authorized data steward.");
    if (decision === "UNKNOWN") recommendations.unshift("Provide a more specific asset hint or select one of the matching demo assets.");
  }
  return [...new Set(recommendations)].slice(0, 3);
}

export function evaluatePolicy(records, { policy = READINESS_POLICY } = {}) {
  const byKind = new Map(records.map((record) => [record.check_kind, record]));
  const reasons = [];
  const asset = byKind.get("asset");
  const branchRecords = CHECK_KINDS.filter((kind) => kind !== "asset").map((kind) => byKind.get(kind));
  if (!asset || asset.status !== "complete") {
    return decision("UNKNOWN", [{ code: "ASSET_NOT_RESOLVED", evidence_ids: completeEvidenceIds(asset) }], false);
  }
  const hardStop = branchRecords.find((record) => record?.status === "complete" && policy.hard_stop_codes.includes(record.facts?.hard_stop_code));
  if (hardStop) return decision("BLOCKED", [{ code: String(hardStop.facts.hard_stop_code), evidence_ids: [hardStop.evidence_id] }], true);

  const conflict = branchRecords.find((record) => record?.status === "complete" && record.facts?.conflict === true);
  if (conflict) reasons.push({ code: "EVIDENCE_CONFLICT", evidence_ids: [conflict.evidence_id] });
  const usableComplete = branchRecords.filter((record) => record?.status === "complete");
  if (usableComplete.length === 0) {
    return decision("UNKNOWN", [{ code: "NO_USABLE_EVIDENCE", evidence_ids: [] }], false);
  }
  for (const record of branchRecords) {
    if (!record || record.status !== "complete") {
      reasons.push({ code: `${String(record?.check_kind || "EVIDENCE").toUpperCase()}_EVIDENCE_${String(record?.status || "MISSING").toUpperCase()}`, evidence_ids: completeEvidenceIds(record) });
    }
  }
  const quality = byKind.get("quality");
  if (quality?.status === "complete" && (Number(quality.facts.completeness) < policy.quality_warning_threshold.completeness || Number(quality.facts.validity) < policy.quality_warning_threshold.validity)) {
    reasons.push({ code: "QUALITY_BELOW_WARNING_THRESHOLD", evidence_ids: [quality.evidence_id] });
  }
  const governance = byKind.get("governance");
  if (governance?.status === "complete" && governance.facts.approved_purpose !== true) {
    reasons.push({ code: "GOVERNANCE_PURPOSE_UNVERIFIED", evidence_ids: [governance.evidence_id] });
  }
  const lineage = byKind.get("lineage");
  if (lineage?.status === "complete" && lineage.facts.truncated === true) reasons.push({ code: "LINEAGE_TRUNCATED", evidence_ids: [lineage.evidence_id] });
  return decision(reasons.length ? "REVIEW" : "READY", reasons, false);
}

function decision(value, reasons, hardStop) {
  return { schema_version: DECISION_SCHEMA, decision: value, policy_version: POLICY_VERSION, reasons, hard_stop: hardStop };
}

function stablePolicy(value) {
  return stableStringify({ decision: value?.decision, policy_version: value?.policy_version, reasons: value?.reasons, hard_stop: value?.hard_stop });
}

function makeEvidenceRecord(runId, kind, observation, provider, { policyVersion = POLICY_VERSION, provenance = PROVENANCE } = {}) {
  const normalizedFacts = safeFacts(observation.facts);
  const unsafeObservation = normalizedFacts === null || containsUnsafeText(String(observation.source_reference || ""));
  const status = unsafeObservation ? "invalid" : EVIDENCE_STATUSES.includes(observation.status) ? observation.status : "invalid";
  const facts = normalizedFacts || {};
  const sourceReference = safeSourceReference(observation.source_reference);
  const record = {
    evidence_id: safeId(`ev_${kind}`),
    run_id: runId,
    check_kind: kind,
    status,
    facts,
    units: safeFacts(observation.units) || {},
    redaction_class: "public_normalized",
    provider_id: provider.manifest.provider_id,
    provider_backend: provider.manifest.provider_backend,
    semantic_operation: operationFor(kind),
    source_reference: sourceReference,
    authority_class: "synthetic_demo_fixture",
    observed_at: observation.observed_at || MOCK_OBSERVED_AT,
    fresh_until: status === "stale" ? MOCK_OBSERVED_AT : MOCK_FRESH_UNTIL,
    response_hash: hashValue({ kind, status, facts }),
    schema_version: BUNDLE_SCHEMA,
    policy_version: policyVersion,
    provenance: provenance.label,
  };
  return record;
}

export function buildEvidenceBundle(records) {
  const byKind = new Map(records.map((record) => [record.check_kind, record]));
  const asset = byKind.get("asset");
  const branch = (kind) => {
    const record = byKind.get(kind);
    return { status: record?.status || "missing", evidence_ids: record?.status === "complete" ? [record.evidence_id] : [] };
  };
  const statuses = Object.fromEntries(EVIDENCE_STATUSES.map((status) => [status, records.filter((record) => record.status === status).map((record) => record.check_kind)]));
  const bundle = {
    schema_version: BUNDLE_SCHEMA,
    asset: {
      status: asset?.status || "missing",
      ...(asset?.status === "complete" ? { asset_id: asset.facts.asset_id, display_name: asset.facts.display_name } : {}),
      evidence_ids: asset?.status === "complete" ? [asset.evidence_id] : [],
    },
    branches: { quality: branch("quality"), governance: branch("governance"), lineage: branch("lineage") },
    coverage: {
      required: [...REQUIRED_EVIDENCE],
      complete: statuses.complete,
      missing: statuses.missing,
      denied: statuses.denied,
      timed_out: statuses.timed_out,
      stale: statuses.stale,
      unavailable: statuses.unavailable,
      invalid: statuses.invalid,
    },
  };
  validateEvidenceBundle(bundle);
  return bundle;
}

function safeFacts(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || key.length > 80 || /token|secret|password|credential|api[_ -]?key/i.test(key) || item === undefined || typeof item === "object" || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null)) return null;
    if (typeof item === "string" && containsUnsafeText(item)) return null;
    result[key] = typeof item === "string" ? redactText(item, 240) : item;
  }
  return result;
}

function safeSourceReference(value) {
  if (typeof value !== "string" || !value.trim()) return "Demo evidence";
  const source = value.trim();
  if (/^https?:/i.test(source)) return safeSourceLink(source) || "Unapproved source removed";
  return redactText(source, 240);
}

function operationFor(kind) {
  return { asset: "describe_asset", quality: "read_quality", governance: "read_governance", lineage: "read_lineage" }[kind];
}

function evidenceProjection(record) {
  if (!record) return null;
  return {
    evidence_id: record.evidence_id,
    run_id: record.run_id,
    check_kind: record.check_kind,
    status: record.status,
    facts: record.facts,
    units: record.units,
    source_label: "Demo evidence",
    authority_class: record.authority_class,
    semantic_operation: record.semantic_operation,
    observed_at: record.observed_at,
    fresh_until: record.fresh_until,
    policy_version: record.policy_version,
    safe_hash: record.response_hash,
    provenance: PROVENANCE.label,
  };
}

export class DraftVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftVerificationError";
  }
}

export function fallbackDraft(decisionValue, records) {
  const completeIds = records.filter((record) => record.status === "complete").map((record) => record.evidence_id);
  const gaps = records.filter((record) => record.status !== "complete");
  return {
    schema_version: DRAFT_SCHEMA,
    headline: `Data readiness: ${decisionValue}`,
    summary: `Deterministic template: ${decisionValue === "UNKNOWN" ? "usable authoritative demo evidence is unavailable" : decisionValue === "BLOCKED" ? "a configured hard stop is present" : "the configured checks were evaluated"}.`,
    summary_evidence_ids: completeIds.slice(0, 4),
    risks: gaps.slice(0, 5).map((record) => ({ severity: decisionValue === "BLOCKED" ? "high" : "medium", kind: "evidence_gap", text: `${capitalize(record.check_kind)} evidence is ${record.status.replaceAll("_", " ")}.`, evidence_ids: [] })),
    recommendations: recommendationsFor(decisionValue, gaps),
    cited_evidence_ids: completeIds,
  };
}

export function verifyAndProject({ runId, runStatus, policyDecision, draft, records, provenance = PROVENANCE }) {
  const evidenceBundle = buildEvidenceBundle(records);
  const preWritePolicy = policyDecision;
  const finalPolicyDecision = evaluatePolicy(records);
  const policyMatched = stablePolicy(preWritePolicy) === stablePolicy(finalPolicyDecision);
  if (!policyMatched) policyDecision = finalPolicyDecision;
  for (const record of records) {
    if (!record || typeof record.evidence_id !== "string" || !/^ev_(asset|quality|governance|lineage)_[a-f0-9]{32}$/.test(record.evidence_id) || record.run_id !== runId || !EVIDENCE_STATUSES.includes(record.status) || record.provenance !== provenance.label || containsUnsafeText(JSON.stringify(record.facts)) || record.response_hash !== hashValue({ kind: record.check_kind, status: record.status, facts: record.facts })) {
      throw new DraftVerificationError("Evidence record failed safe publication validation");
    }
  }
  const recordById = new Map(records.map((record) => [record.evidence_id, record]));
  try {
    validateDraft(draft);
    if (containsUnsafeText(JSON.stringify(draft))) throw new DraftVerificationError("Draft contains unsafe or sensitive text");
    if (![...draft.summary_evidence_ids, ...draft.cited_evidence_ids].every((id) => recordById.has(id))) throw new DraftVerificationError("Draft cited an unknown evidence ID");
    for (const id of [...draft.summary_evidence_ids, ...draft.cited_evidence_ids]) {
      if (recordById.get(id).status !== "complete") throw new DraftVerificationError("Draft cited non-complete evidence");
    }
    for (const risk of draft.risks) {
      if (!risk.evidence_ids.every((id) => recordById.has(id))) throw new DraftVerificationError("Risk cited an unknown evidence ID");
    }
    if (draft.recommendations.length > 3) throw new DraftVerificationError("Too many recommendations");
  } catch (error) {
    draft = fallbackDraft(policyDecision.decision, records);
    validateDraft(draft);
  }

  const checks = CHECK_KINDS.map((kind) => {
    const record = records.find((item) => item.check_kind === kind);
    if (!record) return { check_kind: kind, status: "missing", evidence_ids: [], label: checkLabel(kind), evidence_available: false };
    return { check_kind: kind, status: record.status, ...(record.status === "complete" ? { evidence_id: record.evidence_id } : {}), label: checkLabel(kind), evidence_available: record.status === "complete" };
  });
  const gaps = records.filter((record) => record.status !== "complete").map((record) => ({ check_kind: record.check_kind, status: record.status, evidence_ids: [], message: `${checkLabel(record.check_kind)} evidence is ${record.status.replaceAll("_", " ")}.` }));
  const coverage = {
    required: [...REQUIRED_EVIDENCE],
    complete: records.filter((record) => record.status === "complete").map((record) => record.check_kind),
    missing: records.filter((record) => record.status === "missing").map((record) => record.check_kind),
    denied: records.filter((record) => record.status === "denied").map((record) => record.check_kind),
    stale: records.filter((record) => record.status === "stale").map((record) => record.check_kind),
    timed_out: records.filter((record) => record.status === "timed_out").map((record) => record.check_kind),
    unavailable: records.filter((record) => record.status === "unavailable").map((record) => record.check_kind),
    invalid: records.filter((record) => record.status === "invalid").map((record) => record.check_kind),
  };
  return {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    workflow: WORKFLOW,
    run_status: runStatus,
    decision: policyDecision.decision,
    headline: redactText(draft.headline, 180),
    summary: redactText(draft.summary, 1200),
    resolved_asset: resolvedAsset(records),
    summary_evidence_ids: [...draft.summary_evidence_ids],
    summary_claims: [{ text: redactText(draft.summary, 1200), evidence_ids: [...draft.summary_evidence_ids] }],
    checks,
    risks: draft.risks.map((risk) => ({ severity: risk.severity, kind: risk.kind, text: redactText(risk.text, 600), evidence_ids: [...risk.evidence_ids] })),
    recommendations: draft.recommendations.slice(0, 3).map((item) => redactText(item, 300)),
    gaps,
    coverage,
    policy_version: policyDecision.policy_version,
    policy_disclosure: READINESS_POLICY.note,
    policy_reasons: policyDecision.reasons,
    policy_decision: policyDecision,
    final_policy_recomputed: true,
    policy_comparison: { pre_write_decision: preWritePolicy.decision, final_decision: finalPolicyDecision.decision, matched: policyMatched },
    provenance,
    evidence_bundle: evidenceBundle,
    limitations: ["Demo evidence is synthetic and deterministic; it is not a current partner observation.", "This result is not legal, privacy, rights, or publishing approval.", "Next checks are suggestions for a person; the product does not execute them."],
  };
}

function completeEvidenceIds(record) {
  return record?.status === "complete" && record.evidence_id ? [record.evidence_id] : [];
}

function resolvedAsset(records) {
  const asset = records.find((record) => record.check_kind === "asset" && record.status === "complete");
  if (!asset) return null;
  return { asset_id: redactText(asset.facts.asset_id, 160), display_name: redactText(asset.facts.display_name, 240), workspace: redactText(asset.facts.workspace, 200), evidence_id: asset.evidence_id };
}

function checkLabel(kind) {
  return { asset: "Resolved asset", quality: "Quality", governance: "Governance", lineage: "Lineage" }[kind] || kind;
}

function safeClarification(candidates) {
  return candidates.slice(0, 3).map((candidate) => ({
    candidate_id: candidate.candidate_id,
    display_name: redactText(candidate.display_name, 200),
    workspace: redactText(candidate.workspace, 200),
    last_observed_at: candidate.last_observed_at,
  }));
}

function phaseFor(state) {
  return { accepted: "Accepted", queued: "Queued", planning: "Planning", resolving_asset: "Resolving asset", evidence_pending: "Evidence checks", evidence_partial: "Partial evidence", composing: "Composing", validating: "Validating", needs_input: "Clarify", succeeded: "Complete", cancel_requested: "Cancellation requested", canceled: "Canceled", expired: "Expired", failed: "Recovery" }[state] || state;
}

export function projectRun(run, store) {
  if (!run) return undefined;
  const events = store.getEvents(run.run_id);
  const terminal = TERMINAL_STATES.has(run.state);
  const workflowProjection = typeof store.workflowProjection === "function" ? store.workflowProjection(run.run_id) : null;
  const projection = {
    schema_version: "run-projection@1",
    run_id: run.run_id,
    workflow: WORKFLOW,
    state: run.state,
    status: run.state === "needs_input" ? "NEEDS_INPUT" : run.result?.decision || (terminal ? "RECOVERY" : "RUNNING"),
    phase: phaseFor(run.state),
    created_at: run.created_at,
    updated_at: run.updated_at,
    elapsed_ms: Math.max(0, Math.min(Date.now() - Date.parse(run.created_at), 90_000)),
    last_event_seq: events.at(-1)?.seq || 0,
    progress: run.progress,
    decision: run.decision,
    result: run.result,
    clarification: run.clarification,
    parent_run_id: run.parent_run_id,
    retry_count: run.retry_count,
    attempts: Math.min(run.attempt_count || 0, MAX_ATTEMPTS),
    cancellation_requested: run.cancellation_requested,
    workflow_state: workflowProjection?.state || null,
    checkpoints: workflowProjection?.checkpoints || [],
    branches: workflowProjection?.branches || [],
    provenance: run.provenance || PROVENANCE,
    recovery: run.error ? { kind: "retryable_failure", message: run.error.message, recoverable: run.error.recoverable, original_run_id: run.run_id, actions: run.error.recoverable ? ["retry"] : [] } : terminal && run.state === "canceled" ? { kind: "canceled", message: "Cancellation was recorded. No late result will be published.", recoverable: true, original_run_id: run.run_id, actions: ["retry"] } : null,
  };
  return projection;
}

export class MockEngine {
  constructor({ store, provider = new MockProvider(), model = new FakeModel(), clock = Date, audit } = {}) {
    if (!store) throw new Error("MockEngine requires a store");
    this.store = store;
    this.provider = provider;
    this.model = model;
    this.clock = clock;
    this.audit = audit;
    const modelBackend = typeof model.provenance === "function" ? model.provenance() : undefined;
    const providerBackend = {
      backend: provider.manifest?.provider_id === "mock-provider" ? "mock" : "provider",
      provider_id: provider.manifest?.provider_id || null,
      manifest_hash: provider.manifest?.manifest_hash || null,
      semantic_operation: "fixed-read-only",
    };
    this.provenance = combineProvenance({ modelBackend, providerBackend });
    this.jobs = new Map();
    this.ownerId = `worker_${process.pid}_${safeId("owner")}`;
  }

  resumeActive() {
    this.store.recoverExpiredLeases();
    for (const run of this.store.listActiveRuns()) this.enqueue(run.run_id);
    return this.store.listActiveRuns().map((run) => run.run_id);
  }

  refreshProvenance() {
    const modelBackend = typeof this.model.provenance === "function" ? this.model.provenance() : undefined;
    const providerBackend = {
      backend: this.provider.manifest?.provider_id === "mock-provider" ? "mock" : "provider",
      provider_id: this.provider.manifest?.provider_id || null,
      manifest_hash: this.provider.manifest?.manifest_hash || null,
      semantic_operation: "fixed-read-only",
    };
    this.provenance = combineProvenance({ modelBackend, providerBackend });
    return this.provenance;
  }

  enqueue(runId) {
    if (this.jobs.has(runId)) return this.jobs.get(runId);
    const job = Promise.resolve().then(() => this.execute(runId)).catch((error) => {
      if (!(error instanceof CancellationError)) {
        const run = this.store.getRun(runId);
        if (run && !TERMINAL_STATES.has(run.state)) {
          this.store.transition(runId, run.state, { provenance: this.refreshProvenance() });
          this.store.markFailed(runId, { class: error.code || "failed", message: "The run stopped safely before a verified result was available.", recoverable: true });
          this.store.appendEvent(runId, "run.failed", "recovery", "failed", "Run needs recovery", { recoverable: true });
          this.audit?.record({ type: "request_outcome", outcome: "failed", mode: this.provenance.model_backend.backend, runId, code: error.code || "failed", provenance: this.provenance, attributes: { recoverable: true } });
        }
      }
      return this.store.getRun(runId);
    }).finally(() => this.jobs.delete(runId));
    this.jobs.set(runId, job);
    return job;
  }

  async waitForIdle(runId) {
    const job = this.jobs.get(runId);
    if (job) await job;
    return this.store.getRun(runId);
  }

  requestCancel(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    if (TERMINAL_STATES.has(run.state)) return run;
    const queued = ["accepted", "queued"].includes(run.state);
    this.store.requestCancellation(runId);
    const updated = this.store.transition(runId, "cancel_requested", { cancellation_requested: true });
    this.store.appendEvent(runId, "run.cancel_requested", "recovery", "cancel_requested", "Cancellation requested", {});
    if (queued || updated.state === "accepted" || updated.state === "queued") {
      this.store.transition(runId, "canceled", { cancellation_requested: true });
      this.store.setTerminalOutcome(runId, "canceled", { reasonCode: "cancel_requested", message: "Run canceled before work started", recoverable: true });
      this.store.appendEvent(runId, "run.canceled", "recovery", "canceled", "Run canceled before work started", {});
    }
    return this.store.getRun(runId);
  }

  async retry(runId, { idempotencyHash } = {}) {
    const run = this.store.getRun(runId);
    if (!run) throw new ContractError("RUN_NOT_FOUND", "Run not found");
    if (!["failed", "expired", "canceled"].includes(run.state)) throw new ContractError("RUN_NOT_RETRYABLE", "Only a recoverable terminal run can be retried");
    const child = this.store.createRun({ request: run.request, requestHash: run.request_hash, idempotencyHash: idempotencyHash || hashValue(`${runId}|retry|${Date.now()}|${safeId("key")}`), parentRunId: runId, retryCount: run.retry_count + 1, provenance: this.provenance }).run;
    this.enqueue(child.run_id);
    return child;
  }

  async clarify(runId, candidateId, { idempotencyHash } = {}) {
    const run = this.store.getRun(runId);
    if (!run || run.state !== "needs_input" || !run.clarification) throw new ContractError("RUN_NOT_CLARIFIABLE", "Run is not awaiting clarification");
    const candidate = run.clarification.candidates.find((item) => item.candidate_id === candidateId);
    if (!candidate) throw new ContractError("INVALID_CANDIDATE", "That clarification option is not available for this run");
    const request = { ...run.request, asset_hint: candidate.candidate_id };
    const child = this.store.createRun({ request, requestHash: hashValue(request), idempotencyHash: idempotencyHash || hashValue(`${runId}|clarify|${candidateId}|${Date.now()}|${safeId("key")}`), parentRunId: runId, retryCount: 0, provenance: this.provenance }).run;
    this.enqueue(child.run_id);
    return child;
  }

  async execute(runId) {
    const lease = this.store.acquireLease(runId, this.ownerId);
    if (!lease) return this.store.getRun(runId);
    try {
      return await this.executeWorkflow(runId);
    } finally {
      this.store.releaseLease(runId, this.ownerId);
    }
  }

  async executeWorkflow(runId) {
    let run = this.store.getRun(runId);
    if (!run || TERMINAL_STATES.has(run.state)) return run;
    this.advance(runId, "queued", "queue", "Queued");
    this.checkCancellation(runId);
    this.advance(runId, "planning", "planning", "Planning request");
    const plan = validatePlan(await this.model.plan(run.request, { workflow: WORKFLOW, run_id: runId, stage: "planner", deadline_at: run.deadline_at, rate_limit_key: run.actor }));
    this.refreshProvenance();
    this.checkCancellation(runId);
    this.advance(runId, "resolving_asset", "resolution", "Resolving one demo asset");
    const query = plan.asset_query || run.request.asset_hint || "";
    let resolution;
    try {
      resolution = await this.provider.resolve_asset({ retry_count: run.retry_count }, query, plan.container_query);
    } catch (error) {
      if (isRecoveryScenario(run) && run.retry_count === 0) return this.failRecoverably(runId, "Demo evidence was unavailable during asset resolution");
      resolution = { status: "none", candidates: [] };
    }
    this.checkCancellation(runId);
    if (resolution.status === "multiple") {
      this.store.transition(runId, "needs_input", { phase: "needs_input", clarification: { question: "Which matching demo asset should this brief assess?", candidates: safeClarification(resolution.candidates) } });
      this.store.appendEvent(runId, "run.needs_input", "resolution", "needs_input", "Choose one matching asset", { candidate_count: resolution.candidates.length });
      return this.store.getRun(runId);
    }
    if (resolution.status !== "resolved" || !resolution.asset) {
      const records = [makeEvidenceRecord(runId, "asset", { status: "missing", facts: {}, units: {}, source_reference: "Demo asset resolution returned no match" }, this.provider, { provenance: this.provenance })];
      for (const record of records) this.store.addEvidence(runId, record);
      const policyDecision = evaluatePolicy(records);
      return this.finishWithResult(runId, policyDecision, records);
    }
    const asset = resolution.asset;
    const persistedEvidence = this.store.listEvidence(runId);
    const persistedAsset = persistedEvidence.find((record) => record.check_kind === "asset" && record.status === "complete");
    const records = persistedAsset ? [persistedAsset] : [];
    if (!persistedAsset) {
      const assetObservation = await this.provider.describe_asset({ retry_count: run.retry_count }, asset);
      records.push(makeEvidenceRecord(runId, "asset", assetObservation, this.provider, { provenance: this.provenance }));
      this.store.addEvidence(runId, records[0]);
    }
    this.advance(runId, "evidence_pending", "evidence", "Reading quality, governance, and lineage", { total: 3, completed: 0, branches: { quality: { state: "pending", status: null, attempts: 0 }, governance: { state: "pending", status: null, attempts: 0 }, lineage: { state: "pending", status: null, attempts: 0 } } });
    const branchKinds = ["quality", "governance", "lineage"];
    const branchResults = await Promise.all(branchKinds.map(async (kind) => {
      this.checkCancellation(runId);
      const persisted = this.store.listEvidence(runId).find((record) => record.check_kind === kind && record.status === "complete");
      if (persisted) {
        this.updateBranchProgress(runId, kind, { state: "complete", status: persisted.status, attempts: 0 });
        return persisted;
      }
      this.updateBranchProgress(runId, kind, { state: "running", status: null });
      this.store.appendEvent(runId, "evidence.started", kind, "evidence_pending", `${capitalize(kind)} check started`, { operation: operationFor(kind) });
      const observation = await this.readBranch(runId, kind, asset, run.request.purpose, run.retry_count);
      this.checkCancellation(runId);
      const record = makeEvidenceRecord(runId, kind, observation, this.provider, { provenance: this.provenance });
      this.store.addEvidence(runId, record);
      this.updateBranchProgress(runId, kind, { state: record.status === "complete" ? "complete" : "partial", status: record.status, attempts: Math.min(MAX_ATTEMPTS, this.store.getRun(runId).attempt_count) });
      return record;
    }));
    records.push(...branchResults);
    this.checkCancellation(runId);
    const failedRecoveryBranch = branchResults.some((record) => ["unavailable", "timed_out"].includes(record.status));
    if (failedRecoveryBranch && isRecoveryScenario(run) && run.retry_count === 0) return this.failRecoverably(runId, "Demo evidence was unavailable after bounded retries");
    const partial = branchResults.some((record) => record.status !== "complete");
    if (partial) {
      this.store.transition(runId, "evidence_partial", { phase: "evidence_partial", progress: { ...(this.store.getRun(runId).progress || {}), completed: 3, total: 3 } });
      this.store.appendEvent(runId, "evidence.partial", "evidence", "evidence_partial", "Partial evidence is visible", { missing: branchResults.filter((record) => record.status !== "complete").map((record) => record.check_kind) });
    }
    const policyDecision = evaluatePolicy(records);
    this.store.transition(runId, partial ? "evidence_partial" : "evidence_pending", { policy_decision: policyDecision, decision: policyDecision.decision, progress: { ...(this.store.getRun(runId).progress || {}), completed: 3, total: 3 } });
    this.store.appendEvent(runId, "policy.computed", "policy", partial ? "evidence_partial" : "evidence_pending", `Policy computed: ${policyDecision.decision}`, { decision: policyDecision.decision, policy_version: POLICY_VERSION, reason_count: policyDecision.reasons.length });
    return this.compose(runId, policyDecision, records);
  }

  async readBranch(runId, kind, asset, purpose, retryCount) {
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      const run = this.store.getRun(runId);
      this.checkCancellation(runId);
      this.store.transition(runId, run.state, { attempt_count: Math.max(run.attempt_count, attempt) });
      try {
        const context = { retry_count: retryCount, run_id: runId, manifest_hash: this.provider.manifest.manifest_hash };
        if (kind === "quality") return await this.provider.read_quality(context, asset);
        if (kind === "governance") return await this.provider.read_governance(context, asset, purpose);
        return await this.provider.read_lineage(context, asset);
      } catch (error) {
        const retryable = error instanceof ProviderError && (error.retryable || RETRYABLE_PROVIDER_ERRORS.has(error.kind));
        this.store.appendEvent(runId, "evidence.attempt", kind, "evidence_pending", `${capitalize(kind)} attempt ${attempt} did not complete`, { attempt, retryable: Boolean(retryable), error_class: error.kind || "unavailable" });
        if (!retryable || attempt >= MAX_ATTEMPTS) return { status: mapProviderStatus(error), facts: {}, units: {}, source_reference: `Demo ${kind} evidence unavailable` };
        await sleep(10 * attempt);
      }
    }
    return { status: "unavailable", facts: {}, units: {}, source_reference: `Demo ${kind} evidence unavailable` };
  }

  async compose(runId, policyDecision, records) {
    this.checkCancellation(runId);
    this.store.transition(runId, "composing", { phase: "composing" });
    this.store.appendEvent(runId, "writer.started", "writer", "composing", "Composing evidence-backed brief", { model_backend: this.provenance.model_backend.backend });
    let draft;
    try {
      const writerInput = { decision: policyDecision.decision, policy_decision: policyDecision, evidence_bundle: buildEvidenceBundle(records), records: records.map((record) => ({ ...record, facts: { ...record.facts } })), policy_version: POLICY_VERSION };
      const write = typeof this.model.write === "function" ? this.model.write.bind(this.model) : this.model.draft.bind(this.model);
      draft = await write(writerInput, { run_id: runId, stage: "writer", deadline_at: this.store.getRun(runId).deadline_at, rate_limit_key: this.store.getRun(runId).actor });
    } catch {
      draft = fallbackDraft(policyDecision.decision, records);
      this.store.appendEvent(runId, "writer.fallback", "writer", "composing", "Using deterministic brief template", { reason: "writer_unavailable" });
    }
    this.checkCancellation(runId);
    this.store.transition(runId, "validating", { phase: "validating" });
    this.store.appendEvent(runId, "verifier.started", "verifier", "validating", "Validating evidence and provenance", { projection: "public" });
    const result = verifyAndProject({ runId, runStatus: "succeeded", policyDecision, draft, records, provenance: this.refreshProvenance() });
    this.store.addResult(runId, result, result.decision);
    this.store.appendEvent(runId, "run.succeeded", "projection", "succeeded", `Brief ready: ${result.decision}`, { decision: result.decision, provenance: this.provenance.label });
    this.audit?.record({ type: "request_outcome", outcome: "succeeded", mode: this.provenance.model_backend.backend, runId, provenance: this.provenance, attributes: { decision: result.decision } });
    return this.store.getRun(runId);
  }

  async finishWithResult(runId, policyDecision, records) {
    this.store.transition(runId, "evidence_pending", { policy_decision: policyDecision, decision: policyDecision.decision, progress: { completed: 0, total: 0 } });
    this.store.appendEvent(runId, "policy.computed", "policy", "evidence_pending", `Policy computed: ${policyDecision.decision}`, { decision: policyDecision.decision, policy_version: POLICY_VERSION, reason_count: policyDecision.reasons.length });
    return this.compose(runId, policyDecision, records);
  }

  failRecoverably(runId, message) {
    this.store.markFailed(runId, { class: "unavailable", message, recoverable: true });
    this.store.appendEvent(runId, "run.failed", "recovery", "failed", "Demo run needs recovery", { recoverable: true, action: "retry" });
    this.audit?.record({ type: "request_outcome", outcome: "failed", mode: this.provenance.model_backend.backend, runId, code: "unavailable", provenance: this.provenance, attributes: { recoverable: true } });
    return this.store.getRun(runId);
  }

  updateBranchProgress(runId, kind, patch) {
    const run = this.store.getRun(runId);
    const branches = { ...(run?.progress?.branches || {}) };
    branches[kind] = { ...(branches[kind] || {}), ...patch };
    const completed = Object.values(branches).filter((branch) => ["complete", "partial"].includes(branch.state)).length;
    this.store.transition(runId, run.state, { progress: { ...(run.progress || {}), branches, completed, total: 3 } });
    const branchState = patch.state === "running" ? "running" : patch.state === "complete" ? "succeeded" : patch.state === "partial" ? "failed" : "pending";
    this.store.upsertBranch(runId, kind, { kind, state: branchState, attempt: patch.attempts || 0, error: patch.status && patch.status !== "complete" ? { code: String(patch.status), recoverable: true } : null });
  }

  advance(runId, state, step, display, payload = {}) {
    const run = this.store.getRun(runId);
    const patch = Object.keys(payload).length ? { progress: { ...(run?.progress || {}), ...payload } } : {};
    this.store.transition(runId, state, { phase: state, ...patch });
    const checkpointKind = { accepted: "accepted", queued: "accepted", planning: "plan", resolving_asset: "resolution", evidence_pending: "branch", evidence_partial: "branch", composing: "composition", validating: "validation", succeeded: "terminal", canceled: "terminal", failed: "terminal", expired: "terminal" }[state];
    if (checkpointKind) this.store.saveCheckpoint(runId, { kind: checkpointKind, phase: state, input: { run_id: runId, state }, output: { state, step }, payload: { display, ...(state === "evidence_pending" ? { total: payload.total || 0 } : {}) } });
    this.store.appendEvent(runId, `run.${state}`, step, state, display, payload);
  }

  checkCancellation(runId) {
    const run = this.store.getRun(runId);
    if (run?.cancellation_requested || run?.state === "cancel_requested") {
      if (!TERMINAL_STATES.has(run.state)) {
        this.store.transition(runId, "canceled", { cancellation_requested: true, phase: "canceled" });
        this.store.setTerminalOutcome(runId, "canceled", { reasonCode: "cancel_requested", message: "Cancellation confirmed; late results discarded", recoverable: true });
        this.store.appendEvent(runId, "run.canceled", "recovery", "canceled", "Cancellation confirmed; late results discarded", {});
      }
      throw new CancellationError();
    }
  }
}

function mapProviderStatus(error) {
  const kind = error?.kind;
  if (kind === "denied") return "denied";
  if (kind === "timeout") return "timed_out";
  if (kind === "malformed" || kind === "schema_drift") return "invalid";
  if (kind === "stale") return "stale";
  return "unavailable";
}

function isRecoveryScenario(run) {
  return lower(run.request.asset_hint).includes("recovery") || lower(run.request.asset_hint).includes("timeout") || lower(run.request.asset_hint).includes("unavailable");
}
