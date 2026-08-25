import { GoogleGenAI } from "@google/genai";
import { hashContract, isRecord, boundedString, rejectUnknownFields, LogicContractError } from "./logic-contracts.js";
import { safeProducerPacketProjection } from "./producer-consolidation.js";

export const PRODUCER_AGENT_CONTRACT = "producer-intake-agent@1";
export const PRODUCER_AGENT_TOOL = "producer_packet.read";
export const PRODUCER_AGENT_OPERATION = "inspect_packet";
export const PRODUCER_AGENT_ID = "movieinator.producer-intake";
export const PRODUCER_AGENT_FLOW = "producer_intake_decision_packet";
export const GOOGLE_RUNTIME_PACKAGE = "@google/genai";
export const GOOGLE_RUNTIME_PACKAGE_VERSION = "2.18.0";
export const INTERACTIONS_API_VERSION = "v1beta1";
export const INTERACTIONS_API_REVISION = "2026-05-20";
export const AGENT_RUNTIME_READINESS_SCHEMA = "agent-runtime-readiness@1";
export const AGENT_RUNTIME_MODES = Object.freeze(["local_mock", "managed_interactions"]);

export class ProducerAgentBoundaryError extends LogicContractError {
  constructor(code, message, field = undefined) {
    super(code, message, field);
    this.name = "ProducerAgentBoundaryError";
  }
}

function nowIso(clock) {
  return new clock().toISOString();
}

function safeAgentId(value) {
  const id = boundedString(value, "agent_id", { min: 1, max: 160, required: true });
  if (!/^[a-z][a-z0-9_.-]{1,159}$/.test(id)) {
    throw new ProducerAgentBoundaryError("INVALID_AGENT_ID", "agent_id must be an operator-selected managed agent identifier", "agent_id");
  }
  return id;
}

function safeModelPlaceholders(config = {}) {
  return Object.freeze({
    model_id: config.modelId || null,
    project_id: config.projectId || null,
    region: config.location || null,
  });
}

export function validateProducerAgentRequest(value) {
  rejectUnknownFields(value, new Set(["schema_version", "packet_id"]), "producer agent request");
  if (value.schema_version !== PRODUCER_AGENT_CONTRACT) throw new ProducerAgentBoundaryError("INVALID_SCHEMA_VERSION", `producer agent request schema must be ${PRODUCER_AGENT_CONTRACT}`);
  const packetId = boundedString(value.packet_id, "packet_id", { min: 1, max: 160, required: true });
  if (!/^packet_[a-zA-Z0-9_-]{8,160}$/.test(packetId)) throw new ProducerAgentBoundaryError("INVALID_PACKET_ID", "packet_id is not a valid producer packet identifier", "packet_id");
  return Object.freeze({ schema_version: PRODUCER_AGENT_CONTRACT, packet_id: packetId });
}

function localReadiness({ observedAt = new Date().toISOString() } = {}) {
  return {
    schema_version: AGENT_RUNTIME_READINESS_SCHEMA,
    agent_id: PRODUCER_AGENT_ID,
    flow_id: PRODUCER_AGENT_FLOW,
    mode: "local_mock",
    state: "passed",
    configured: true,
    checked: true,
    passed: true,
    failed: false,
    stale: false,
    no_side_effect_mode: true,
    checked_at: observedAt,
    evidence: {
      check_kind: "local_agent_boundary",
      no_network: true,
      no_credentials: true,
      no_side_effect_mode: true,
      allowlisted_tool: PRODUCER_AGENT_TOOL,
    },
    package: { name: GOOGLE_RUNTIME_PACKAGE, version: GOOGLE_RUNTIME_PACKAGE_VERSION },
    model: safeModelPlaceholders(),
  };
}

function managedReadiness({ runtimeConfig, googleConfig, googleReadiness, agentId, observedAt = new Date().toISOString() } = {}) {
  const google = googleReadiness?.readiness?.() || runtimeConfig?.google || {};
  const configured = Boolean(runtimeConfig?.mode === "deployed_identity" && runtimeConfig?.google?.configured && agentId);
  const checked = Boolean(google.checked);
  const passed = configured && google.state === "passed" && checked && google.passed === true && google.stale !== true;
  const stale = Boolean(google.stale);
  const state = !configured ? "not_set" : stale ? "stale" : google.state === "failed" ? "failed" : passed ? "passed" : "not_run";
  return {
    schema_version: AGENT_RUNTIME_READINESS_SCHEMA,
    agent_id: agentId || null,
    flow_id: PRODUCER_AGENT_FLOW,
    mode: "managed_interactions",
    state,
    configured,
    checked,
    passed,
    failed: state === "failed",
    stale,
    no_side_effect_mode: true,
    checked_at: google.checked_at || null,
    evidence: {
      check_kind: "google_server_readiness_gate",
      google_state: google.state || "not_run",
      operator_check_required: true,
      interaction_api: INTERACTIONS_API_VERSION,
    },
    package: { name: GOOGLE_RUNTIME_PACKAGE, version: GOOGLE_RUNTIME_PACKAGE_VERSION },
    model: safeModelPlaceholders(googleConfig),
  };
}

