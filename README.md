# Movie-Inator

Movie-Inator is a web-first product for filmmaker launch planning and grounded script work. It turns one question about one audience or campaign data asset into an inspectable readiness brief, and separately grounds bounded PDF or plain-text script sources into cited excerpts. It is a decision and evidence surface, not a generic autonomous-agent platform.

Movie-Inator is the exact product display name, with `movie-inator` as the machine-safe identifier for new package and browser-state keys. Existing run IDs, API routes, workflow IDs, and durable records remain compatible during the rename.

## Explicit workflows

### Filmmaker script / document grounding

Upload one bounded PDF or plain-text script, ask a focused question, and receive a brief grounded only in selected local excerpts. Each citation opens its page or section excerpt. The MVP uses a deterministic local grounding source, has no approval screen, and does not generate video, audio, image, music, or VFX output.

### Recommended audience data workflow

The recommended first workflow is the **Audience Data Readiness Brief**. It assesses one resolved asset for one stated planning purpose using bounded evidence. This recommendation is not yet a formal Captain selection.

Its two primary outputs are:

1. A deterministic readiness decision: `READY`, `REVIEW`, `BLOCKED`, or `UNKNOWN`.
2. An evidence-backed explanation with visible gaps and up to three bounded next checks for a person to perform. The product does not execute those checks.

## Role architecture

The workflow uses a small fixed pipeline rather than a dynamic agent swarm:

- **Intake and optional Planner:** validate the request and produce a typed plan or one clarification. A model may help interpret language, but it has no authority over access or policy.
- **Evidence Coordinator:** deterministic code resolves one asset and gathers bounded Quality, Governance, and Lineage evidence through a provider interface.
- **Policy Gate:** deterministic code is the sole owner of the readiness decision.
- **Brief Writer and Verifier:** an optional model explains normalized evidence; deterministic verification and safe projection prevent unsupported claims from reaching the browser.

The API, worker, persistence, and observability layers are deterministic implementation components, not autonomous roles.

## Mock-first and gated integrations

Phase 1 is designed to run with a deterministic `FakeModel` and `MockProvider` using synthetic fixtures labelled `Demo evidence`. No credentials or external calls are needed for the mock path.

No Google or IBM integration is enabled by default, no production credentials are present, and no side effects are authorized. The repository includes a credential-gated, server-only Google REST adapter foundation, but it remains disabled until all server configuration and readiness gates pass. The Google platform and model deployment choices remain open. See [operator setup placeholders](docs/google-setup.md). IBM watsonx.data intelligence is only a conditional, read-only staging seam that requires explicit Captain decisions, tenant and endpoint access, authentication, synthetic data, a pinned capability manifest, contract tests, and internal enablement.

## Current status

The repository contains the deterministic audience readiness workflow and a Phase 2 Movie-Inator script-grounding vertical slice. The default path uses `FakeModel`, `MockProvider`, a local deterministic grounding source, a local durable JSON store, and no credentials or network calls. No Google, IBM, partner, hosted-model, or side-effect integration is enabled.

```sh
npm test
npm run check
npm start
# open http://127.0.0.1:4173
npm run smoke:deployment

# Optional explicitly enabled ADC-backed Gemini model path, using ignored .env.local
npm run start:google
```

The local server exposes the existing `/v1/runs` API and evidence paths unchanged, plus `/v1/documents` upload, `/v1/documents/{document_id}/briefs` grounded brief requests, script progress events, and citation excerpt routes. Local run and source records are written under `.data/` and are ignored by git. Set `GOOGLE_GEMINI_ENABLED=true`, `MODEL_BACKEND=google_rest`, `GOOGLE_GEMINI_READINESS=passed`, and the verified server-only ADC configuration in `.env.local` or explicit exports before using `npm run start:google`; never commit tokens, ADC files, or source material.

## Local documentation

- [Product requirements document](docs/prd.md) - the authoritative detailed specification and the unresolved Captain decisions.
- [Implementation guide](docs/implementation.md) - contracts, mock fixtures, recovery semantics, browser behavior, and validation commands.
- [Movie-Inator Phase 2 script grounding operator guide](docs/phase2-script-grounding.md) - automation, operator boundaries, local grounding, future search seams, and separate media adapters.
- [Phase 5 deployment and safety runbook](docs/phase5-deployment.md) - container, Cloud Run placeholders, runtime modes, Secret Manager seam, safety budgets, audit events, and the later Agent Runtime path.

The PRD remains the source of truth for product detail. This implementation keeps its workflow, policy, identity, retention, provider, and side-effect choices visible as configuration seams rather than treating recommendations as approvals. It does not claim legal, privacy, rights, publishing, live-provider, or production readiness.
