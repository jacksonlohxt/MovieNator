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

This is a documentation-only discovery and design repository. It currently contains the product index and PRD, with no application implementation, dependency setup, production credentials, or partner integration. The PRD is an implementation-ready recommendation, pending open Captain decisions.

## Local documentation

- [Product requirements document](docs/prd.md) - the authoritative detailed specification for the workflow, contracts, role authority, states, evidence, safety boundaries, roadmap, recommendations, and open Captain decisions.

The PRD is the source of truth for product detail. It records recommendations and unresolved decisions; it does not authorize Google, IBM, partner access, production credentials, or side effects.
