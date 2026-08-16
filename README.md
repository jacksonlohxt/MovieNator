# Gemini Agents

Gemini Agents is a proposed web-first product for media launch planning. It turns one question about one audience or campaign data asset into an inspectable readiness brief. It is a decision and evidence surface, not a generic autonomous-agent platform.

## Recommended v1 workflow

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

No Google or IBM integration is enabled, no production credentials are present, and no side effects are authorized. The Google platform and model deployment choices remain open. IBM watsonx.data intelligence is only a conditional, read-only staging seam that requires explicit Captain decisions, tenant and endpoint access, authentication, synthetic data, a pinned capability manifest, contract tests, and internal enablement.

## Current status

The repository contains the Phase 1 deterministic mock engine and a Phase 2 browser vertical slice for the recommended workflow. The default path uses `FakeModel`, `MockProvider`, a local durable JSON store, and no credentials or network calls. No Google, IBM, partner, hosted-model, or side-effect integration is enabled.

```sh
npm test
npm run check
npm start
# open http://127.0.0.1:4173
```

The local server exposes the documented `/v1/runs` API, safe projections, event stream, cancellation, clarification, retry-child, and evidence routes. Local run records are written under `.data/` and are ignored by git.

## Local documentation

- [Product requirements document](docs/prd.md) - the authoritative detailed specification and the unresolved Captain decisions.
- [Implementation guide](docs/implementation.md) - contracts, mock fixtures, recovery semantics, browser behavior, and validation commands.

The PRD remains the source of truth for product detail. This implementation keeps its workflow, policy, identity, retention, provider, and side-effect choices visible as configuration seams rather than treating recommendations as approvals. It does not claim legal, privacy, rights, publishing, live-provider, or production readiness.
