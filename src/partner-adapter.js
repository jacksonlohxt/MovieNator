import {
  PartnerError,
  PARTNER_AUTH_MODES,
  PARTNER_DATA_CLASSES,
  PARTNER_READINESS_STATES,
  PartnerContractError,
  assertReadOnlyOperation,
  createPartnerCapability,
  normalizePartnerInput,
  partnerProvenance,
  partnerReadiness,
  safePartnerHash,
} from "./partner-contracts.js";
import { isSecretReference } from "./secrets.js";

const LIVE_AUTH_MODES = new Set(PARTNER_AUTH_MODES.filter((mode) => !["none", "none_synthetic"].includes(mode)));
const SECRET_FAILURE_CODES = new Set([
  "INVALID_SECRET_REFERENCE",
  "SECRET_NOT_FOUND",
  "SECRET_NOT_CONFIGURED",
  "SECRET_AUTH_UNAVAILABLE",
  "SECRET_ACCESS_DENIED",
  "SECRET_RESPONSE_INVALID",
]);

function safeInjectedCodes(value, fallback) {
  const codes = Array.isArray(value) ? value : fallback;
  return [...new Set(codes.map((code) => String(code).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80)).filter(Boolean))].slice(0, 12);
}

function safeInjectedTime(value, fallback) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function readinessFromInjectedCheck(result, capability, now) {
  if (result === true) return partnerReadiness({ capability, state: "ready", checkedAt: now, reasonCodes: [] });
  if (result === false || !result || typeof result !== "object") {
    return partnerReadiness({ capability, state: "unavailable", checkedAt: now, reasonCodes: ["INJECTED_READINESS_FAILED"] });
  }
  const state = PARTNER_READINESS_STATES.includes(result.state) ? result.state : "unknown";
  const reasonCodes = safeInjectedCodes(result.reason_codes, state === "ready" ? [] : ["INJECTED_READINESS_FAILED"]);
  const errorClass = typeof result.error_class === "string" ? result.error_class.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) : undefined;
  return partnerReadiness({
    capability,
    state,
    checkedAt: safeInjectedTime(result.checked_at, now),
    reasonCodes,
    circuit: result.circuit,
    errorClass,
  });
}

function secretReferenceIsValid(reference, secretProvider) {
  if (!reference) return false;
  if (secretProvider && typeof secretProvider.validateReference === "function") {
    try {
      return secretProvider.validateReference(reference) !== false;
    } catch {
      return false;
    }
  }
  // A custom provider may support an opaque reference scheme. The built-in
  // Secret Manager provider validates the canonical resource name above.
  return isSecretReference(reference) || /^(?:local|config|secret):\/\/[A-Za-z0-9._~:\/-]+$/.test(reference);
}

