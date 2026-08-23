import { TOOL_MANIFEST_SCHEMA, TOOL_EXECUTION_RESULT_SCHEMA, LogicContractError, boundedInteger, boundedString, containsSensitiveKey, containsUnsafeValue, hashContract, isRecord, redactValue, rejectUnknownFields, safeClone, safeUnavailable } from "./logic-contracts.js";
import { LOCAL_MOCK_TOOL_ENDPOINT, PRODUCT_DISPLAY_NAME } from "./product-identity.js";

export class ToolPolicyError extends LogicContractError {
  constructor(code, message, field = undefined) {
    super(code, message, field);
    this.name = "ToolPolicyError";
  }
}

export class ToolExecutionError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

const MANIFEST_FIELDS = new Set([
  "schema_version", "tool_id", "version", "description", "kind", "capabilities", "operations", "endpoint", "credentials", "permissions", "scope", "input_schema", "output_schema", "timeout_ms", "budget", "side_effects", "redaction", "provenance",
]);
const SCHEMA_FIELDS = new Set(["type", "additionalProperties", "properties", "required", "items", "enum", "minLength", "maxLength", "minimum", "maximum"]);
const TOOL_KINDS = new Set(["database", "fixture", "function"]);
const REDACTION_MODES = new Set(["normalized", "public", "none"]);
const ENDPOINT_KINDS = new Set(["local", "in_process"]);

function validateSchema(schema, field = "schema", depth = 0) {
  if (!isRecord(schema) || depth > 5) throw new ToolPolicyError("INVALID_SCHEMA", `${field} must be a bounded JSON schema`);
  rejectUnknownFields(schema, SCHEMA_FIELDS, field);
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.type is not supported`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new ToolPolicyError("INVALID_SCHEMA", `${field}.additionalProperties must be boolean`);
  if (schema.type === "object") {
    if (!isRecord(schema.properties)) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.properties is required`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.properties contains an unsafe key`);
      validateSchema(child, `${field}.properties.${key}`, depth + 1);
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key)))) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.required is invalid`);
  }
  if (schema.type === "array" && schema.items) validateSchema(schema.items, `${field}.items`, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 30)) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.enum is invalid`);
  for (const key of ["minLength", "maxLength", "minimum", "maximum"]) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1_000_000)) throw new ToolPolicyError("INVALID_SCHEMA", `${field}.${key} is invalid`);
  if (schema.maxLength !== undefined && schema.minLength !== undefined && schema.maxLength < schema.minLength) throw new ToolPolicyError("INVALID_SCHEMA", `${field} length bounds are invalid`);
  return schema;
}

export function validateJsonSchema(value, schema, field = "value", depth = 0) {
  if (!schema || depth > 8) return;
  const type = schema.type;
  const valid = type === "object" ? isRecord(value) : type === "array" ? Array.isArray(value) : type === "string" ? typeof value === "string" : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "integer" ? Number.isSafeInteger(value) : type === "boolean" ? typeof value === "boolean" : type === "null" ? value === null : false;
  if (!valid) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} does not match the tool schema`, field);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} is not an allowed value`, field);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} is too short`, field);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} is too long`, field);
  }
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} is outside the allowed range`, field);
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} has too many items`, field);
    for (let index = 0; index < value.length; index += 1) validateJsonSchema(value[index], schema.items, `${field}[${index}]`, depth + 1);
  }
  if (isRecord(value)) {
    const properties = schema.properties || {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field} contains an unknown field`, field);
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) throw new ToolPolicyError("INVALID_TOOL_INPUT", `${field}.${required} is required`, required);
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key)) validateJsonSchema(value[key], child, `${field}.${key}`, depth + 1);
  }
}

