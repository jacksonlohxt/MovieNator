import { hashContract, isRecord, redactValue } from "./logic-contracts.js";
import { ToolPolicyError, createToolManifest } from "./tool-registry.js";
import { LOCAL_MOCK_TOOL_ENDPOINT, PRODUCT_DISPLAY_NAME, PRODUCT_IDENTIFIER } from "./product-identity.js";

const WORKSPACE = "Demo Media Workspace";
const OBSERVED_AT = "2026-08-14T14:00:00.000Z";
const FRESH_UNTIL = "2026-08-21T14:00:00.000Z";

const FIXTURES = Object.freeze([
  { asset_id: "asset_demo_001", candidate_id: "season_2_audience_engagement", display_name: "Season 2 audience engagement", fixture: "ready" },
  { asset_id: "asset_demo_002", candidate_id: "season_2_campaign_audience", display_name: "Season 2 campaign audience", fixture: "review" },
  { asset_id: "asset_demo_003", candidate_id: "season_2_restricted_audience", display_name: "Season 2 restricted audience", fixture: "blocked" },
  { asset_id: "asset_demo_004", candidate_id: "season_2_denied_audience", display_name: "Season 2 audience with restricted governance", fixture: "denied" },
  { asset_id: "asset_demo_005", candidate_id: "season_2_stale_audience", display_name: "Season 2 stale audience", fixture: "stale" },
]);

const operations = Object.freeze(["resolve_asset", "describe_asset", "read_quality", "read_governance", "read_lineage"]);
const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string", enum: [...operations] },
    query: { type: "string", minLength: 1, maxLength: 200 },
    asset_id: { type: "string", minLength: 1, maxLength: 100 },
    purpose: { type: "string", maxLength: 120 },
    workspace: { type: "string", enum: [WORKSPACE] },
  },
  required: ["operation"],
};
const outputSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string", minLength: 1, maxLength: 32 }, candidates: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } }, asset: { type: "object", properties: {}, additionalProperties: true }, facts: { type: "object", properties: {}, additionalProperties: true }, units: { type: "object", properties: {}, additionalProperties: true }, source_reference: { type: "string", maxLength: 200 }, observed_at: { type: "string", maxLength: 40 }, fresh_until: { type: "string", maxLength: 40 } }, required: ["status"] };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findAsset(assetId) {
  return FIXTURES.find((asset) => asset.asset_id === assetId || asset.candidate_id === assetId);
}

function safeAsset(asset) {
  return { asset_id: asset.asset_id, candidate_id: asset.candidate_id, display_name: asset.display_name, workspace: WORKSPACE, last_observed_at: OBSERVED_AT };
}

function queryText(input) {
  return String(input.query || "").toLocaleLowerCase();
}

export class LocalMcpDatabase {
  constructor({ fixtures = FIXTURES, workspace = WORKSPACE, clock = Date } = {}) {
    this.workspace = workspace;
    this.clock = clock;
    this.fixtures = fixtures.map((fixture) => ({ ...fixture, workspace }));
    this.calls = [];
    this.manifest = Object.freeze({
      schema_version: "mcp-capability-manifest@1",
      server_id: `${PRODUCT_IDENTIFIER}-local-database`,
      protocol: "mcp-style-local",
      transport: "in-process",
      endpoint: LOCAL_MOCK_TOOL_ENDPOINT,
      credentials: "none",
      read_only: true,
      private_rows: false,
      arbitrary_sql: false,
      mutation_operations: [],
      operations: [...operations],
      workspace,
      manifest_hash: hashContract({ server: `${PRODUCT_IDENTIFIER}-local-database`, operations, workspace }),
      provenance: `${PRODUCT_DISPLAY_NAME} local deterministic fixture`,
    });
  }

  capabilities() {
    return clone(this.manifest);
  }

  listOperations() {
    return [...operations];
  }