function secretFailure(error) {
  const code = error?.code || error?.kind;
  if (SECRET_FAILURE_CODES.has(code)) return new PartnerError("missing_auth", "The configured partner credential is unavailable", { retryable: false, status: 503, cause: error });
  return new PartnerError("unavailable", "The configured partner credential could not be checked", { retryable: true, status: 503, cause: error });
}

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
    secretProvider = undefined,
    readiness = undefined,
    readinessCheck = undefined,
    limits = undefined,
    clock = Date,
  } = {}) {
    if (!provider?.provider_id) throw new PartnerContractError("REQUIRED_FIELD", "provider identity is required", "provider");
    if (!endpointRef) throw new PartnerContractError("REQUIRED_FIELD", "endpointRef is required", "endpoint_ref");
    if (!authMode || !LIVE_AUTH_MODES.has(authMode)) throw new PartnerContractError("AUTH_REQUIRED", "A future live adapter must declare a non-empty authentication mode", "auth_mode");
    if (transport !== undefined && typeof transport !== "function") throw new PartnerContractError("INVALID_TRANSPORT", "Partner transport must be a function", "transport");
    if (readiness !== undefined && typeof readiness !== "function") throw new PartnerContractError("INVALID_READINESS_CHECK", "Partner readiness check must be a function", "readiness");
    if (readinessCheck !== undefined && typeof readinessCheck !== "function") throw new PartnerContractError("INVALID_READINESS_CHECK", "Partner readiness check must be a function", "readinessCheck");
    this.clock = clock;
    this.transport = transport;
    this.secretProvider = secretProvider;
    this.configuredReadiness = readiness || readinessCheck;
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
      limits: limits || { timeout_ms: 8_000, max_attempts: 2, max_response_bytes: 64_000, max_items: 100 },
    });
  }

  capabilities() {
    return this.capability;
  }

  readiness({ now = new Date(this.clock()).toISOString() } = {}) {
    const reasons = [];
    if (this.capability.provider.confirmation_state !== "confirmed") reasons.push("PARTNER_PRODUCT_NOT_CONFIRMED");
    if (!this.capability.scope_ref) reasons.push("TENANT_OR_SCOPE_NOT_SET");
    if (!this.capability.credential_ref) reasons.push("AUTH_REFERENCE_NOT_SET");
    if (this.capability.credential_ref && !secretReferenceIsValid(this.capability.credential_ref, this.secretProvider)) reasons.push("INVALID_AUTH_REFERENCE");
    if (!this.configuredReadiness && this.capability.credential_ref && (!this.secretProvider || (typeof this.secretProvider.isConfigured === "function" && !this.secretProvider.isConfigured()))) reasons.push("SECRET_PROVIDER_NOT_CONFIGURED");
    if (!this.transport) reasons.push("TRANSPORT_NOT_CONFIGURED");
    if (this.capability.enabled !== true) reasons.push("PROVIDER_DISABLED");
    if (reasons.includes("AUTH_REFERENCE_NOT_SET") || reasons.includes("INVALID_AUTH_REFERENCE") || reasons.includes("SECRET_PROVIDER_NOT_CONFIGURED")) {
      return partnerReadiness({ capability: this.capability, state: "missing_auth", checkedAt: now, reasonCodes: reasons });
    }
    if (reasons.length) return partnerReadiness({ capability: this.capability, state: "not_configured", checkedAt: now, reasonCodes: reasons });

    // A supplied check is an explicit server-owned authority for injected
    // transport and secret-provider health. It never receives a secret value.
    if (typeof this.configuredReadiness === "function") {
      try {
        return readinessFromInjectedCheck(this.configuredReadiness({ now, capability: this.capability }), this.capability, now);
      } catch {
        return partnerReadiness({ capability: this.capability, state: "unavailable", checkedAt: now, reasonCodes: ["INJECTED_READINESS_FAILED"] });
      }
    }
    return partnerReadiness({ capability: this.capability, state: "ready", checkedAt: now, reasonCodes: [] });
  }

  async checkCredential(signal) {
    const reference = this.capability.credential_ref;
    if (!reference) throw new PartnerError("missing_auth", "The configured partner credential is unavailable", { retryable: false, status: 503 });
    if (!this.secretProvider) return;
    try {
      if (typeof this.secretProvider.check === "function") {
        const checked = await this.secretProvider.check(reference, { signal });
        if (checked === false) throw new Error("Secret provider rejected the reference");
      } else if (typeof this.secretProvider.getSecret === "function") {
        await this.secretProvider.getSecret(reference, { signal });
      } else if (typeof this.secretProvider.read === "function") {
        await this.secretProvider.read(reference, { signal });
      } else {
        throw new PartnerError("missing_auth", "The configured partner credential is unavailable", { retryable: false, status: 503 });
      }
    } catch (error) {
      if (error instanceof PartnerError) throw error;
      throw secretFailure(error);
    }
  }

  async invoke(operation, input = {}, context = {}) {
    assertReadOnlyOperation(operation);
    const allowed = this.capability.allowed_operations.find((item) => item.operation === operation);
    if (!allowed) throw new PartnerContractError("UNKNOWN_CAPABILITY", `Partner capability is not registered: ${operation}`, "operation");
    const readiness = this.readiness();
    if (readiness.state !== "ready") {
      const kind = readiness.state === "missing_auth" ? "missing_auth" : "not_ready";
      throw new PartnerError(kind, "The configured partner seam is not ready for live access", { retryable: false, status: 503 });
    }
    if (typeof this.transport !== "function") throw new PartnerError("not_configured", "No partner transport is configured", { retryable: false });
    const normalizedInput = normalizePartnerInput(input);
    await this.checkCredential(context.signal);
    // The transport receives only server-validated references and normalized
    // input. It is responsible for resolving credential_ref in a secret store.
    return this.transport({
      endpoint_ref: this.capability.endpoint_ref,
      provider_id: this.capability.provider.provider_id,
      operation,
      tool_ref: allowed.tool_ref,
      auth_mode: this.capability.auth_mode,
      credential_ref: this.capability.credential_ref,
      scope_ref: this.capability.scope_ref,
      manifest_hash: this.capability.manifest_hash,
      input: normalizedInput,
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