export function producerAgentReadiness({ mode = "local_mock", runtimeConfig, googleConfig, googleReadiness, agentId, observedAt = new Date().toISOString() } = {}) {
  if (mode === "local_mock") return localReadiness({ observedAt });
  return managedReadiness({ runtimeConfig, googleConfig, googleReadiness, agentId, observedAt });
}

function interactionInput(packetId) {
  return `Inspect the existing MovieInator Producer Intake Decision Packet with packet_id=${packetId}. Use only the preconfigured ${PRODUCER_AGENT_TOOL}/${PRODUCER_AGENT_OPERATION} read-only tool. Return the product safe packet projection. Do not publish, book, approve, spend, browse arbitrary URLs, expose secrets, or mutate records.`;
}

function interactionIdFromEvent(event) {
  const interaction = event?.interaction || event?.data?.interaction;
  const id = typeof interaction?.id === "string" ? interaction.id.trim() : "";
  return id && id.length <= 200 ? id : null;
}

/**
 * Injected transport for the managed Interactions API. It consumes only
 * bounded event metadata and never returns raw provider payloads.
 */
export class GoogleInteractionsTransport {
  constructor({ client, config, agentId, clock = Date } = {}) {
    if (!client || typeof client.interactions?.create !== "function") throw new ProducerAgentBoundaryError("INTERACTIONS_CLIENT_REQUIRED", "Interactions API client is required for managed mode");
    this.client = client;
    this.config = config || {};
    this.agentId = safeAgentId(agentId);
    this.clock = clock;
  }

  async invoke({ packetId }) {
    const stream = await this.client.interactions.create({
      agent: this.agentId,
      input: interactionInput(packetId),
      stream: true,
      background: false,
      store: false,
    });
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") throw new ProducerAgentBoundaryError("INVALID_INTERACTION_STREAM", "Managed agent did not return an interaction stream");
    let eventCount = 0;
    let interactionId = null;
    let serviceStatus = "completed";
    for await (const event of stream) {
      eventCount = Math.min(eventCount + 1, 1000);
      interactionId = interactionId || interactionIdFromEvent(event);
      const status = event?.interaction?.status || event?.data?.interaction?.status;
      if (typeof status === "string" && /^[a-z_]{1,40}$/.test(status)) serviceStatus = status;
    }
    return {
      status: serviceStatus === "completed" ? "succeeded" : "unavailable",
      event_count: eventCount,
      interaction_id_hash: interactionId ? hashContract(interactionId) : null,
      api_version: INTERACTIONS_API_VERSION,
      api_revision: INTERACTIONS_API_REVISION,
      observed_at: nowIso(this.clock),
    };
  }
}

function createManagedClient({ googleConfig }) {
  if (!googleConfig?.projectId || !googleConfig?.location) throw new ProducerAgentBoundaryError("GOOGLE_CONFIGURATION_REQUIRED", "Managed interactions requires server-owned Google project and location");
  return new GoogleGenAI({ vertexai: true, project: googleConfig.projectId, location: googleConfig.location });
}

/**
 * Product-owned execution boundary for the local mock or a future managed
 * Agent Platform agent. It accepts one packet reference and never receives
 * store authority, write operations, arbitrary URLs, or credentials.
 */
export class ProducerAgentBoundary {
  constructor({ store, packetReader, clock = Date, audit, env = process.env, runtimeConfig, googleConfig, googleReadiness, interactionsTransport, genaiClient } = {}) {
    const reader = packetReader || store?.getProducerPacket?.bind(store);
    if (typeof reader !== "function") throw new ProducerAgentBoundaryError("PACKET_READER_REQUIRED", "Producer agent boundary requires a packet reader");
    const requestedMode = typeof env.AGENT_RUNTIME_MODE === "string" && env.AGENT_RUNTIME_MODE.trim() ? env.AGENT_RUNTIME_MODE.trim() : "local_mock";
    if (!AGENT_RUNTIME_MODES.includes(requestedMode)) throw new ProducerAgentBoundaryError("UNKNOWN_AGENT_RUNTIME_MODE", `Agent runtime mode is not supported: ${requestedMode}`);
    let agentId = null;
    if (requestedMode === "managed_interactions") {
      if (runtimeConfig?.mode !== "deployed_identity") throw new ProducerAgentBoundaryError("UNSAFE_AGENT_RUNTIME_MODE", "Managed interactions requires RUNTIME_MODE=deployed_identity and a passed server readiness check");
      agentId = safeAgentId(env.AGENT_RUNTIME_AGENT_ID);
      if (googleConfig?.location !== "global") throw new ProducerAgentBoundaryError("UNSUPPORTED_INTERACTIONS_LOCATION", "Managed interactions currently requires the operator-selected global location");
      const readiness = googleReadiness?.readiness?.() || {};
      if (readiness.state !== "passed" || readiness.checked !== true || readiness.passed !== true || readiness.stale === true) throw new ProducerAgentBoundaryError("AGENT_RUNTIME_NOT_READY", "Managed interactions requires an active operator-side readiness check");
    }
    this.packetReader = reader;
    this.clock = clock;
    this.audit = audit;
    this.mode = requestedMode;
    this.agentId = agentId;
    this.runtimeConfig = runtimeConfig;
    this.googleConfig = googleConfig;
    this.googleReadiness = googleReadiness;
    this.interactionsTransport = interactionsTransport;
    this.genaiClient = genaiClient;
  }

