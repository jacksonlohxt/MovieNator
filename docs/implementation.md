# Movie-Inator mock-safe implementation guide

Movie-Inator implements the early mock and replay stage plus the usable browser slice recommended in `docs/prd.md`. The Audience Data Readiness workflow remains available beside the explicit script/document grounding workflow. It is an isolated demo path, not a live provider or production deployment.

## Runtime shape

- `src/contracts.js` and `src/contracts.d.ts` define the versioned request, plan, evidence, decision, draft, result, event, and run-state contracts. The matching files under `schemas/` are the cross-language JSON Schema source. Runtime validation rejects unknown fields and untrusted authority fields.
- `src/engine.js` contains `FakeModel`, `MockProvider`, the fixed semantic operations, deterministic policy oracle, bounded provider retry, EvidenceBundle validation, final policy recomputation, verifier, redacted projections, and recovery behavior. `src/model-gateway.js` defines the product-owned model boundary and `src/gemini-rest.js` contains the disabled-by-default, server-only REST adapter with injectable transport and token provider. `src/documents.js`, `src/grounding.js`, and `src/grounding-engine.js` define Movie-Inator's bounded PDF/plain-text ingestion, local citation seam, and grounded script brief worker.
- `src/store.js` is an atomic local JSON store for runs, idempotency hashes, append-only events, and normalized evidence. It is suitable for local mock use only.
- `src/partner-contracts.js`, `src/partner-registry.js`, `src/partner-mock.js`, `src/partner-runtime.js`, and `src/partner-adapter.js` define the Phase 3 capability/readiness contract, explicit read-only registry, credential-free synthetic adapter, bounded runtime, redacted events, and disabled future live seam. See `docs/partner-integration.md` for operator inputs and enablement gates.
- `src/server.js` provides the API and same-origin SSE. Work is queued after `202 Accepted`; the browser reads safe projections, evidence records, document metadata, and citation excerpts only. The original `/v1/runs` and evidence routes remain the Audience Data Readiness workflow.
- `web/` is a dependency-free responsive browser route with Ask, Clarify, Role Run, Decision, Evidence, Recovery, and an on-demand bounded role map.

The server fixes `audience_data_readiness`, `Demo Media Workspace`, the fixed evidence classes, and the recommended policy configuration. `FakeModel` plus `MockProvider` remains the default. The optional Google backend is selected only by server configuration after a passed readiness state. The browser has no provider, endpoint, tool, model, threshold, tenant, credential, approval, publish, SQL, or URL input.

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

`POST /v1/runs` requires `Idempotency-Key`, validates `run-request@1`, stores only the key hash, persists the accepted run and event, then schedules the worker. Reusing a key with the same request returns the original run; reusing it with another request returns `409`. Retry and clarification are explicit child-run endpoints, so the original record is never mutated. `GET /v1/runs/{id}/events` supports monotonic IDs, `Last-Event-ID`, heartbeat comments, and terminal close. Cancellation is recorded before the worker checks each operation; late results are discarded.

Evidence records are normalized, bounded, hashed, and labelled `Demo evidence`. Public evidence leaves out source payloads, private rows, URLs, prompts, secrets, and hidden reasoning. The only status authority is `evaluatePolicy` in deterministic code. Writer output is schema- and evidence-checked; unsafe, malformed, or unsupported output uses the deterministic template.

## Browser contract

The route uses semantic landmarks, one `h1`, associated labels, visible focus, keyboard-friendly buttons, live phase announcements, text plus icons for statuses, and a true mobile evidence dialog with focus return and Escape close. It supports responsive cards at narrow widths, controlled horizontal scrolling only for the role map and journey navigation, `prefers-reduced-motion`, forced-colors styling, refresh restoration through `sessionStorage`, SSE with bounded polling fallback, cancellation, clarification, and retry.

## Validation

```sh
npm test
npm run check
npm start
```

The test suite uses temporary stores and the default fake components, plus injected fake transport tests for the disabled-by-default Google adapter. It does not require credentials, network access, Google, IBM, partner services, or a hosted model. `docs/google-setup.md` labels gcloud and ADC commands as operator actions that are not run by tests or the application. Open Captain decisions in the PRD remain decisions above this implementation: workflow selection, exact policy posture, project, billing, region, model, SDK/API version, identity, retention, provider enablement, runtime, and any future side effect.
