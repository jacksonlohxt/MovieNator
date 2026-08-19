import {
  PartnerError,
  PARTNER_AUTH_MODES,
  PARTNER_DATA_CLASSES,
  PartnerContractError,
  createPartnerCapability,
  partnerProvenance,
  partnerReadiness,
  safePartnerHash,
} from "./partner-contracts.js";

const LIVE_AUTH_MODES = new Set(PARTNER_AUTH_MODES.filter((mode) => !["none", "none_synthetic"].includes(mode)));

/**
 * Provider-neutral shape for a future live read-only partner. The transport is
 * injected by an operator after product, tenant, endpoint, auth, scope, and
 * synthetic dataset decisions are recorded. This class never discovers tools
 * and never constructs a credential or a live URL.
 */
export class CredentialGatedReadOnlyPartnerAdapter {
  constructor({
    provider,
    environment = "staging",
    endpointRef,
    authMode,
    credentialRef,
    scopeRef,
    allowedOperations,
    dataClasses = ["metadata", "governance", "lineage", "search", "quality"],
    manifestHash,
    enabled = false,
    transport = undefined,
    readiness = undefined,
    clock = Date,
  } = {}) {
    if (!provider?.provider_id) throw new PartnerContractError("REQUIRED_FIELD", "provider identity is required", "provider");
    if (!endpointRef) throw new PartnerContractError("REQUIRED_FIELD", "endpointRef is required", "endpoint_ref");
    if (!authMode || !LIVE_AUTH_MODES.has(authMode)) throw new PartnerContractError("AUTH_REQUIRED", "A future live adapter must declare a non-empty authentication mode", "auth_mode");
    this.clock = clock;
    this.transport = transport;
    this.configuredReadiness = readiness;
    this.capability = createPartnerCapability({
      provider: { ...provider, confirmation_state: provider.confirmation_state || "pending" },
      environment,
      endpointRef,
      authMode,
      credentialRef,
      scopeRef,
      allowedOperations,
      dataClasses,
      manifestHash: manifestHash || safePartnerHash(`${provider.provider_id}|pending-read-only-manifest`),
      enabled,
      health: { state: "unknown" },
      limits: { timeout_ms: 8_000, max_attempts: 2, max_response_bytes: 64_000, max_items: 100 },
    });
  }

  capabilities() {
    return this.capability;
  }

  readiness({ now = new Date(this.clock()).toISOString() } = {}) {
    if (typeof this.configuredReadiness === "function") return this.configuredReadiness({ now, capability: this.capability });
    const reasons = [];
    if (this.capability.provider.confirmation_state !== "confirmed") reasons.push("PARTNER_PRODUCT_NOT_CONFIRMED");
    if (!this.capability.scope_ref) reasons.push("TENANT_OR_SCOPE_NOT_SET");
    if (!this.capability.credential_ref) reasons.push("AUTH_REFERENCE_NOT_SET");
    if (!this.transport) reasons.push("TRANSPORT_NOT_CONFIGURED");
    if (this.capability.enabled !== true) reasons.push("PROVIDER_DISABLED");
    if (reasons.includes("AUTH_REFERENCE_NOT_SET")) return partnerReadiness({ capability: this.capability, state: "missing_auth", checkedAt: now, reasonCodes: reasons });
    if (reasons.length) return partnerReadiness({ capability: this.capability, state: "not_configured", checkedAt: now, reasonCodes: reasons });
    return partnerReadiness({ capability: this.capability, state: "ready", checkedAt: now, reasonCodes: [] });
  }

  async invoke(operation, input, context = {}) {
    const readiness = this.readiness();
    if (readiness.state !== "ready") {
      const kind = readiness.state === "missing_auth" ? "missing_auth" : "not_ready";
      throw new PartnerError(kind, "The configured partner seam is not ready for live access", { retryable: false, status: 503 });
    }
    if (typeof this.transport !== "function") throw new PartnerError("not_configured", "No partner transport is configured", { retryable: false });
    // The transport receives only server-validated references and normalized
    // input. It is responsible for resolving credential_ref in a secret store.
    return this.transport({
      endpoint_ref: this.capability.endpoint_ref,
      provider_id: this.capability.provider.provider_id,
      operation,
      tool_ref: this.capability.allowed_operations.find((item) => item.operation === operation)?.tool_ref,
      auth_mode: this.capability.auth_mode,
      credential_ref: this.capability.credential_ref,
      scope_ref: this.capability.scope_ref,
      manifest_hash: this.capability.manifest_hash,
      input,
      signal: context.signal,
    });
  }
}

/**
 * IBM-compatible naming seam without selecting WDI, Flow MCP, or another
 * product. A caller must supply the exact confirmed product reference and
 * register the resulting capability in a private allowlist.
 */
export class IbmCompatibleReadOnlyAdapter extends CredentialGatedReadOnlyPartnerAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: {
        provider_id: options.provider?.provider_id || "partner.ibm.pending",
        display_name: options.provider?.display_name || "IBM-compatible read-only partner seam",
        product_ref: options.provider?.product_ref,
        confirmation_state: options.provider?.confirmation_state || "pending",
      },
    });
  }
}

export const FUTURE_PARTNER_DATA_CLASSES = Object.freeze([...PARTNER_DATA_CLASSES]);
export const FUTURE_LIVE_AUTH_MODES = Object.freeze([...LIVE_AUTH_MODES]);
export function futurePartnerIsCredentialGated(adapter) {
  return adapter instanceof CredentialGatedReadOnlyPartnerAdapter && adapter.capabilities().auth_mode !== "none" && adapter.capabilities().auth_mode !== "none_synthetic";
}

export function createPendingIbmCompatibleAdapter(options = {}) {
  return new IbmCompatibleReadOnlyAdapter({
    ...options,
    enabled: false,
    provider: { ...(options.provider || {}), confirmation_state: "pending" },
  });
}
