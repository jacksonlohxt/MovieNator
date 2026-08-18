import {
  PartnerError,
  createPartnerCapability,
  partnerProvenance,
  safePartnerHash,
} from "./partner-contracts.js";

export const LOCAL_MOCK_PROVIDER_ID = "mock-provider";
export const LOCAL_MOCK_OBSERVED_AT = "2026-08-14T14:00:00.000Z";
export const LOCAL_MOCK_FRESH_UNTIL = "2026-08-21T14:00:00.000Z";

const ASSETS = Object.freeze([
  { asset_id: "asset_demo_001", candidate_id: "season_2_audience_engagement", display_name: "Season 2 audience engagement", fixture: "ready" },
  { asset_id: "asset_demo_002", candidate_id: "season_2_campaign_audience", display_name: "Season 2 campaign audience", fixture: "review" },
  { asset_id: "asset_demo_003", candidate_id: "season_2_restricted_audience", display_name: "Season 2 restricted audience", fixture: "blocked" },
]);

function pause(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new PartnerError("canceled", "Partner operation canceled", { retryable: false }));
      } else signal.addEventListener("abort", () => { clearTimeout(timer); reject(new PartnerError("canceled", "Partner operation canceled", { retryable: false })); }, { once: true });
    }
  });
}

function normalizeQuery(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function fixtureFor(input) {
  const query = normalizeQuery(input?.query || input?.asset_id || input?.asset_hint);
  if (query.includes("unknown") || query.includes("no_such") || query.includes("not found")) return null;
  if (query.includes("blocked")) return ASSETS[2];
  if (query.includes("campaign") || query.includes("review")) return ASSETS[1];
  return ASSETS[0];
}

/**
 * Credential-free, deterministic partner-shaped adapter. It uses synthetic
 * asset, metadata, quality, governance, lineage, search, and telemetry facts.
 * There is no URL transport, secret, or outbound network path in this class.
 */
export class LocalMockPartnerAdapter {
  constructor({ clock = Date, delayMs = 0, faultPlan = {}, observedAt = LOCAL_MOCK_OBSERVED_AT, freshUntil = LOCAL_MOCK_FRESH_UNTIL } = {}) {
    this.clock = clock;
    this.delayMs = delayMs;
    this.faultPlan = { ...faultPlan };
    this.observedAt = observedAt;
    this.freshUntil = freshUntil;
    this.calls = [];
    this.capability = createPartnerCapability({
      provider: { provider_id: LOCAL_MOCK_PROVIDER_ID, display_name: "Movie-Inator local synthetic partner", product_ref: "synthetic-fixtures@1", confirmation_state: "confirmed" },
      environment: "local",
      endpointRef: "local://movie-inator/mock",
      authMode: "none_synthetic",
      scopeRef: "Demo Media Workspace",
      allowedOperations: [
        { operation: "resolve_asset", tool_ref: "local.resolve_asset", data_class: "search" },
        { operation: "describe_asset", tool_ref: "local.describe_asset", data_class: "metadata" },
        { operation: "read_metadata", tool_ref: "local.read_metadata", data_class: "metadata" },
        { operation: "read_quality", tool_ref: "local.read_quality", data_class: "quality" },
        { operation: "read_governance", tool_ref: "local.read_governance", data_class: "governance" },
        { operation: "read_lineage", tool_ref: "local.read_lineage", data_class: "lineage" },
        { operation: "search_metadata", tool_ref: "local.search_metadata", data_class: "search" },
        { operation: "search_governance", tool_ref: "local.search_governance", data_class: "governance" },
        { operation: "search_lineage", tool_ref: "local.search_lineage", data_class: "lineage" },
        { operation: "read_telemetry", tool_ref: "local.read_telemetry", data_class: "telemetry" },
      ],
      dataClasses: ["synthetic_asset", "metadata", "quality", "governance", "lineage", "search", "telemetry"],
      manifestHash: safePartnerHash("movie-inator|local.mock|synthetic-fixtures@1|read-only"),
      health: { state: "healthy", checked_at: new Date(clock()).toISOString() },
      limits: { timeout_ms: 2_000, max_attempts: 2, max_response_bytes: 64_000, max_items: 100 },
    });
    // Compatibility manifest lets this adapter be injected into the existing
    // EvidenceProvider seam without exposing a provider-specific tool catalog.
    this.manifest = Object.freeze({
      provider_id: LOCAL_MOCK_PROVIDER_ID,
      provider_backend: "LocalMockPartnerAdapter",
      version: "synthetic-fixtures@1",
      scope_reference: "Demo Media Workspace",
      transport: "in-process",
      auth_mode: "none_synthetic",
      read_only: true,
      operations: this.capability.allowed_operations.map((item) => item.operation),
      manifest_hash: this.capability.manifest_hash,
    });
  }

  capabilities() {
    return this.capability;
  }

  readiness({ now = new Date(this.clock()).toISOString() } = {}) {
    return {
      schema_version: "partner-readiness@1",
      provider_id: LOCAL_MOCK_PROVIDER_ID,
      provider_display_name: this.capability.provider.display_name,
      environment: "local",
      endpoint_ref: this.capability.endpoint_ref,
      auth_mode: this.capability.auth_mode,
      scope_ref: this.capability.scope_ref,
      state: "ready",
      health: "healthy",
      checked_at: now,
      reason_codes: [],
      provenance: partnerProvenance({ capability: this.capability }),
    };
  }

  // These methods make the adapter directly usable by Movie-Inator's
  // existing EvidenceProvider interface. They return normalized observations,
  // while invoke() remains the partner-runtime boundary.
  async resolve_asset(context, query) {
    return this.invoke("resolve_asset", { query }, context);
  }

  async describe_asset(context, asset) {
    return this.invoke("describe_asset", { asset_id: asset.asset_id }, context);
  }

  async read_quality(context, asset) {
    return this.invoke("read_quality", { asset_id: asset.asset_id }, context);
  }

  async read_governance(context, asset, purpose) {
    return this.invoke("read_governance", { asset_id: asset.asset_id, purpose }, context);
  }

  async read_lineage(context, asset) {
    return this.invoke("read_lineage", { asset_id: asset.asset_id }, context);
  }

  async invoke(operation, input = {}, context = {}) {
    this.calls.push({ operation, input: { ...input }, delivery_id: context.delivery_id || null, at: new Date(this.clock()).toISOString() });
    const fault = this.nextFault(operation);
    await pause(this.delayMs, context.signal);
    if (fault) {
      if (fault.kind === "timeout") await pause(fault.delayMs || 100, context.signal);
      throw new PartnerError(fault.kind || "unavailable", fault.message || `Synthetic ${operation} failure`, { retryable: fault.retryable !== false, status: fault.status });
    }
    if (operation === "resolve_asset" || operation === "search_metadata") return this.searchMetadata(input);
    if (operation === "describe_asset" || operation === "read_metadata") return this.readMetadata(input);
    if (operation === "read_quality") return this.readQuality(input);
    if (operation === "read_governance" || operation === "search_governance") return this.readGovernance(input);
    if (operation === "read_lineage" || operation === "search_lineage") return this.readLineage(input);
    if (operation === "read_telemetry") return this.readTelemetry(input);
    throw new PartnerError("unknown_capability", `Synthetic operation is not registered: ${operation}`, { retryable: false });
  }

  nextFault(operation) {
    const configured = this.faultPlan[operation];
    if (!configured) return null;
    if (Array.isArray(configured)) {
      const fault = configured.shift();
      return fault || null;
    }
    if (typeof configured === "function") return configured({ operation, calls: this.calls.length });
    return configured;
  }

  searchMetadata(input) {
    const query = normalizeQuery(input.query || input.asset_hint);
    if (query.includes("ambiguous") || query === "audience" || query.includes("multiple")) {
      return { status: "multiple", candidates: ASSETS.slice(0, 2).map((asset) => this.assetCandidate(asset)), observed_at: this.observedAt, fresh_until: this.freshUntil };
    }
    const asset = fixtureFor(input);
    return asset ? { status: "resolved", asset: this.asset(asset), candidates: [], observed_at: this.observedAt, fresh_until: this.freshUntil } : { status: "none", asset: null, candidates: [], observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  readMetadata(input) {
    const asset = this.findAsset(input);
    if (!asset) return this.missing("metadata");
    return { status: "complete", asset: this.asset(asset), facts: { asset_id: asset.asset_id, display_name: asset.display_name, workspace: "Demo Media Workspace", asset_type: "audience engagement" }, units: {}, source_reference: `Synthetic metadata ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  readQuality(input) {
    const asset = this.findAsset(input);
    if (!asset) return this.missing("quality");
    if (asset.fixture === "review") return { status: "complete", facts: { completeness: 94.2, validity: 99.1, duplicate_rate: 1.2 }, units: { completeness: "percent", validity: "percent", duplicate_rate: "percent" }, source_reference: `Synthetic quality ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
    return { status: "complete", facts: { completeness: 99.7, validity: 99.2, duplicate_rate: 0.3 }, units: { completeness: "percent", validity: "percent", duplicate_rate: "percent" }, source_reference: `Synthetic quality ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  readGovernance(input) {
    const asset = this.findAsset(input);
    if (!asset) return this.missing("governance");
    if (asset.fixture === "review") return { status: "missing", facts: { approved_purpose: false }, units: {}, source_reference: `Synthetic governance gap ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
    if (asset.fixture === "blocked") return { status: "complete", facts: { approved_purpose: false, hard_stop_code: "GOVERNANCE_HARD_STOP" }, units: {}, source_reference: `Synthetic governance ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
    return { status: "complete", facts: { approved_purpose: true, classification: "internal-demo" }, units: {}, source_reference: `Synthetic governance ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  readLineage(input) {
    const asset = this.findAsset(input);
    if (!asset) return this.missing("lineage");
    return { status: "complete", facts: { upstream_count: 2, downstream_count: asset.fixture === "review" ? 7 : 4, truncated: false }, units: { upstream_count: "nodes", downstream_count: "nodes" }, source_reference: `Synthetic lineage ${asset.asset_id}`, observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  readTelemetry(input) {
    return { status: "complete", facts: { request_count: 0, error_rate: 0, source: "synthetic" }, units: { request_count: "count", error_rate: "percent" }, source_reference: "Synthetic telemetry", observed_at: this.observedAt, fresh_until: this.freshUntil };
  }

  findAsset(input) {
    const assetId = input.asset_id || input.asset?.asset_id;
    return ASSETS.find((item) => item.asset_id === assetId || item.candidate_id === assetId) || fixtureFor(input);
  }

  asset(asset) {
    return { asset_id: asset.asset_id, display_name: asset.display_name, fixture: asset.fixture, workspace: "Demo Media Workspace", last_observed_at: this.observedAt };
  }

  assetCandidate(asset) {
    return { candidate_id: asset.candidate_id, asset_id: asset.asset_id, display_name: asset.display_name, workspace: "Demo Media Workspace", last_observed_at: this.observedAt };
  }

  missing(kind) {
    return { status: "missing", facts: {}, units: {}, source_reference: `Synthetic ${kind} evidence is missing`, observed_at: this.observedAt, fresh_until: this.freshUntil };
  }
}
