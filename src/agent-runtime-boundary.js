import { TOOL_CALL_PROPOSAL_SCHEMA, TOOL_EXECUTION_RESULT_SCHEMA, LogicContractError, boundedString, hashContract, isRecord, redactValue, rejectUnknownFields } from "./logic-contracts.js";
import { BoundedFunctionOrchestrator } from "./orchestrator.js";

export const AGENT_HOST_CONTRACT = "agent-host-boundary@1";
export const HOST_MODES = Object.freeze(["local_mock", "adk_python", "managed_runtime"]);

export class AgentHostBoundaryError extends LogicContractError {
  constructor(code, message, field = undefined) {
    super(code, message, field);
    this.name = "AgentHostBoundaryError";
  }
}

export function validateHostInvocation(value) {
  rejectUnknownFields(value, new Set(["schema_version", "run_id", "role", "input", "budget", "scope"]), "host invocation");
  if (value.schema_version !== AGENT_HOST_CONTRACT) throw new AgentHostBoundaryError("INVALID_SCHEMA_VERSION", `host invocation schema must be ${AGENT_HOST_CONTRACT}`);
  if (!isRecord(value.input)) throw new AgentHostBoundaryError("INVALID_HOST_INPUT", "host invocation input must be an object");
  return {
    schema_version: AGENT_HOST_CONTRACT,
    run_id: boundedString(value.run_id, "run_id", { min: 1, max: 160, required: true }),
    role: boundedString(value.role, "role", { min: 1, max: 80, required: true }),
    input: redactValue(value.input),
    budget: value.budget ? redactValue(value.budget) : { max_calls: 5, max_total_ms: 10_000 },
    scope: value.scope ? redactValue(value.scope) : { workspace: "Demo Media Workspace" },
  };
}

export class AgentHostBoundary {
  constructor({ mode = "local_mock", orchestrator, adapter = null } = {}) {
    if (!HOST_MODES.includes(mode)) throw new AgentHostBoundaryError("UNKNOWN_HOST_MODE", `Host mode is not supported: ${mode}`);
    if (!(orchestrator instanceof BoundedFunctionOrchestrator)) throw new AgentHostBoundaryError("INVALID_ORCHESTRATOR", "Agent host requires a bounded orchestrator");
    if (mode !== "local_mock" && (!adapter || typeof adapter.propose !== "function")) throw new AgentHostBoundaryError("HOST_ADAPTER_REQUIRED", "A later host must implement propose(input) without owning state");
    this.mode = mode;
    this.orchestrator = orchestrator;
    this.adapter = adapter;
  }

  contract() {
    return {
      schema_version: AGENT_HOST_CONTRACT,
      mode: this.mode,
      state_authority: "application",
      policy_authority: "application",
      tool_authority: "application_allowlist",
      provider_payloads_public: false,
      supported_input: "bounded role input",
      supported_output: TOOL_EXECUTION_RESULT_SCHEMA,
      no_side_effect_mode: true,
    };
  }

  async invoke(value, context = {}) {
    const invocation = validateHostInvocation(value);
    const hostContext = { ...context, run_id: invocation.run_id, scope: invocation.scope, no_side_effect_mode: true };
    let proposal;
    if (this.mode === "local_mock") {
      proposal = await this.adapter?.propose?.({ input: invocation.input, role: invocation.role }) || { schema_version: TOOL_CALL_PROPOSAL_SCHEMA, calls: [] };
    } else {
      proposal = await this.adapter.propose({ input: invocation.input, role: invocation.role, contract: this.contract(), allowed_tools: this.orchestrator.registry.manifests() });
    }
    const result = await this.orchestrator.executeProposal(proposal, hostContext);
    return { ...result, host: { mode: this.mode, contract: AGENT_HOST_CONTRACT, state_authority: "application", proposal_hash: hashContract(proposal) } };
  }
}

export function createLocalAgentHost({ orchestrator, proposalModel = null } = {}) {
  return new AgentHostBoundary({ mode: "local_mock", orchestrator, adapter: proposalModel });
}