export function validateToolManifest(value) {
  rejectUnknownFields(value, MANIFEST_FIELDS, "tool manifest");
  if (value.schema_version !== TOOL_MANIFEST_SCHEMA) throw new ToolPolicyError("INVALID_SCHEMA_VERSION", `tool manifest schema must be ${TOOL_MANIFEST_SCHEMA}`);
  const tool_id = boundedString(value.tool_id, "tool_id", { min: 1, max: 120, required: true });
  if (!/^[a-z][a-z0-9_.-]{1,119}$/.test(tool_id)) throw new ToolPolicyError("INVALID_TOOL_ID", "tool_id must be a stable allowlist identifier");
  const kind = boundedString(value.kind, "kind", { min: 1, max: 32, required: true });
  if (!TOOL_KINDS.has(kind)) throw new ToolPolicyError("INVALID_TOOL_KIND", `Unsupported tool kind: ${kind}`);
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities.map((item) => boundedString(item, "capabilities", { min: 1, max: 50, required: true })) : [];
  const operations = Array.isArray(value.operations) ? value.operations.map((item) => boundedString(item, "operations", { min: 1, max: 80, required: true })) : [];
  if (!capabilities.length || !operations.length || new Set(operations).size !== operations.length) throw new ToolPolicyError("INVALID_TOOL_MANIFEST", "tool capabilities and operations must be non-empty and unique");
  if (!isRecord(value.endpoint) || !ENDPOINT_KINDS.has(value.endpoint.kind) || typeof value.endpoint.id !== "string" || !/^local:[a-z0-9_.-]{2,120}$/.test(value.endpoint.id)) throw new ToolPolicyError("INVALID_ENDPOINT", "only registered local endpoints are allowed");
  rejectUnknownFields(value.endpoint, new Set(["kind", "id"]), "tool manifest endpoint");
  if (value.credentials !== "none") throw new ToolPolicyError("CREDENTIALS_NOT_ALLOWED", "local MVP tools cannot declare credentials");
  const permissions = Array.isArray(value.permissions) ? value.permissions.map((item) => boundedString(item, "permissions", { min: 1, max: 80, required: true })) : [];
  if (!permissions.length || permissions.some((item) => item.includes("write") || item.includes("admin") || item.includes("publish"))) throw new ToolPolicyError("INVALID_PERMISSION", "only bounded read permissions are allowed");
  if (!isRecord(value.scope) || typeof value.scope.workspace !== "string" || value.scope.workspace.length < 1 || value.scope.workspace.length > 120) throw new ToolPolicyError("INVALID_SCOPE", "tool scope must name one bounded workspace");
  validateSchema(value.input_schema, "input_schema");
  validateSchema(value.output_schema, "output_schema");
  const timeout_ms = boundedInteger(value.timeout_ms, "timeout_ms", { min: 1, max: 30_000, required: true });
  if (!isRecord(value.budget)) throw new ToolPolicyError("INVALID_BUDGET", "tool budget is required");
  const budget = { max_calls: boundedInteger(value.budget.max_calls, "budget.max_calls", { min: 1, max: 100, required: true }), max_input_bytes: boundedInteger(value.budget.max_input_bytes, "budget.max_input_bytes", { min: 1, max: 100_000, required: true }), max_output_bytes: boundedInteger(value.budget.max_output_bytes, "budget.max_output_bytes", { min: 1, max: 200_000, required: true }) };
  const redaction = boundedString(value.redaction, "redaction", { min: 1, max: 32, required: true });
  if (!REDACTION_MODES.has(redaction) || redaction === "none") throw new ToolPolicyError("REDACTION_REQUIRED", "tools must use a redacting output mode");
  if (value.side_effects !== false) throw new ToolPolicyError("SIDE_EFFECTS_NOT_ALLOWED", "local MVP tools must declare side_effects false");
  if (!isRecord(value.provenance) || typeof value.provenance.source !== "string" || typeof value.provenance.manifest_hash !== "string") throw new ToolPolicyError("INVALID_PROVENANCE", "tool provenance must include source and manifest_hash");
  return {
    schema_version: TOOL_MANIFEST_SCHEMA,
    tool_id,
    version: boundedString(value.version, "version", { min: 1, max: 40, required: true }),
    description: boundedString(value.description, "description", { min: 1, max: 300, required: true }),
    kind,
    capabilities,
    operations,
    endpoint: { kind: value.endpoint.kind, id: value.endpoint.id },
    credentials: "none",
    permissions,
    scope: { workspace: boundedString(value.scope.workspace, "scope.workspace", { min: 1, max: 120, required: true }) },
    input_schema: value.input_schema,
    output_schema: value.output_schema,
    timeout_ms,
    budget,
    side_effects: false,
    redaction,
    provenance: { source: boundedString(value.provenance.source, "provenance.source", { min: 1, max: 120, required: true }), manifest_hash: boundedString(value.provenance.manifest_hash, "provenance.manifest_hash", { min: 1, max: 160, required: true }) },
  };
}