  contract() {
    return {
      schema_version: PRODUCER_AGENT_CONTRACT,
      agent_id: PRODUCER_AGENT_ID,
      flow_id: PRODUCER_AGENT_FLOW,
      runtime_mode: this.mode,
      allowed_tools: [{ name: PRODUCER_AGENT_TOOL, operation: PRODUCER_AGENT_OPERATION, side_effects: false }],
      state_authority: "application",
      policy_authority: "application",
      credentials: "none",
      arbitrary_urls: false,
      publishing: false,
      booking: false,
      approval: false,
      spending: false,
      mutation: false,
      no_side_effect_mode: true,
      package: { name: GOOGLE_RUNTIME_PACKAGE, version: GOOGLE_RUNTIME_PACKAGE_VERSION },
      interaction_api: this.mode === "managed_interactions" ? { version: INTERACTIONS_API_VERSION, revision: INTERACTIONS_API_REVISION, location: "global" } : null,
    };
  }

  readiness() {
    return producerAgentReadiness({ mode: this.mode, runtimeConfig: this.runtimeConfig, googleConfig: this.googleConfig, googleReadiness: this.googleReadiness, agentId: this.agentId });
  }

  async invoke(value) {
    const request = validateProducerAgentRequest(value);
    const observedAt = nowIso(this.clock);
    const requestHash = hashContract(request);
    let result;
    if (this.mode === "local_mock") {
      const packet = await this.packetReader(request.packet_id);
      if (!packet) throw new ProducerAgentBoundaryError("PRODUCER_PACKET_NOT_FOUND", "Producer decision packet not found", "packet_id");
      const projection = safeProducerPacketProjection(packet);
      result = { status: "succeeded", packet: projection, packet_hash: hashContract(projection), transport_used: false };
    } else {
      const transport = this.interactionsTransport || new GoogleInteractionsTransport({ client: this.genaiClient || createManagedClient({ googleConfig: this.googleConfig }), config: this.googleConfig, agentId: this.agentId, clock: this.clock });
      result = await transport.invoke({ packetId: request.packet_id });
    }
    const resultHash = hashContract(result);
    const envelope = {
      schema_version: "producer-agent-result@1",
      status: result.status === "succeeded" ? "succeeded" : "unavailable",
      agent: { agent_id: PRODUCER_AGENT_ID, flow_id: PRODUCER_AGENT_FLOW, contract: PRODUCER_AGENT_CONTRACT },
      tool_call: { name: PRODUCER_AGENT_TOOL, operation: PRODUCER_AGENT_OPERATION },
      request_hash: requestHash,
      result_hash: resultHash,
      observed_at: observedAt,
      package: { name: GOOGLE_RUNTIME_PACKAGE, version: GOOGLE_RUNTIME_PACKAGE_VERSION },
      model: safeModelPlaceholders(this.mode === "managed_interactions" ? this.googleConfig : {}),
      result,
      provenance: {
        mode: this.mode,
        managed_agent_id: this.mode === "managed_interactions" ? this.agentId : null,
        no_credentials: true,
        no_side_effect_mode: true,
        raw_provider_payload: false,
        raw_private_source_stored: false,
        hidden_reasoning_stored: false,
      },
      limitations: [
        "The agent may inspect an existing packet only; it cannot create or change a packet.",
        "The packet is deterministic local evidence or a managed-agent proposal and is not a booking, approval, budget, rights, safety, or publishing decision.",
      ],
    };
    this.audit?.record({
      type: "request_outcome",
      outcome: envelope.status,
      mode: this.mode,
      provenance: { agent_id: PRODUCER_AGENT_ID, flow_id: PRODUCER_AGENT_FLOW, tool_call: PRODUCER_AGENT_TOOL, package: GOOGLE_RUNTIME_PACKAGE, package_version: GOOGLE_RUNTIME_PACKAGE_VERSION },
      attributes: { request_hash: requestHash, result_hash: resultHash, timestamp: observedAt },
    });
    return envelope;
  }
}

export function createProducerAgentBoundary(options = {}) {
  return new ProducerAgentBoundary(options);
}

export function isProducerAgentRequest(value) {
  try {
    validateProducerAgentRequest(value);
    return isRecord(value);
  } catch {
    return false;
  }
}