  #record(operation) {
    this.calls.push({ operation, at: new this.clock().toISOString() });
  }

  async call(operation, input = {}) {
    if (!operations.includes(operation)) throw new ToolPolicyError("UNKNOWN_OPERATION", `Database operation is not allowlisted: ${operation}`);
    if (!isRecord(input)) throw new ToolPolicyError("INVALID_TOOL_INPUT", "Database tool input must be an object");
    if (Object.keys(input).some((key) => ["sql", "query_text", "credentials", "endpoint", "url", "private_rows"].includes(key))) throw new ToolPolicyError("DATABASE_BOUNDARY", "Raw SQL, credentials, endpoints, URLs, and private rows are not accepted");
    if (input.workspace !== undefined && input.workspace !== this.workspace) throw new ToolPolicyError("SCOPE_DENIED", "Database workspace is outside the configured scope");
    this.#record(operation);
    if (operation === "resolve_asset") return this.resolveAsset(input.query || "");
    const asset = findAsset(input.asset_id);
    if (!asset) return { status: "missing", facts: {}, units: {}, source_reference: "Demo evidence", observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
    if (operation === "describe_asset") return this.describeAsset(asset);
    if (operation === "read_quality") return this.readQuality(asset);
    if (operation === "read_governance") return this.readGovernance(asset, input.purpose);
    return this.readLineage(asset);
  }

  async resolveAsset(query) {
    const text = String(query).toLocaleLowerCase().trim();
    if (!text || text === "audience" || text.includes("ambiguous") || text.includes("multiple")) {
      return { status: "multiple", candidates: this.fixtures.slice(0, 2).map(safeAsset) };
    }
    if (text.includes("unknown") || text.includes("no_such") || text.includes("not found")) return { status: "none", candidates: [] };
    const asset = this.fixtures.find((item) => item.candidate_id === text || item.asset_id === text || item.display_name.toLocaleLowerCase().includes(text));
    return asset ? { status: "resolved", asset: safeAsset(asset) } : { status: "none", candidates: [] };
  }

  async describeAsset(asset) {
    return { status: "complete", facts: { asset_id: asset.asset_id, display_name: asset.display_name, workspace: this.workspace }, units: {}, source_reference: `Demo fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
  }

  async readQuality(asset) {
    if (asset.fixture === "stale") return { status: "stale", facts: { completeness: 98.1, validity: 97.4 }, units: { completeness: "percent", validity: "percent" }, source_reference: `Demo quality fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: OBSERVED_AT };
    return { status: "complete", facts: { completeness: 99.7, validity: 99.2, duplicate_rate: 0.3 }, units: { completeness: "percent", validity: "percent", duplicate_rate: "percent" }, source_reference: `Demo quality fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
  }

  async readGovernance(asset, purpose) {
    if (asset.fixture === "denied") return { status: "denied", facts: {}, units: {}, source_reference: `Demo governance fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
    if (asset.fixture === "blocked") return { status: "complete", facts: { approved_purpose: false, hard_stop_code: "GOVERNANCE_HARD_STOP" }, units: {}, source_reference: `Demo governance fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
    if (asset.fixture === "review") return { status: "missing", facts: { approved_purpose: false }, units: {}, source_reference: `Demo governance gap ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
    return { status: "complete", facts: { approved_purpose: true, purpose: purpose || "marketing planning", classification: "internal-demo" }, units: {}, source_reference: `Demo governance fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
  }

  async readLineage(asset) {
    return { status: "complete", facts: { upstream_count: 2, downstream_count: asset.fixture === "review" ? 7 : 4, truncated: false }, units: { upstream_count: "nodes", downstream_count: "nodes" }, source_reference: `Demo lineage fixture ${asset.asset_id}`, observed_at: OBSERVED_AT, fresh_until: FRESH_UNTIL };
  }

  toolDefinition() {
    const database = this;
    return {
      manifest: createToolManifest({ toolId: "database.read", operations: ["read"], inputSchema: { type: "object", additionalProperties: false, properties: { operation: { type: "string", enum: [...operations] }, query: { type: "string", maxLength: 200 }, asset_id: { type: "string", maxLength: 100 }, purpose: { type: "string", maxLength: 120 }, workspace: { type: "string", enum: [this.workspace] } }, required: ["operation"] }, outputSchema, description: "Read-only semantic database fixture operations. No SQL or private rows.", workspace: this.workspace, timeoutMs: 1000, maxCalls: 20 }),
      handler: ({ input }) => database.call(input.operation, input),
    };
  }
}

export function createLocalMcpDatabase(options = {}) {
  return new LocalMcpDatabase(options);
}

export function createLocalDatabaseTool(options = {}) {
  const database = new LocalMcpDatabase(options);
  return { database, ...database.toolDefinition() };
}

export { FIXTURES as LOCAL_DATABASE_FIXTURES, WORKSPACE as LOCAL_DATABASE_WORKSPACE };
