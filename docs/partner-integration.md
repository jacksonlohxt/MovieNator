# Partner integration operator guide

Phase 3 adds a provider-neutral, read-only partner boundary. The default runtime registers one local synthetic adapter: `mock-provider` at `local://movie-inator/mock`. No partner product, tenant, endpoint, credential, or network transport is selected by default.

## What is automated locally

- `PartnerCapability@1` records provider identity, environment, an opaque endpoint reference, authentication mode, explicit read-only operations, data classes, health, limits, manifest hash, and redacted provenance.
- `PartnerRegistry` is the only addressable provider catalog. It rejects unknown providers, endpoints, tools, capabilities, and mutating operation names before an adapter or transport is called.
- `LocalMockPartnerAdapter` returns deterministic synthetic asset, metadata, quality, governance, lineage, search, and telemetry observations. It also implements Movie-Inator's existing semantic EvidenceProvider methods, so a local readiness worker can inject it without changing the workflow contract. It has no URL transport and requires no credentials.
- `PartnerOperationRunner` applies a two-attempt maximum, bounded timeouts, retry classification, duplicate-delivery suppression, circuit behavior, stale-readiness reporting, and safe unavailable results.
- Partner events contain hashes, operation names, attempt counts, status, error class, and bounded redacted metadata. They do not contain credentials, authorization headers, raw request or response payloads, or private rows.
- Partner observations are evidence input only. They cannot select a model or tool, change the Policy Gate decision, publish, mutate, submit, purchase, deploy, export, or send messages. The existing deterministic Policy Gate remains authoritative.

The browser uses `GET /v1/partners` for a safe provider status and provenance projection. `GET /v1/partners/{provider_id}/readiness` exposes bounded readiness state. These projections show references and hashes, never secrets or raw payloads.

## Live enablement seam

The future adapter shape is `CredentialGatedReadOnlyPartnerAdapter` (with the IBM-compatible naming seam `IbmCompatibleReadOnlyAdapter`). It is disabled and unregistered by default. It does not choose between watsonx.data intelligence, Flow MCP, or another IBM product. It accepts an injected transport only after an operator has an exact, approved capability manifest.

Before adding a live registration, record all of the following in the operator configuration and Captain decision record:

1. **Partner product**: exact product and API or MCP surface, including version. Do not use `IBM`, `IVM`, or a product family as a substitute for confirmation.
2. **Tenant and region**: tenant/project/catalog or workspace reference, region, and required data residency.
3. **Endpoint**: the approved endpoint represented by an opaque `config://...` endpoint reference. Do not put a bearer URL, query string, or secret in the browser, manifest, event, or prompt.
4. **Authentication mode**: for example OAuth client credentials, delegated OAuth, ADC, mTLS, or another approved mode. Record only a secret-store reference and the issuer, audience, expiry, and subject checks.
5. **Scopes**: exact least-privilege scopes and the identity that owns them. The manifest must contain only read operations for this workflow.
6. **Synthetic test dataset**: asset IDs, metadata shape, quality, governance, lineage, and telemetry fixtures that may be used for contract tests, plus expected redaction behavior.
7. **Retention**: normalized evidence, redacted events, traces, raw-payload policy, deletion window, residency, and incident-capture expiry.
8. **Owner**: accountable technical owner, data steward, security reviewer, rollback owner, and contract-test date.

Never ask an operator or Captain to paste a secret into a chat, issue, PR, environment committed to git, prompt, browser field, or log. Ask for a secret-store reference and an approved runtime identity instead. A missing credential reference produces `missing_auth` and no transport call.

## Readiness states and recovery

`ready` means the registered manifest, endpoint reference, auth reference, scope, and transport passed the configured checks. `not_configured` and `missing_auth` fail closed. `stale` means the last readiness check exceeded its freshness bound. `degraded`, `unavailable`, `denied`, and `circuit_open` remain visible and do not trigger automatic partner fallback.

When a live partner is unavailable, the safe result says that partner evidence is unavailable and offers a manual check or an explicit, separately labelled demo run. It never silently switches to another partner or makes synthetic evidence look live. A retry is bounded and preserves the original provenance.

## Local checks

```sh
npm test
npm run check
npm start
# GET http://127.0.0.1:4173/v1/partners
# GET http://127.0.0.1:4173/v1/partners/mock-provider/readiness
```

These commands use synthetic data only. No partner credentials or outbound network access are needed.