function safeManifest(manifest) {
  return { schema_version: manifest.schema_version, tool_id: manifest.tool_id, version: manifest.version, description: manifest.description, kind: manifest.kind, capabilities: manifest.capabilities, operations: manifest.operations, endpoint: manifest.endpoint, credentials: manifest.credentials, permissions: manifest.permissions, scope: manifest.scope, timeout_ms: manifest.timeout_ms, budget: manifest.budget, side_effects: manifest.side_effects, redaction: manifest.redaction, provenance: manifest.provenance };
}

function timeoutPromise(promise, milliseconds, onTimeout) {
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ToolExecutionError("TOOL_TIMEOUT", "Tool execution exceeded its bounded timeout", { retryable: true }));
    }, milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class ToolRegistry {
  #tools = new Map();

  constructor({ maxBudgetScopes = 1000 } = {}) {
    if (!Number.isSafeInteger(maxBudgetScopes) || maxBudgetScopes < 1 || maxBudgetScopes > 100_000) throw new ToolPolicyError("INVALID_BUDGET_SCOPE_LIMIT", "maxBudgetScopes must be between 1 and 100000");
    this.maxBudgetScopes = maxBudgetScopes;
  }

  register({ manifest, handler }) {
    const normalized = validateToolManifest(manifest);
    if (this.#tools.has(normalized.tool_id)) throw new ToolPolicyError("DUPLICATE_TOOL", `Tool is already registered: ${normalized.tool_id}`);
    if (typeof handler !== "function") throw new ToolPolicyError("INVALID_TOOL_HANDLER", "Tool handler must be a function");
    this.#tools.set(normalized.tool_id, { manifest: normalized, handler, calls: new Map() });
    return safeManifest(normalized);
  }

  has(toolId) {
    return this.#tools.has(toolId);
  }

  get(toolId) {
    const entry = this.#tools.get(toolId);
    if (!entry) throw new ToolPolicyError("UNKNOWN_TOOL", `Tool is not allowlisted: ${toolId}`);
    return entry;
  }

  manifests() {
    return [...this.#tools.values()].map((entry) => safeManifest(entry.manifest));
  }

  readiness() {
    return {
      schema_version: "tool-readiness@1",
      mode: "local-mock",
      no_side_effect_mode: true,
      tools: this.manifests().map((manifest) => ({ tool_id: manifest.tool_id, state: "ready", operations: manifest.operations, scope: manifest.scope, endpoint: manifest.endpoint, credentials: "none", side_effects: false, manifest_hash: manifest.provenance.manifest_hash })),
      unavailable: [],
    };
  }

  authorize({ toolId, operation, input, context = {} }) {
    const entry = this.get(toolId);
    const manifest = entry.manifest;
    if (!manifest.operations.includes(operation)) throw new ToolPolicyError("UNKNOWN_OPERATION", `Operation is not allowlisted for ${toolId}: ${operation}`, "operation");
    if (context.endpoint && context.endpoint !== manifest.endpoint.id) throw new ToolPolicyError("ENDPOINT_NOT_ALLOWED", "Requested endpoint is not the registered local endpoint", "endpoint");
    if (context.credentials && context.credentials !== "none") throw new ToolPolicyError("CREDENTIALS_NOT_ALLOWED", "Credentials are not accepted by the local tool boundary", "credentials");
    if (context.no_side_effect_mode !== false && manifest.side_effects) throw new ToolPolicyError("SIDE_EFFECTS_NOT_ALLOWED", "The active mode rejects side-effect tools");
    const permissions = new Set(context.permissions || manifest.permissions);
    for (const permission of manifest.permissions) if (!permissions.has(permission)) throw new ToolPolicyError("PERMISSION_DENIED", `Permission is not present for ${toolId}: ${permission}`);
    if (context.scope?.workspace && context.scope.workspace !== manifest.scope.workspace) throw new ToolPolicyError("SCOPE_DENIED", "Tool scope does not match the run scope");
    if (containsSensitiveKey(input) || containsUnsafeValue(input)) throw new ToolPolicyError("UNSAFE_TOOL_INPUT", "Tool input contains credentials, private fields, or unsafe text");
    validateJsonSchema(input, manifest.input_schema, "tool input");
    return { tool_id: manifest.tool_id, operation, manifest: safeManifest(manifest), input_hash: hashContract(input) };
  }

  async execute({ toolId, operation, input, context = {}, signal, timeoutMs } = {}) {
    const authorization = this.authorize({ toolId, operation, input, context });
    const entry = this.get(toolId);
    const budgetScope = typeof context.run_id === "string" && context.run_id ? context.run_id : "local-run";
    const calls = entry.calls.get(budgetScope) || 0;
    if (calls >= entry.manifest.budget.max_calls) return { ...safeUnavailable("TOOL_BUDGET_EXHAUSTED", "Tool call budget is exhausted", { retryable: false, tool_id: toolId, operation }), outcome: "budget_exhausted" };
    if (signal?.aborted) return { ...safeUnavailable("RUN_CANCELED", "Tool call was canceled before execution", { retryable: false, tool_id: toolId, operation }), outcome: "canceled" };
    if (!entry.calls.has(budgetScope) && entry.calls.size >= this.maxBudgetScopes) entry.calls.delete(entry.calls.keys().next().value);
    entry.calls.delete(budgetScope);
    entry.calls.set(budgetScope, calls + 1);
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    if (inputBytes > entry.manifest.budget.max_input_bytes) throw new ToolPolicyError("TOOL_INPUT_BUDGET", "Tool input exceeds its byte budget");
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(entry.manifest.timeout_ms, Math.floor(timeoutMs))) : entry.manifest.timeout_ms;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const output = await timeoutPromise(Promise.resolve().then(() => entry.handler({ operation, input: safeClone(input), context: { scope: entry.manifest.scope, permissions: entry.manifest.permissions, no_side_effect_mode: true }, signal: controller.signal })), effectiveTimeoutMs, () => controller.abort());
      if (output === undefined || output === null || !isRecord(output)) throw new ToolExecutionError("INVALID_TOOL_OUTPUT", "Tool returned an invalid output", { retryable: false });
      const outputBytes = Buffer.byteLength(JSON.stringify(output));
      if (outputBytes > entry.manifest.budget.max_output_bytes) throw new ToolExecutionError("TOOL_OUTPUT_BUDGET", "Tool output exceeds its byte budget", { retryable: false });
      const safeOutput = redactValue(output);
      if (containsSensitiveKey(safeOutput) || containsUnsafeValue(safeOutput)) throw new ToolExecutionError("UNSAFE_TOOL_OUTPUT", "Tool output failed redaction checks", { retryable: false });
      validateJsonSchema(safeOutput, entry.manifest.output_schema, "tool output");
      return { schema_version: TOOL_EXECUTION_RESULT_SCHEMA, status: "succeeded", outcome: "succeeded", tool_id: toolId, operation, input_hash: authorization.input_hash, output: safeOutput, output_hash: hashContract(safeOutput), provenance: { ...entry.manifest.provenance, redaction: entry.manifest.redaction } };
    } catch (error) {
      if (error instanceof ToolPolicyError) throw error;
      const code = error.code || "TOOL_UNAVAILABLE";
      const retryable = error.retryable !== false && ["TOOL_TIMEOUT", "TOOL_UNAVAILABLE", "ECONNRESET"].includes(code);
      return { ...safeUnavailable(code, "The allowlisted local tool is unavailable", { retryable, tool_id: toolId, operation }), input_hash: authorization.input_hash };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  resetBudgets(runId) {
    for (const entry of this.#tools.values()) {
      if (runId) entry.calls.delete(runId);
      else entry.calls.clear();
    }
  }

  retireRun(runId) {
    this.resetBudgets(runId);
  }
}

export function createToolManifest({ toolId, operations, inputSchema, outputSchema, description = "Bounded local read-only tool", capabilities = ["read"], workspace = "Demo Media Workspace", timeoutMs = 1000, maxCalls = 20 } = {}) {
  return {
    schema_version: "tool-manifest@1",
    tool_id: toolId,
    version: "local-mock@1",
    description,
    kind: "database",
    capabilities,
    operations,
    endpoint: { kind: "local", id: LOCAL_MOCK_TOOL_ENDPOINT },
    credentials: "none",
    permissions: ["database.read"],
    scope: { workspace },
    input_schema: inputSchema,
    output_schema: outputSchema,
    timeout_ms: timeoutMs,
    budget: { max_calls: maxCalls, max_input_bytes: 12000, max_output_bytes: 60000 },
    side_effects: false,
    redaction: "normalized",
    provenance: { source: `${PRODUCT_DISPLAY_NAME} local deterministic fixture`, manifest_hash: hashContract({ toolId, operations, workspace }) },
  };
}
