import { TOOL_CALL_PROPOSAL_SCHEMA, TOOL_EXECUTION_RESULT_SCHEMA, LogicContractError, boundedInteger, boundedString, containsSensitiveKey, containsUnsafeValue, hashContract, isRecord, redactValue, rejectUnknownFields, safeUnavailable } from "./logic-contracts.js";
import { ToolPolicyError, ToolRegistry } from "./tool-registry.js";
import { createLocalDatabaseTool } from "./mcp-database.js";

const PROPOSAL_FIELDS = new Set(["schema_version", "calls"]);
const CALL_FIELDS = new Set(["call_id", "tool_id", "operation", "arguments"]);

export class OrchestrationPolicyError extends LogicContractError {
  constructor(code, message, field = undefined) {
    super(code, message, field);
    this.name = "OrchestrationPolicyError";
  }
}

export function validateToolCallProposal(value, { maxCalls = 5 } = {}) {
  rejectUnknownFields(value, PROPOSAL_FIELDS, "tool call proposal");
  if (value.schema_version !== TOOL_CALL_PROPOSAL_SCHEMA) throw new OrchestrationPolicyError("INVALID_SCHEMA_VERSION", `tool call proposal schema must be ${TOOL_CALL_PROPOSAL_SCHEMA}`);
  if (!Array.isArray(value.calls) || value.calls.length > maxCalls) throw new OrchestrationPolicyError("CALL_BUDGET_EXCEEDED", `proposal may contain at most ${maxCalls} calls`, "calls");
  const ids = new Set();
  return {
    schema_version: TOOL_CALL_PROPOSAL_SCHEMA,
    calls: value.calls.map((call, index) => {
      rejectUnknownFields(call, CALL_FIELDS, `tool call ${index}`);
      const normalized = {
        call_id: boundedString(call.call_id, `calls[${index}].call_id`, { min: 1, max: 100, required: true }),
        tool_id: boundedString(call.tool_id, `calls[${index}].tool_id`, { min: 1, max: 120, required: true }),
        operation: boundedString(call.operation, `calls[${index}].operation`, { min: 1, max: 80, required: true }),
        arguments: call.arguments === undefined ? {} : call.arguments,
      };
      if (!/^[a-z][a-z0-9_.-]{1,99}$/.test(normalized.call_id)) throw new OrchestrationPolicyError("INVALID_CALL_ID", "call_id must be a stable bounded identifier");
      if (ids.has(normalized.call_id)) throw new OrchestrationPolicyError("DUPLICATE_CALL_ID", `Duplicate call_id: ${normalized.call_id}`);
      ids.add(normalized.call_id);
      if (!isRecord(normalized.arguments) || containsSensitiveKey(normalized.arguments) || containsUnsafeValue(normalized.arguments)) throw new OrchestrationPolicyError("UNSAFE_TOOL_INPUT", `Call ${normalized.call_id} has unsafe arguments`, `calls[${index}].arguments`);
      return normalized;
    }),
  };
}

function proposalFromModel(modelOutput) {
  if (modelOutput && modelOutput.schema_version === TOOL_CALL_PROPOSAL_SCHEMA) return modelOutput;
  if (Array.isArray(modelOutput)) return { schema_version: TOOL_CALL_PROPOSAL_SCHEMA, calls: modelOutput };
  if (isRecord(modelOutput) && Array.isArray(modelOutput.calls)) return { schema_version: TOOL_CALL_PROPOSAL_SCHEMA, calls: modelOutput.calls };
  throw new OrchestrationPolicyError("INVALID_MODEL_PROPOSAL", "Model output was not a tool call proposal");
}

function safeToolContext(context = {}) {
  if (context.no_side_effect_mode === false) throw new OrchestrationPolicyError("NO_SIDE_EFFECT_MODE_REQUIRED", "The local logic host always runs in no-side-effect mode");
  const permissions = Array.isArray(context.permissions) ? [...new Set(context.permissions)].filter((item) => typeof item === "string" && item.length < 80) : ["database.read"];
  return {
    run_id: boundedString(context.run_id || "local-run", "context.run_id", { min: 1, max: 160 }),
    scope: { workspace: boundedString(context.scope?.workspace || "Demo Media Workspace", "context.scope.workspace", { min: 1, max: 120 }) },
    permissions,
    endpoint: context.endpoint,
    credentials: context.credentials || "none",
    no_side_effect_mode: context.no_side_effect_mode !== false,
  };
}

