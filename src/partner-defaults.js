import { CredentialGatedReadOnlyPartnerAdapter } from "./partner-adapter.js";
import { PartnerContractError, parsePartnerCapability } from "./partner-contracts.js";
import { LocalMockPartnerAdapter } from "./partner-mock.js";
import { PartnerRegistry } from "./partner-registry.js";
import { LEGACY_LOCAL_MOCK_ENDPOINTS, LOCAL_MOCK_ENDPOINT } from "./product-identity.js";

function configuredCapability(value) {
  if (!value) return undefined;
  return parsePartnerCapability(value.capability || value);
}

function configuredTransport({ transport, transportFactory, capability, secretProvider }) {
  if (transport !== undefined && typeof transport !== "function") throw new PartnerContractError("INVALID_TRANSPORT", "Configured partner transport must be a function", "transport");
  if (transportFactory !== undefined && typeof transportFactory !== "function") throw new PartnerContractError("INVALID_TRANSPORT_FACTORY", "Configured partner transport factory must be a function", "transportFactory");
  if (transportFactory) {
    const injected = transportFactory({
      capability,
      // The factory may close over this provider. Secret values are never
      // placed in the transport request object.
      secretProvider,
    });
    if (typeof injected !== "function") throw new PartnerContractError("INVALID_TRANSPORT", "Configured partner transport factory must return a function", "transportFactory");
    return injected;
  }
  return transport;
}

/**
 * Default local mode intentionally registers exactly one synthetic provider.
 * A future registration is possible only through explicit server-owned
 * capability configuration and an injected transport.
 */
export function createDefaultPartnerRegistry({
  clock = Date,
  mockAdapter = undefined,
  endpointAllowlist = [LOCAL_MOCK_ENDPOINT, ...LEGACY_LOCAL_MOCK_ENDPOINTS],
  partnerConfig = undefined,
  secretProvider = undefined,
  transport = undefined,
  transportFactory = undefined,
  readiness = undefined,
} = {}) {
  const configured = configuredCapability(partnerConfig);
  const allowlist = new Set(endpointAllowlist);
  if (configured) allowlist.add(configured.endpoint_ref);
  const registry = new PartnerRegistry({ clock, endpointAllowlist: [...allowlist] });
  const adapter = mockAdapter || new LocalMockPartnerAdapter({ clock });
  registry.register({ capability: adapter.capabilities(), adapter });

  if (configured) {
    const liveAdapter = new CredentialGatedReadOnlyPartnerAdapter({
      provider: configured.provider,
      environment: configured.environment,
      endpointRef: configured.endpoint_ref,
      authMode: configured.auth_mode,
      credentialRef: configured.credential_ref,
      scopeRef: configured.scope_ref,
      allowedOperations: configured.allowed_operations,
      dataClasses: configured.data_classes,
      manifestHash: configured.manifest_hash,
      enabled: configured.enabled,
      limits: configured.limits,
      secretProvider,
      transport: configuredTransport({ transport, transportFactory, capability: configured, secretProvider }),
      readiness,
      clock,
    });
    registry.register({ capability: liveAdapter.capabilities(), adapter: liveAdapter });
  }
  return registry;
}
