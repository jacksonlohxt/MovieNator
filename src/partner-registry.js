import {
  PartnerContractError,
  assertReadOnlyOperation,
  partnerReadiness,
  parsePartnerCapability,
  safePartnerProjection,
} from "./partner-contracts.js";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeOperation(value) {
  return typeof value === "string" ? value : value?.operation;
}

/**
 * Server-owned registry for partner seams. Registration is the only way a
 * provider or endpoint can become addressable. invoke() performs every check
 * before calling adapter.invoke(), so unknown input cannot reach transport.
 */
export class PartnerRegistry {
  constructor({ endpointAllowlist = ["local://movie-inator/mock"], clock = Date } = {}) {
    this.clock = clock;
    this.endpointAllowlist = new Set(endpointAllowlist);
    this.providers = new Map();
  }

  register({ capability, adapter, enabled = undefined } = {}) {
    const parsed = parsePartnerCapability({ ...capability, ...(enabled === undefined ? {} : { enabled }) });
    if (this.providers.has(parsed.provider.provider_id)) throw new PartnerContractError("DUPLICATE_PROVIDER", `Provider is already registered: ${parsed.provider.provider_id}`, "provider.provider_id");
    if (!this.endpointAllowlist.has(parsed.endpoint_ref)) throw new PartnerContractError("ENDPOINT_NOT_ALLOWLISTED", `Endpoint reference is not explicitly allowlisted: ${parsed.endpoint_ref}`, "endpoint_ref");
    if (!adapter || typeof adapter.invoke !== "function") throw new PartnerContractError("INVALID_ADAPTER", "A registered adapter must expose invoke", "adapter");
    if (typeof adapter.capabilities === "function") {
      const adapterCapability = adapter.capabilities();
      if (adapterCapability?.provider?.provider_id && adapterCapability.provider.provider_id !== parsed.provider.provider_id) throw new PartnerContractError("ADAPTER_PROVIDER_MISMATCH", "Adapter provider identity does not match its registry capability");
      if (adapterCapability?.endpoint_ref && adapterCapability.endpoint_ref !== parsed.endpoint_ref) throw new PartnerContractError("ADAPTER_ENDPOINT_MISMATCH", "Adapter endpoint reference does not match its registry capability");
      if (adapterCapability?.manifest_hash && adapterCapability.manifest_hash !== parsed.manifest_hash) throw new PartnerContractError("ADAPTER_MANIFEST_MISMATCH", "Adapter manifest hash does not match its registry capability");
    }
    this.providers.set(parsed.provider.provider_id, { capability: parsed, adapter, registered_at: new Date(this.clock()).toISOString() });
    return clone(parsed);
  }

  unregister(providerId) {
    this.providers.delete(providerId);
  }

  has(providerId) {
    return this.providers.has(providerId);
  }

  get(providerId) {
    const entry = this.providers.get(providerId);
    if (!entry) throw new PartnerContractError("UNKNOWN_PROVIDER", `Partner provider is not registered: ${String(providerId)}`, "provider_id");
    return entry;
  }

  list() {
    return [...this.providers.values()].map((entry) => clone(entry.capability));
  }

  getCapability(providerId) {
    return clone(this.get(providerId).capability);
  }

  assertEndpoint(providerId, endpointRef) {
    const { capability } = this.get(providerId);
    if (endpointRef !== capability.endpoint_ref || !this.endpointAllowlist.has(endpointRef)) throw new PartnerContractError("ENDPOINT_NOT_ALLOWLISTED", "Partner endpoint reference is not the registered endpoint", "endpoint_ref");
    return capability.endpoint_ref;
  }

  assertOperation(providerId, operation, { endpointRef = undefined, toolRef = undefined } = {}) {
    const entry = this.get(providerId);
    const capability = entry.capability;
    assertReadOnlyOperation(operation);
    // Disabled providers remain addressable for a safe readiness projection. The
    // adapter must fail closed before any transport call when disabled or
    // missing auth; unknown providers and operations still reject here.
    this.assertEndpoint(providerId, endpointRef || capability.endpoint_ref);
    const allowed = capability.allowed_operations.find((item) => normalizeOperation(item) === operation);
    if (!allowed) throw new PartnerContractError("UNKNOWN_CAPABILITY", `Partner capability is not registered: ${operation}`, "operation");
    if (allowed.read_only !== true) throw new PartnerContractError("MUTATING_OPERATION", `Partner capability is not read-only: ${operation}`, "operation");
    if (toolRef !== undefined && allowed.tool_ref !== toolRef) throw new PartnerContractError("UNKNOWN_TOOL", "Partner tool is not the registered tool for this operation", "tool_ref");
    return { entry, capability, operation: allowed };
  }

  /** Invoke only a registered semantic operation. No dynamic tool lookup exists. */
  async invoke(providerId, operation, input = {}, context = {}) {
    const { entry, capability } = this.assertOperation(providerId, operation, context);
    return entry.adapter.invoke(operation, input, {
      ...context,
      provider_id: capability.provider.provider_id,
      endpoint_ref: capability.endpoint_ref,
      manifest_hash: capability.manifest_hash,
      operation: operation,
    });
  }

  readiness(providerId, { maxAgeMs = 30_000, circuit = undefined } = {}) {
    const entry = this.get(providerId);
    const capability = entry.capability;
    let result;
    if (typeof entry.adapter.readiness === "function") {
      result = entry.adapter.readiness({ now: new Date(this.clock()).toISOString(), maxAgeMs });
    }
    if (!result || typeof result !== "object") result = partnerReadiness({ capability, state: "unknown" });
    const checkedAt = result.checked_at ? Date.parse(result.checked_at) : NaN;
    if (result.state === "ready" && Number.isFinite(checkedAt) && clockTime(this.clock) - checkedAt > maxAgeMs) {
      result = partnerReadiness({ capability, state: "stale", checkedAt: result.checked_at, reasonCodes: ["READINESS_CHECK_STALE"], circuit });
    }
    if (circuit?.state === "open") result = partnerReadiness({ capability, state: "circuit_open", checkedAt: result.checked_at, reasonCodes: ["CIRCUIT_OPEN"], circuit });
    return clone(result);
  }

  projection(providerId, options = {}) {
    const entry = this.get(providerId);
    return safePartnerProjection({ capability: entry.capability, readiness: this.readiness(providerId, options) });
  }

  projections(options = {}) {
    return [...this.providers.keys()].map((providerId) => this.projection(providerId, options));
  }
}

function clockTime(clock) {
  try {
    return new clock().getTime();
  } catch {
    return Date.now();
  }
}

export function assertRegisteredReadOnlyOperation(registry, providerId, operation, options = {}) {
  if (!(registry instanceof PartnerRegistry)) throw new PartnerContractError("INVALID_REGISTRY", "A PartnerRegistry is required");
  return registry.assertOperation(providerId, operation, options);
}