export class BoundedFunctionOrchestrator {
  constructor({ registry, model = null, maxCalls = 5, maxTotalMs = 10_000, clock = Date } = {}) {
    if (!registry) throw new Error("BoundedFunctionOrchestrator requires a ToolRegistry");
    this.registry = registry;
    this.model = model;
    this.maxCalls = Math.max(1, Math.min(20, maxCalls));
    this.maxTotalMs = Math.max(1, Math.min(60_000, maxTotalMs));
    this.clock = clock;
    this.completed = new Map();
  }

  validateProposal(modelOutput, context = {}) {
    const proposal = validateToolCallProposal(proposalFromModel(modelOutput), { maxCalls: this.maxCalls });
    const safeContext = safeToolContext(context);
    const authorized = proposal.calls.map((call) => ({ call, authorization: this.registry.authorize({ toolId: call.tool_id, operation: call.operation, input: call.arguments, context: safeContext }) }));
    return { proposal, context: safeContext, authorized };
  }

  async executeProposal(modelOutput, context = {}) {
    const startedAt = this.clock.now();
    let checked;
    try {
      checked = this.validateProposal(modelOutput, context);
    } catch (error) {
      if (error instanceof ToolPolicyError || error instanceof OrchestrationPolicyError || error instanceof LogicContractError) throw error;
      throw new OrchestrationPolicyError("PROPOSAL_REJECTED", "Tool proposal was rejected by deterministic policy");
    }
    const results = [];
    let status = "succeeded";
    for (const { call } of checked.authorized) {
      if (this.clock.now() - startedAt >= this.maxTotalMs) {
        results.push({ call_id: call.call_id, ...safeUnavailable("ORCHESTRATION_BUDGET_EXHAUSTED", "Orchestration time budget is exhausted", { retryable: false, tool_id: call.tool_id, operation: call.operation }) });
        status = "unavailable";
        continue;
      }
      const key = `${checked.context.run_id}:${call.call_id}:${hashContract(call.arguments)}`;
      if (this.completed.has(key)) {
        results.push({ call_id: call.call_id, duplicate: true, ...this.completed.get(key) });
        continue;
      }
      const result = await this.registry.execute({ toolId: call.tool_id, operation: call.operation, input: call.arguments, context: checked.context });
      const boundedResult = { call_id: call.call_id, ...redactValue(result) };
      this.completed.set(key, boundedResult);
      results.push(boundedResult);
      if (result.status !== "succeeded") status = "unavailable";
    }
    const usage = { call_count: results.filter((result) => result.duplicate !== true).length, max_calls: this.maxCalls, elapsed_ms: Math.max(0, this.clock.now() - startedAt), max_total_ms: this.maxTotalMs };
    return { schema_version: TOOL_EXECUTION_RESULT_SCHEMA, status, outcome: status, results, usage, provenance: { proposal_hash: hashContract(checked.proposal), mode: "local-mock", no_side_effect_mode: true } };
  }

  async run(input, { model = this.model, context = {} } = {}) {
    if (!model || typeof model.propose !== "function") return safeUnavailable("MODEL_UNAVAILABLE", "No proposal model is configured", { retryable: false });
    let proposal;
    try {
      proposal = await model.propose({ input: redactValue(input), allowed_tools: this.registry.manifests().map((manifest) => ({ tool_id: manifest.tool_id, operations: manifest.operations, input_schema: manifest.input_schema })) });
    } catch {
      return safeUnavailable("MODEL_UNAVAILABLE", "The proposal model is unavailable", { retryable: true });
    }
    try {
      return await this.executeProposal(proposal, context);
    } catch (error) {
      if (error instanceof ToolPolicyError || error instanceof OrchestrationPolicyError || error instanceof LogicContractError) {
        return { schema_version: TOOL_EXECUTION_RESULT_SCHEMA, status: "rejected", outcome: "rejected", error: { code: error.code, message: error.message.slice(0, 240), retryable: false }, provenance: { mode: "local-mock", no_side_effect_mode: true } };
      }
      return safeUnavailable("ORCHESTRATION_UNAVAILABLE", "The bounded tool orchestration was unavailable", { retryable: true });
    }
  }
}

export function createDefaultToolRegistry({ database } = {}) {
  const registryModule = createLocalDatabaseTool({ ...(database ? { fixtures: database.fixtures, workspace: database.workspace } : {}) });
  const registry = new ToolRegistry();
  registry.register(registryModule);
  return registry;
}
