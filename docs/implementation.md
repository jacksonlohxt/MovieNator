# MovieNator mock-safe implementation guide

MovieNator implements the Captain-approved Script Brief browser flow plus the existing mock and replay foundations. Script Brief is the primary browser experience. Audience Data Readiness remains available from the collapsed Developer details surface and keeps its existing contracts. Both are read-only demo paths, not live provider or production deployments.

## Runtime shape

- `src/contracts.js` and `src/contracts.d.ts` define the versioned request, plan, evidence, decision, draft, result, event, and run-state contracts. The matching files under `schemas/` are the cross-language JSON Schema source. Runtime validation rejects unknown fields and untrusted authority fields.
- `src/engine.js` contains `FakeModel`, `MockProvider`, the fixed semantic operations, deterministic policy oracle, bounded provider retry, EvidenceBundle validation, final policy recomputation, verifier, redacted projections, and recovery behavior. `src/model-gateway.js` defines the product-owned model boundary and `src/gemini-rest.js` contains the disabled-by-default, server-only REST adapter with injectable transport and token provider. `src/documents.js`, `src/grounding.js`, and `src/grounding-engine.js` define MovieNator's bounded PDF/plain-text ingestion, whole-document condensation seam, source-location citations, v2 Script Brief proposal/result contracts, and grounded brief worker.
- `src/store.js` is the atomic local JSON authority for runs, idempotency hashes, append-only events, normalized evidence, workflow branches, checkpoints, leases, retry metadata, cancellation intent, and terminal outcomes. It is suitable for local mock use only.
- `src/partner-contracts.js`, `src/partner-registry.js`, `src/partner-mock.js`, `src/partner-runtime.js`, and `src/partner-adapter.js` define the Phase 3 capability/readiness contract, explicit read-only registry, credential-free synthetic adapter, bounded runtime, redacted events, and disabled future live seam. `src/runtime-config.js`, `src/secrets.js`, `src/partner-defaults.js`, and `src/server.js` provide the server-owned capability, secret-reference, and injected transport path without vendor request semantics. See `docs/partner-integration.md` for operator inputs and enablement gates.
- `src/logic-contracts.js`, `src/tool-registry.js`, `src/mcp-database.js`, `src/orchestrator.js`, `src/workflow-state.js`, and `src/agent-runtime-boundary.js` define the Phase 4 resumable-state contracts, allowlisted local read tools, bounded proposal execution, and future runtime adapter boundary. See `docs/phase4-state-logic-hosting.md` for the detailed operating and recovery contract.
- `src/server.js` provides the API and same-origin SSE. Work is queued after `202 Accepted`; the browser reads safe projections, evidence records, document metadata, and citation excerpts only. The original `/v1/runs` and evidence routes remain the Audience Data Readiness workflow.
- `web/` is a dependency-free responsive browser route whose primary flow is Upload script, Tell us what you want, Create brief, then Read or copy the result. Audience Ask, Clarify, Role Run, Decision, Evidence, Recovery, and the bounded role map are secondary Developer details.

The server fixes `audience_data_readiness` for the secondary workflow and keeps `FakeModel` plus the local deterministic source as the default Script Brief path. The optional Google backend is selected only by server configuration after a passed readiness state. The browser has no provider, endpoint, tool, model, threshold, tenant, credential, approval, publish, SQL, or URL input. Script Brief uses `grounded-brief-request@2`, `grounded-script-brief@2`, `grounded-script-result@2`, and the versioned `producer-intelligence@1` section; v1 and earlier stored Script Brief results remain readable for compatibility.

## Demo fixtures

The fill-only cards make the acceptance paths explicit:

| Fixture | Expected behavior |
|---|---|
| Clear pass | `READY`, complete quality, governance, and lineage |
| Needs review | `REVIEW`, governance evidence is missing |
| Needs clarity | `NEEDS_INPUT`, two candidates, no downstream calls before selection |
| Unknown | `UNKNOWN`, no authoritative asset match |
| Recovery | first run is a bounded unavailable failure; retry creates an immutable child and succeeds with demo evidence |

