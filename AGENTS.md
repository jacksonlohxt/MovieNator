# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Product requirements, role authority, and unresolved Captain decisions are maintained in `docs/prd.md`.
- The MovieNator script/document grounding contract, operator boundary, and future provider seam are maintained in `docs/phase2-script-grounding.md`.

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
- `src/producer-consolidation.js`, `test/producer.test.js`, and `/v1/producer-packets` define the bounded, deterministic multi-source producer packet slice; source labels are fixed server-owned values and packet citations retain page or section/line locations.
