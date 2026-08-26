# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Product requirements, role authority, and unresolved Captain decisions are maintained in `docs/prd.md`.
- The MovieInator script/document grounding contract, operator boundary, and future provider seam are maintained in `docs/phase2-script-grounding.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Implementation pointers

- The mock-safe engine, local API, browser route, contracts, fixtures, and validation commands are documented in `docs/implementation.md`; the Google runtime scaffold and read-only packet boundary are documented in `docs/google-agent-runtime.md`.
- The default regression gate is `npm test && npm run check`; it requires no credentials or external services.
- Phase 5 deployment, runtime-mode validation, Secret Manager seam, safety budgets, audit events, and operator-only Cloud Run/Agent Runtime actions are documented in `docs/phase5-deployment.md`; no cloud mutation is part of repository validation.
- The default Phase 3 partner path is the credential-free local `mock-provider`; live partner registration and required operator inputs are documented in `docs/partner-integration.md`.
- Phase 4 worker-owned state mutations are lease-fenced by lease ID, with heartbeat renewal and stale-owner rejection in `src/engine.js` and `src/store.js`; bounded tool budget scope eviction is implemented in `src/tool-registry.js`.
- `src/producer-consolidation.js`, `test/producer.test.js`, and `/v1/producer-source-bundles` define the strict bounded Producer Intake slice that emits the PRD-target `producer-intake-decision-packet@1` contract (`PRODUCER_PACKET_SCHEMA`): one `primary_screenplay` and up to twelve PDF/TXT sources produce stable source hashes, a source/version manifest, allowlisted classifications and evidence states, conflicts, citations, the full provenance object (`contract_version`, `bundle_manifest_hash`, `source_manifest_hash`, `grounding_strategy`, `fallback_used`, `retention_state`), and read-only Markdown/JSON/CSV handoff exports. The older free-label `/v1/producer-packets` multipart route remains a separate, unrenamed `producer-decision-packet@1` compatibility alias (`PRODUCER_PACKET_SCHEMA_LEGACY`); it does not emit the strict PRD fields. The compliance-trigger register described in `docs/prd.md` remains an explicitly out-of-scope, still-open Captain decision.
- Producer packet creation is asynchronous and immutable: `src/producer-engine.js` (`ProducerPacketEngine`) and the `producerRuns`/`producerRunEvents` collections in `src/store.js` queue one run per `packet_id` (content-derived for a first attempt, freshly minted for a retry child) that advances `accepted` -> `queued` -> `running` -> a terminal `succeeded`/`failed` state; `POST /v1/producer-packets` and `POST /v1/producer-source-bundles/{bundle_id}/packets` return `202 Accepted` immediately (never build the packet in the request), `GET /v1/producer-packets/{packet_id}` returns a bounded pending/failed projection until the run succeeds, `GET .../events` is the SSE progress stream, and `POST .../retry` only ever creates a new child run (`parent_packet_id` link) and never mutates the original terminal run. Test this surface in `test/producer-run.test.js` (not `test/producer.test.js`), using `app.producerEngine.waitForIdle(packetId)` to await completion and `createApp({ producerBuilder })` to inject a failing builder for retry tests.
