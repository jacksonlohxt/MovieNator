import { LocalMockPartnerAdapter } from "./partner-mock.js";
import { PartnerRegistry } from "./partner-registry.js";

/**
 * Default local mode intentionally registers exactly one synthetic provider.
 * Future partner registrations must be explicit, private, and separately
 * allowlisted by the operator after Captain confirmation.
 */
export function createDefaultPartnerRegistry({ clock = Date, mockAdapter = undefined, endpointAllowlist = ["local://movie-inator/mock"] } = {}) {
  const registry = new PartnerRegistry({ clock, endpointAllowlist });
  const adapter = mockAdapter || new LocalMockPartnerAdapter({ clock });
  registry.register({ capability: adapter.capabilities(), adapter });
  return registry;
}