Additional deterministic hints cover `blocked`, `denied`, and `stale` evidence for focused tests.

## API safety and durability

`POST /v1/runs` requires `Idempotency-Key`, validates `run-request@1`, stores only the key hash, persists the accepted run and event, then schedules the worker. Reusing a key with the same request returns the original run; reusing it with another request returns `409`. Retry and clarification are explicit child-run endpoints, so the original record is never mutated. `GET /v1/runs/{id}/events` supports monotonic IDs, `Last-Event-ID`, heartbeat comments, and terminal close. `GET /v1/runs/{id}/state` and `GET /v1/runs/{id}/checkpoints` expose safe recovery projections; the normal run projection includes the same safe workflow summary. Cancellation is recorded before the worker checks each operation; late results are discarded. Tool and logic-host readiness are available from `GET /v1/tools/readiness` and `GET /v1/logic/state`; these routes expose only the local no-side-effect configuration described in the Phase 4 guide.

Evidence records are normalized, bounded, hashed, and labelled `Demo evidence`. Public evidence leaves out source payloads, private rows, URLs, prompts, secrets, and hidden reasoning. The only status authority is `evaluatePolicy` in deterministic code. Writer output is schema- and evidence-checked; unsafe, malformed, or unsupported output uses the deterministic template.

## Browser contract

The route uses semantic landmarks, one `h1`, associated labels, visible focus, keyboard-friendly buttons, live phase announcements, text plus icons for statuses, and a true mobile evidence dialog with focus return and Escape close. It supports responsive cards at narrow widths, controlled horizontal scrolling only for the role map and journey navigation, `prefers-reduced-motion`, forced-colors styling, refresh restoration through `sessionStorage`, SSE with bounded polling fallback, cancellation, clarification, and retry.

## Product identity and browser-state transition

The active display name is **MovieNator** and the machine-safe identifier for new product-owned identifiers is `movieinator`. The browser writes readiness, grounding-document, and grounding-run state under `movieinator-*` session keys. It reads the previously shipped `movie-inator-*` and `gemini-agents-*` browser/session keys only when the new key is absent, then copies the value to the new key without deleting the legacy value. This preserves resumable local state across both rename steps. The canonical local partner endpoint is `local://movieinator/mock`; the previously shipped `local://movie-inator/mock` endpoint remains an allowlisted compatibility alias. The canonical deployment secret reference variable is `MOVIEINATOR_SECRET_REF`; `MOVIE_INATOR_SECRET_REF` remains accepted by the generic Secret Manager reference parser.

The server keeps the direct `/`, `/app.js`, `/session-state.js`, and `/styles.css` routes same-origin. The API routes and stored run and document records remain unchanged; this rename changes product-facing identity, not durable record IDs or workflow contracts.

## Validation

```sh
npm test
npm run check
npm start
```

The test suite uses temporary stores and the default fake components, plus injected fake transport tests for the disabled-by-default Google adapter. It does not require credentials, network access, Google, IBM, partner services, or a hosted model. `docs/google-setup.md` labels gcloud and ADC commands as operator actions that are not run by tests or the application. Open Captain decisions in the PRD remain decisions above this implementation: workflow selection, exact policy posture, project, billing, region, model, SDK/API version, identity, retention, provider enablement, runtime, and any future side effect.

Phase 5 adds `Dockerfile`, `.dockerignore`, `deploy/cloud-run.yaml`, `scripts/deployment-smoke.js`, and the deployment/safety runbook. `src/runtime-config.js` fails closed for declared production or Cloud Run live configurations, while explicit mock mode remains offline. `src/secrets.js` is an injected Secret Manager reference seam; `src/safety.js` centralizes fixed text/multimodal limits and redaction; `src/audit.js` records bounded structured events. The default regression gate remains `npm test && npm run check`, with `npm run smoke:deployment` available against a local or operator-selected target.
