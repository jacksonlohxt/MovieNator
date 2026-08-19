> **PRD source of truth:** [`docs/prd.md`](docs/prd.md) is canonical for the complete PRD. The README includes the current Movie-Inator product surface and an exact PRD copy below; maintain `docs/prd.md` and run `npm run check:docs` to detect drift.

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

The repository contains the deterministic audience readiness workflow, the Phase 2 Movie-Inator script-grounding vertical slice, and Phase 3 provider-neutral partner infrastructure. The default path uses `FakeModel`, `MockProvider`, a local deterministic grounding source, a local durable JSON store, and a credential-free synthetic partner adapter. No IBM, IVM, or other live partner product, tenant, endpoint, credential, hosted-model, or side-effect integration is enabled.

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
- [Phase 3 partner integration operator guide](docs/partner-integration.md) - local automation, read-only registry rules, readiness and recovery, and the exact later live-access information required.

The PRD remains the source of truth for product detail. This implementation keeps its workflow, policy, identity, retention, provider, and side-effect choices visible as configuration seams rather than treating recommendations as approvals. It does not claim legal, privacy, rights, publishing, live-provider, or production readiness.

---

<!-- PRD:START -->
# Movie-Inator product requirements document

**Status:** implementation-ready recommendation, pending Captain decisions
**Scope:** documentation only. This document authorizes no Google, IBM, or partner access and no side effects.
**Recommended first workflow:** `Audience Data Readiness Brief` (recommended by the research, not yet formally selected by the Captain)
**Primary product outputs:**

1. A deterministic readiness decision: `READY`, `REVIEW`, `BLOCKED`, or `UNKNOWN`.
2. An evidence-backed explanation with visible gaps and up to three bounded next checks that the product does not execute.

The decision and explanation are separate authorities. Gemini may help interpret the request and write the explanation. It cannot choose the provider, tools, thresholds, decision, recipient, or side effect.

## 1. Product promise and boundaries

### Promise

Turn one media launch-planning question about one audience or campaign data asset into an inspectable readiness brief. The brief tells the user what the configured evidence supports, what is missing or stale, why the policy produced its decision, and which next checks a person could perform.

Example request:

> Before the Season 2 trailer launch, is the audience engagement dataset ready for a marketing brief? Flag quality, governance, and downstream-impact gaps, then recommend the next three checks.

The product is a decision and evidence surface, not a generic autonomous-agent platform. Its differentiation is the link between a bounded media question, normalized evidence, a deterministic policy result, and honest recovery when evidence is unavailable. Plain-language input, parallel calls, citations, streaming, and a multi-agent label are supporting patterns, not the product promise. [MRC: Executive synthesis; MR: What multi-agent patterns are actually useful]

### Non-goals for the first workflow

The first workflow does not:

- provide legal advice, privacy certification, rights clearance, publication permission, or a claim that data is universally safe;
- upload or understand a full video archive, generate video, recommend content, or publish anything;
- execute arbitrary SQL, browse arbitrary websites, accept arbitrary URLs, or import arbitrary MCP servers;
- mutate a catalog, data product, quality rule, role, permission, campaign, review queue, or partner record;
- expose a generic agent swarm, dynamic tool catalog, computer-use capability, customer memory, or automatic provider fallback;
- combine IBM, Parallel, ClickHouse, Grafana, and Replit in one run;
- claim that any Google, IBM, or partner tenant, endpoint, credential, connector, or media-specific service is connected.

A future release-readiness packet, creative ideation workflow, audience analytics workflow, or approval action must have its own workflow ID, contracts, policy, evaluation set, and Captain decision.

### Product roles, implementation components, and model agents

These are three different concepts:

- **Product roles** describe responsibility and authority in the user outcome. Examples are the Policy Gate and Brief Writer.
- **Implementation components** are services or modules that execute those roles. Examples are the API, durable worker, provider adapter, database, and telemetry pipeline.
- **Model-powered agents** are optional implementations for bounded transformations. In v1, only the Planner and Brief Writer may use Gemini. A product role does not become an autonomous agent merely because it has an agent-shaped name.

### Integration-first ecosystem direction

The north star is a contextualized creative workspace for filmmakers: help a person move from a problem or idea to evidence-backed concepts, reusable artifacts, reviewable decisions, and future integrations while preserving project context, preferences, history, and trust. The Audience Data Readiness Brief is a bounded seed, not the whole ecosystem and not a generic workflow screen.

The first release stays small: one workflow, one resolved asset, transparent evidence, deterministic policy, safe recovery, and no consequential external writes. Future ecosystem direction is phase-gated and must earn inclusion through a user outcome, a stable contract, provenance, privacy controls, and measurable value. Candidate extension points are contextual memory, artifact and project continuity, feedback and evaluation loops, reusable role packs, provider adapters, collaboration or review, and a partner or plugin ecosystem. None is a current capability or an invitation to expose a dynamic catalog.

| Boundary | Reuse | Product-owned adaptation | Product-owned contract or decision |
|---|---|---|---|
| Orchestration | Fixed sequential/parallel workflow patterns, durable queue and worker practices, and evaluation/observability conventions | A small fixed graph with role-scope budgets and explicit handoffs | Run state, phase gates, recovery, and safe browser projection |
| Model and provider access | Gemini structured output, a shared model backend, and candidate IBM WDI read operations | `ModelGateway`, `EvidenceProvider`, normalized evidence, capability manifest, and provenance labels | Which role may invoke a model or provider, semantic operations, authority, and no-fallback policy |
| Evidence and policy | Mature evidence, lineage, data-quality, tracing, and approval patterns | Media launch context, bounded evidence classes, and reviewer-safe projections | `EvidenceBundle`, `PolicyDecision`, status oracle, evidence gaps, and policy versions |
| Future ecosystem | Provider adapters, collaboration patterns, memory stores, role-pack packaging, and plugin mechanisms | Contextual connectors and artifact continuity introduced one contract at a time | Privacy, retention, consent, evaluation, compatibility, and Captain enablement |

A genuinely custom subsystem must name the mature capability it replaces, explain why reuse or an adapter is insufficient, identify the safety or user outcome it improves, and pass a replacement evaluation before entering the ship path. A visually richer graph, extra agent, or broader tool catalog is not by itself a product benefit.

## 2. Target user and jobs

### Primary user hypothesis

The primary user is a media marketing lead, editorial operations lead, or data steward preparing a launch brief and needing a fast answer about whether one audience or campaign data asset is ready for a stated planning purpose. This is a research-backed product hypothesis, not interview evidence. [MRC: Target user, problem, and jobs]

The secondary user is a reviewer or operator who needs to inspect source authority, policy version, provider mode, retries, and failure behavior. A reviewer is not required for the read-only v1 path. A reviewer becomes an approval authority only for a separately approved future side effect.

### Jobs to be done

- State one launch question in ordinary language.
- Identify the intended asset, container, purpose, and optional time window without guessing when ambiguous.
- See whether quality, governance, and downstream-impact evidence meet the configured readiness policy.
- Understand each material result from a source, observation time, freshness rule, and evidence status.
- Know what remains unknown, denied, stale, timed out, or conflicting.
- Leave with up to three concrete next checks, without the product executing them.
- Reopen, cancel, retry, or share a safe run result without losing provenance.

## 3. Recommended workflow and user journey

### Workflow decision posture

The research consistently recommends `Audience Data Readiness Brief` as the smallest mock-safe, read-only, evidence-backed slice. Earlier market research proposed a media release-readiness packet with a future human review handoff, but no media catalog, rights database, or IBM media flow was verified. The current PRD therefore records Audience Data Readiness as the **recommended** first workflow and keeps release readiness as a later alternative. The Captain has not formally selected the workflow. [MRC: Current product baseline and orchestration; TIV2: Executive technical verdict; FS: Executive recommendation; MR: Candidate media and entertainment problem statements]

### Fixed first workflow

One run covers one request, one configured workspace or tenant scope, and at most one resolved asset:

```text
User/intake
  -> validated RunRequest
  -> Planner or Intent Agent
  -> asset resolution
  -> quality, governance, and lineage read branches
  -> normalized EvidenceBundle
  -> deterministic Policy Gate
  -> Brief Writer
  -> Verifier and Safe Projection
  -> browser result and reviewer-safe trace
```

Quality, governance, and lineage branches may run in parallel only after the server has fixed the tenant scope and one asset ID. There is no dynamic swarm. The graph is fixed because the evidence classes are known.

### Screen and state journey

The public experience is one responsive route. It shows product truth, not model thoughts.

| Screen or state | Required behavior | Authority and failure behavior |
|---|---|---|
| **Ask** | One labelled problem statement, three fill-only examples, collapsed optional fields for asset hint, workspace hint, purpose, time window, and media context. Show `Demo evidence` and `No partner data is changed` in mock mode. | Browser performs only input checks. It cannot choose provider, endpoint, tool, model, threshold, tenant, or credential. Invalid input keeps user text and focuses the first error. |
| **Clarify** | Show one safe clarification when resolution returns multiple candidates or the request lacks enough asset information. Preserve the original request and explain match facts such as workspace and last observed time. | No quality, governance, or lineage call starts before a single asset is selected. The unresolved run is `NEEDS_INPUT`; resubmission creates a linked child request rather than mutating history. |
| **Running** | Show `Accepted`, `Queued`, `Planning`, `Resolving asset`, three child evidence rows, `Partial evidence` when relevant, `Composing`, and `Validating`. Show a run ID, elapsed time, bounded retry state, and cancellation state. | Show phase summaries only. Do not stream chain-of-thought or raw provider payloads. On refresh, restore the run and event cursor. Cancellation says `Cancellation requested` until the worker confirms terminal cancellation. |
| **Result** | Put `Data readiness: READY`, `REVIEW`, `BLOCKED`, or `UNKNOWN` first, followed by a short explanation, resolved asset, quality/governance/lineage cards, gaps, up to three next checks, policy version, and provenance label. | Status comes from code. The Writer can explain it but cannot change it. Use text and icon, never color alone. State beside the result that this is not legal, privacy, rights, or publishing approval. |
| **Evidence** | Open the evidence supporting the selected claim or gap. Show evidence ID, status, authority/source label, semantic operation, observed time, freshness, normalized facts and units, policy rule/version, and safe hash. | Public and reviewer projections differ. Raw rows, bearer tokens, prompts, hidden reasoning, arbitrary URLs, and unsafe HTML are excluded. A missing gap can have no evidence ID but must name the missing branch and failure class. |
| **Recovery** | Provide explicit actions for `NEEDS_INPUT`, unavailable, denied, timeout, malformed model output, expired, failed, canceled, and safe partial results. Retry creates a child run. `Use demo evidence` starts a separate labelled mock run only by explicit user choice. | Never silently fall back from a live provider to mock or another partner. Preserve the failed run and its provenance. A late response from an uncancellable provider is discarded if cancellation has won. |
| **Trace** (reviewer only) | Role-gated redacted trace with state transitions, model/backend, provider/backend, semantic operation, actual tool name, manifest/schema/policy hashes, attempts, latency, evidence IDs, and safe outcomes. | Never show chain-of-thought, secrets, raw private rows, or unrestricted tool catalogs. Public users do not see this route by hiding a tab alone; authorization must enforce it. |
| **Setup** (operator only) | Role-gated provider readiness view with manifest status, endpoint reference, transport/auth mode, tenant scope reference, schema hashes, last contract test, drift result, enablement flag, and disable reason. | It is `unknown`, `not_set`, `not_run`, `passed`, `failed`, or `disabled`. It shows references and hashes, not credentials. A failed contract test fails closed. IBM WDI remains hidden from the public selector until separately enabled. |

### Lavish journey requirements

If the journey is rendered or reviewed through Lavish, the artifact is a reviewable projection of product contracts, not evidence that each card is an agent or runtime process. Keep the progressive surfaces `Ask`, `Clarify`, `Role Run`, `Decision`, `Evidence`, `Trace`, `Recovery`, and on-demand `Role Map`; keep `Setup` operator-only. The default view shows one active role, its named next handoff, and the typed artifact exchanged. A full role map is on demand and must not use swarm animation, model thoughts, or autonomous language.

Lavish acceptance requires the same field-of-vision rules as the product: each visible role has one job, one input, one output, one authority, explicit allowed/prohibited scope, and a failure state. `Policy Gate` is visibly distinct as the only status authority. `Quality`, `Governance`, and `Lineage` appear as deterministic evidence branches, not model specialists. `Verifier` is separate from future human `Reviewer`. The Decision surface must make its coverage count match the displayed evidence classes, and each claim or gap must open the matching evidence record rather than a generic card. Trace shows safe handoffs, versions, operations, hashes, latency, and failure class only. Recovery preserves the original run and makes a mock switch an explicit new provenance-labelled run.

The prototype may show future role-pack, memory, continuity, collaboration, or provider concepts only as labelled ecosystem direction. It must not imply that those capabilities, partner access, or side effects exist in the MVP.

### Durable run states

The API may use lowercase storage states while the user-facing readiness result uses uppercase labels:

```text
accepted -> queued -> planning -> resolving_asset -> evidence_pending
                                         |                    |
                                   needs_input          evidence_partial
                                                              |
                                                         composing
                                                              |
                                                         validating
                                                              |
                                                          succeeded

Any active state -> cancel_requested -> canceled
Any active state -> expired
Any active state -> failed
```

Terminal run states are `needs_input`, `succeeded`, `canceled`, `expired`, and `failed`. `evidence_partial` is internal until it produces a safe `REVIEW` or `UNKNOWN` result, or a terminal failure. Reserve `waiting_for_approval` for a later side-effect workflow only.

`NEEDS_INPUT` is a run outcome, not a readiness decision. It means the system needs one user clarification before it can assess the requested asset. `UNKNOWN` means the system could not obtain an authoritative asset or usable evidence after the allowed resolution path.

## 4. Input and output contracts

JSON Schema is the cross-language contract source. Every schema is versioned, shallow enough for the selected Gemini structured-output path, and semantically validated by code. Unknown fields are rejected. [TIV2: Contracts and schemas; G3 and G4 in the report source register]

### Request contract

The browser sends `POST /v1/runs` with an `Idempotency-Key` header and a body such as:

```json
{
  "schema_version": "run-request@1",
  "problem_statement": "Before the Season 2 trailer launch, is the audience engagement dataset ready for a marketing brief?",
  "asset_hint": "season_2_audience_engagement",
  "container_hint": "Demo Media Workspace",
  "purpose": "marketing planning",
  "time_window": {
    "start": "2026-07-01T00:00:00Z",
    "end": "2026-08-01T00:00:00Z"
  },
  "media_context": {
    "show_or_campaign": "Season 2 trailer launch",
    "asset_type": "audience engagement"
  }
}
```

Required and rejected fields:

- `problem_statement` is required, UTF-8, and 1 to 8,000 normalized characters.
- `asset_hint`, `container_hint`, and media context fields are bounded hints, not authority. Each is at most 200 characters unless a schema explicitly narrows it.
- `purpose` is user intent, not permission. It is at most 120 characters and cannot set policy.
- `time_window` is optional UTC ISO-8601, `start < end`, with a maximum span of 366 days.
- Binary uploads, arbitrary URLs, raw SQL, and public-web browsing are not in this contract.
- Reject `provider`, `endpoint`, `tool`, `model`, `threshold`, `approved`, `publish`, `sql`, arbitrary workflow names, and unknown fields.
- Require a 1 to 128 character opaque `Idempotency-Key`; store only a hash.

The API derives identity, tenant, workspace, provider, policy, and model configuration from server-side configuration and verified claims. A hint cannot become an asset ID until the configured provider resolves it.

### Planner handoff

```json
{
  "schema_version": "readiness-plan@1",
  "workflow": "audience_data_readiness",
  "asset_query": "season_2_audience_engagement",
  "container_query": "Demo Media Workspace",
  "purpose": "marketing planning",
  "time_window": {"start": "...", "end": "..."},
  "required_evidence": ["asset", "quality", "governance", "lineage"],
  "clarification": null
}
```

The server fixes `workflow`, allowed evidence classes, provider, endpoint, tenant, catalog, and thresholds. A model proposal for another workflow, tool, or side effect is rejected or turned into one clarification, never executed.

### Evidence and policy contracts

```json
{
  "schema_version": "evidence-bundle@1",
  "asset": {
    "status": "resolved",
    "asset_id": "asset_demo_001",
    "display_name": "Season 2 audience engagement",
    "evidence_ids": ["ev_asset_01"]
  },
  "branches": {
    "quality": {"status": "complete", "evidence_ids": ["ev_quality_01"]},
    "governance": {"status": "missing", "evidence_ids": []},
    "lineage": {"status": "complete", "evidence_ids": ["ev_lineage_01"]}
  },
  "coverage": {
    "required": ["asset", "quality", "governance", "lineage"],
    "complete": ["asset", "quality", "lineage"],
    "missing": ["governance"],
    "denied": [],
    "timed_out": []
  }
}
```

```json
{
  "schema_version": "policy-decision@1",
  "decision": "REVIEW",
  "policy_version": "readiness-policy@1.0.0",
  "reasons": [{"code": "GOVERNANCE_EVIDENCE_MISSING", "evidence_ids": []}],
  "hard_stop": false
}
```

The safe public result contains the same decision plus `run_id`, `workflow`, `run_status`, `headline`, `summary`, check cards, risks, up to three recommendations, coverage, and provenance. The result never contains chain-of-thought, raw MCP payloads, secrets, or an unredacted tool transcript.

### Brief draft contract

```json
{
  "schema_version": "brief-draft@1",
  "headline": "Data readiness: REVIEW",
  "summary": "Quality and lineage evidence are available, but the approved marketing purpose could not be verified.",
  "risks": [
    {"severity": "high", "kind": "evidence_gap", "text": "The approved purpose was not found in authoritative evidence.", "evidence_ids": []}
  ],
  "recommendations": [
    "Confirm the approved marketing purpose with the data steward.",
    "Run the current quality check before using the asset in a campaign brief.",
    "Review downstream consumers before changing the asset schema."
  ],
  "cited_evidence_ids": ["ev_quality_01", "ev_lineage_01"]
}
```

The verifier limits recommendations to three, validates every evidence ID, rejects unsafe links and HTML, and rejects a model-supplied decision that disagrees with the Policy Gate. One bounded repair request is permitted. A deterministic template is the fallback when the Writer is unavailable.

### API and event contract

| Method | Endpoint | Requirement |
|---|---|---|
| `POST` | `/v1/runs` | Validate, create one idempotent run, enqueue `{run_id}`, return `202`. Never perform model or provider work inline. |
| `GET` | `/v1/runs/{run_id}` | Return a tenant-authorized safe projection. |
| `GET` | `/v1/runs/{run_id}/events` | Same-origin SSE with monotonic sequence IDs, heartbeat, `Last-Event-ID`, and terminal close. |
| `POST` | `/v1/runs/{run_id}/cancel` | Set cancellation intent with compare-and-set and return `202`. |
| `POST` | `/v1/runs/{run_id}/retry` | For recoverable terminal runs, create an immutable linked child run with a new idempotency key. |
| `GET` | `/v1/runs/{run_id}/evidence/{evidence_id}` | Return one safe evidence projection after authorization. |
| `GET` | `/healthz`, `/readyz` | Liveness/readiness only. Never return provider secrets or tenant data. |

Example progress event:

```text
event: run.progress
id: 13
data: {"run_id":"run_01JEXAMPLE","seq":13,"step":"governance","state":"complete","display":"Governance evidence received","occurred_at":"2026-08-14T14:00:03Z"}

: heartbeat
```

The browser uses one stream per run. If SSE disconnects, it reconnects from the cursor and falls back to bounded polling. Events expose safe phase data only.

## 5. Role and authority architecture

### Authority matrix

| Product role | Implementation kind | May use Gemini? | Owns | Never owns |
|---|---|---:|---|---|
| User and intake | Human plus deterministic browser/API validation | No | Problem statement, optional hints, explicit clarification choice | Provider, endpoint, tool, threshold, status, credentials, side effect |
| Planner or Intent Agent | Bounded model transformation behind a worker | Yes, optional | A typed plan or one clarification question | Authorization, asset identity, provider, tool, policy, status, action |
| Asset Resolution and Evidence Coordinator | Deterministic application code and provider gateway | No in v1 | One resolved asset, branch scheduling, normalization, evidence IDs | Guessing an asset, changing tenant scope, selecting arbitrary tools |
| Quality specialist | Deterministic read adapter/function | No in v1 | Quality evidence and branch status | Running or creating quality rules, deciding readiness |
| Governance specialist | Deterministic read adapter/function | No in v1 | Governance/classification evidence and gaps | Declaring privacy approval or changing classification |
| Lineage specialist | Deterministic read adapter/function | No in v1 | Bounded lineage evidence and truncation | Unbounded graph traversal, impact approval, schema change |
| Policy Gate | Deterministic code | No | `READY`, `REVIEW`, `BLOCKED`, `UNKNOWN`, reason codes, policy version | Explanation style, provider selection, side effects |
| Brief Writer | Bounded model transformation or deterministic template | Yes, optional | User-readable explanation, risks, up to three next checks, evidence references | Decision, evidence, authorization, execution |
| Verifier and Safe Projection | Deterministic code | No, except one bounded repair request through Writer | Schema/semantic validation, redaction, claim coverage, public/reviewer projections | Repair loops, status override, hidden fallback |
| Reviewer/operator for future effects | Authenticated human plus deterministic approval service | No | Approval or rejection of one exact proposed effect | Approving a changed action, bypassing policy, granting model authority |
| Application API | Deterministic service | No | Auth, input bounds, tenant scope, idempotent run creation, safe reads | Long-running orchestration inline, model/provider authority |
| Durable worker | Deterministic service | Invokes model gateway and provider gateway | State machine, leases, deadlines, retries, cancellation, handoffs | Arbitrary tool discovery, status override, untracked work |
| Persistence | Deterministic database/object store | No | Canonical runs, evidence, events, artifacts, hashes, retention metadata | Hidden reasoning or unbounded raw payload retention |
| Observability | Deterministic telemetry pipeline | No | Redacted trace, metrics, safe audit events, correlation | Secrets, raw private rows, public source of truth, chain-of-thought |

### Role contracts and handoffs

#### User and intake

- **Inputs:** human problem statement and bounded hints. The user may choose among server-exposed demo examples and, later, a permitted clarification option.
- **Outputs:** immutable `RunRequest` and explicit `Idempotency-Key`.
- **Authority:** defines the question and purpose, not permission to use data. The browser cannot set provider or policy.
- **Allowed tools:** browser validation and API submission only.
- **Failure behavior:** inline validation for malformed input; `NEEDS_INPUT` when the run needs a clarification; no hidden correction of user intent.
- **Evidence:** request hash, normalized request, actor or anonymous demo subject, creation time.
- **Handoff:** API validates before creating a run or invoking any model/provider.

#### Planner or Intent Agent

- **Inputs:** validated request, fixed workflow ID, bounded prompt template, no provider payload or tool catalog.
- **Outputs:** `readiness-plan@1` or one clarification question.
- **Authority:** extracts intent, asset query, purpose, and requested evidence classes. It does not select a provider, endpoint, model, tool, threshold, status, recipient, or action.
- **Allowed tools:** no external tools. Gemini structured output is optional; `FakeModel` must support mock mode.
- **Failure behavior:** reject schema-invalid or out-of-scope output; retry one transient model failure; return `NEEDS_INPUT` or `UNKNOWN` rather than guessing.
- **Evidence:** prompt template ID/hash, model backend and model ID if used, plan hash, validation result. The plan is not evidence of data.
- **Handoff:** coordinator receives only a validated plan and server-created `ProviderContext`.

#### Asset Resolution and Evidence Coordinator

- **Inputs:** validated plan, server-side tenant/workspace scope, immutable capability manifest, deadline, cancellation state.
- **Outputs:** one `AssetResolution`, normalized `EvidenceBundle`, branch events, and evidence records.
- **Authority:** resolves exactly one asset and decides whether branches may start. It owns operation sequencing and bounded concurrency, not policy status.
- **Allowed tools:** semantic provider methods only: `resolve_asset`, `describe_asset`, `read_quality`, `read_governance`, and `read_lineage`. Actual MCP tool names are hidden inside the adapter.
- **Failure behavior:** zero candidates become `UNKNOWN` or `NEEDS_INPUT` based on whether a safe clarification is possible; multiple candidates become `NEEDS_INPUT`; authorization, timeout, unavailable, malformed, or stale outcomes remain explicit. No automatic provider fallback.
- **Evidence:** asset evidence, operation, provider/backend, source reference, observed time, freshness, response hash, branch status, manifest hash.
- **Handoff:** quality, governance, and lineage branches start in bounded parallel only after one asset ID and tenant scope are fixed. Their terminal outcomes go to the Policy Gate.

#### Quality evidence specialist

- **Inputs:** resolved asset reference, permitted time window, policy freshness configuration, provider context.
- **Outputs:** `QualityEvidence` with normalized dimensions, units, observed time, freshness, and status.
- **Authority:** reports what the configured source observed. It cannot define thresholds or call a rule executor.
- **Allowed tools:** `read_quality`, mapped to the candidate IBM WDI read operation `get_data_quality_for_asset` only after contract validation; MockProvider in public mode.
- **Failure behavior:** low or stale quality is evidence for `REVIEW`, not an automatic `BLOCKED` unless the Captain-approved policy makes it a hard stop. Denied, timed out, unavailable, and invalid remain visible.
- **Evidence:** one or more quality evidence records, including content hash and semantic operation.
- **Handoff:** returns to the coordinator, then the Policy Gate. It never calls the Writer directly.

#### Governance evidence specialist

- **Inputs:** resolved asset, stated purpose, configured authority class, provider context.
- **Outputs:** normalized governance, glossary, classification, or purpose evidence and explicit gap states.
- **Authority:** reports authoritative governance artifacts where present. It cannot infer that absence means privacy safety or grant approval.
- **Allowed tools:** `read_governance`, mapped only to read operations such as `get_asset_glossary_artifacts` and, if separately approved, `search_governance_artifacts`.
- **Failure behavior:** missing, denied, or unavailable governance evidence generally yields `REVIEW`; an explicit configured hard stop can yield `BLOCKED`. No governance mutation or rule creation.
- **Evidence:** source authority, artifact reference, classification facts when permitted, status, observed/freshness timestamps, and policy rule reference.
- **Handoff:** returns a branch record to the coordinator and Policy Gate. The Writer may describe the gap only after the gate computes the decision.

#### Lineage evidence specialist

- **Inputs:** resolved asset, bounded graph depth and node limits, optional time window, provider context.
- **Outputs:** normalized upstream/downstream counts or nodes, truncation marker, status, and evidence references.
- **Authority:** reports bounded impact evidence. It cannot decide whether a schema or campaign change is approved.
- **Allowed tools:** `read_lineage`, mapped to read operations such as `search_lineage_assets`, `convert_asset_to_lineage_id`, and `get_lineage_graph` after contract tests.
- **Failure behavior:** unavailable, timeout, denied, invalid, or truncated graphs remain explicit and usually produce `REVIEW`; no unbounded retry or traversal.
- **Evidence:** graph scope, node limit, truncation, operation, source reference, observed time, and hash.
- **Handoff:** returns branch outcome to the coordinator and Policy Gate.

#### Deterministic Policy Gate

- **Inputs:** complete or partial `EvidenceBundle`, Captain-approved policy configuration, freshness rules, threshold version, workflow purpose.
- **Outputs:** `PolicyDecision` with one readiness label, reason codes, evidence IDs, `policy_version`, and `hard_stop`.
- **Authority:** sole owner of readiness status. It runs before the Writer and again after verification to ensure the Writer did not alter it.
- **Allowed tools:** no model or provider calls. Pure deterministic policy code.
- **Failure behavior:** if evidence is not sufficient to evaluate, return `REVIEW` or `UNKNOWN` according to the explicit oracle; if policy configuration is missing or invalid, fail closed rather than use a model guess.
- **Evidence:** decision record, policy version, threshold/freshness references, and reason-to-evidence mapping.
- **Handoff:** Writer receives the decision as an immutable input. Safe Projection cannot succeed if the final draft disagrees.

Status oracle:

- `READY`: one asset is resolved; all required evidence classes are present and fresh; configured thresholds pass; no explicit hard stop exists.
- `REVIEW`: evidence is incomplete, stale, denied, below a warning threshold, conflicting, or impact cannot be assessed.
- `BLOCKED`: authoritative configured evidence contains a hard stop for this stated workflow purpose.
- `UNKNOWN`: no authoritative asset or usable evidence can be resolved.
- `NEEDS_INPUT`: the run lacks one answer needed to resolve scope. It is not a readiness decision.

None of these labels means legal approval, privacy certification, rights clearance, or permission to publish.

#### Brief Writer

- **Inputs:** validated plan, immutable policy decision, normalized evidence and gaps, fixed writing schema, output limits.
- **Outputs:** `BriefDraft` with headline, summary, risks, up to three next checks, and evidence IDs.
- **Authority:** communicates verified facts and gaps in user language. It may use Gemini, but a deterministic template must produce a safe result if Gemini is unavailable.
- **Allowed tools:** no provider, web, MCP, SQL, or side-effect tools. Gemini may be called only through `ModelGateway` with structured output.
- **Failure behavior:** one bounded repair for schema/coverage errors; then deterministic fallback or safe terminal error. It cannot silently omit missing evidence.
- **Evidence:** cited evidence IDs and model/prompt/schema metadata. Prose itself is not evidence.
- **Handoff:** Verifier validates the draft against the policy record and evidence store.

#### Verifier and Safe Projection

- **Inputs:** policy decision, evidence records, draft, run metadata, public/reviewer authorization context.
- **Outputs:** validated `ReadinessBrief`, public evidence projection, reviewer trace projection, or a safe failure.
- **Authority:** enforces schemas, status agreement, evidence-ID validity, recommendation count, redaction, safe URL rules, output length, and mode labels.
- **Allowed tools:** schema validators, redaction, hashing, template fallback, and persistence. No arbitrary model repair loop. One repair request may return to the Writer.
- **Failure behavior:** do not publish invalid prose. Return a deterministic template from verified facts or a terminal failure explaining what could not be validated.
- **Evidence:** verification result, projection version, hashes, final decision, and safe error class.
- **Handoff:** API exposes only the safe projection. Reviewer/operator routes receive a separately authorized redacted projection.

#### Reviewer/operator approval for future side effects

- **Inputs:** exact proposed provider, tool, target, normalized arguments, expected effect, reversibility, packet/result hash, authenticated reviewer identity, expiry, and idempotency key.
- **Outputs:** approval, rejection, expiry, or cancellation record followed by a separate dispatch result. No v1 side-effect path exists.
- **Authority:** an authenticated human approves one exact action. A prompt saying "approved" and a model or provider response saying "safe" are not approval.
- **Allowed tools:** only a separately allowlisted write operation after approval. IBM Flow MCP is a possible future lifecycle seam, not a v1 integration.
- **Failure behavior:** fail closed on missing, expired, changed, denied, or unavailable approval. Replays must not create duplicates.
- **Evidence:** action hash, approver, role, time, expiry, tool/provider, target, arguments hash, outcome, and provider reference.
- **Handoff:** `waiting_for_approval -> approved/rejected/expired -> dispatch` is a future state machine. Revalidate the exact action immediately before dispatch.

#### API, worker, persistence, and observability services

- **API:** deterministic auth, validation, tenant scope, idempotency, run creation, safe reads, SSE, cancel, and retry. It returns `202` and never performs long work inline.
- **Durable worker:** deterministic leases, compare-and-set transitions, deadlines, bounded retries, cancellation checkpoints, model/provider gateway invocation, and terminal projection. A Cloud Tasks delivery may be repeated; a terminal run is a no-op.
- **Persistence:** relational run, step, event, evidence, approval, artifact, and idempotency records. Private object storage is optional for larger redacted artifacts. Persistence is the canonical source of truth, not an agent session.
- **Observability:** structured redacted events and OpenTelemetry-compatible spans for API, queue, worker, model, provider, policy, and projection. It records hashes and metadata, not hidden reasoning or raw secrets.

### Handoff invariants

1. API validation and authorization precede every model and provider operation.
2. Planner output is schema- and scope-validated before coordinator use.
3. Asset resolution precedes all evidence branches.
4. Only code selects provider, endpoint, tenant, manifest, tool, thresholds, and deadlines.
5. Evidence specialists return typed observations; they do not decide or write.
6. The Policy Gate runs before writing and is rechecked after writing.
7. Writer claims must cite evidence IDs or explicitly describe a gap.
8. Verifier and Safe Projection are the only path to the browser result.
9. A provider failure is visible and cannot trigger an unapproved live fallback.
10. Any future side effect is after human approval and idempotency checks, never inside model prose.

### Role-scope and field-of-vision contract

The **field of vision** of a role is the smallest set of context, artifacts, operations, and authority it may inspect or change to produce one user-relevant outcome. It is a product contract, not decorative prompt text. A role must be narrow enough that a reviewer can say what it saw, what it returned, what it could not do, and why its handoff was safe.

The mature role roster and its established names and responsibilities remain the default. This section binds those roles to the Movie-Inator context, bounded artifacts, evidence, policy, and handoff contracts. It does not rename or split a role merely to make the product look more sophisticated. `Request Interpreter` is the optional contextual form of the existing Planner or Intent Agent responsibility. Asset Resolution remains a named sub-step and artifact even when it is implemented inside the Evidence Coordinator.

#### Required role contract

Every product-facing role, deterministic role-like service, provider adapter, and future human role must declare:

1. **One primary outcome:** one result that moves the run toward its user goal. Supporting checks are inputs to that outcome, not extra jobs.
2. **Bounded input artifact and context:** a versioned input schema plus the server-owned identity, workflow, policy, provider, time, and deadline context it may see. It receives no unbounded tool catalog or hidden session state.
3. **One typed output artifact:** one versioned primary artifact. A discriminated union such as plan-or-clarification still counts as one artifact. Events, hashes, status metadata, and evidence IDs may describe it but do not create a second authority.
4. **One authority boundary:** the single fact, decision, or transition this role may own. A role may propose outside its boundary only as rejected or non-authoritative data.
5. **Allowed operations and prohibited actions:** named semantic operations and explicit non-goals. The absence of a prohibition is not permission.
6. **One named handoff:** the next role or service and the artifact it receives. A handoff is not a general conversation transfer.
7. **Failure states:** typed invalid, missing, denied, stale, timed-out, unavailable, canceled, expired, or schema-drift outcomes as applicable. Failure must not be silently converted to success.
8. **Evaluation metrics:** at least one contract metric and one safety or authority metric that can be measured independently.
9. **User-visible disclosure:** the role's job, current status, provenance, and limitation in plain language without chain-of-thought.
10. **Explicit non-goals:** the decisions, tools, domains, and side effects the role will never own in this workflow.

A named role is not automatically an autonomous model agent. A **product-facing role** names a responsibility visible in the user outcome. A **deterministic service** validates, routes, normalizes, decides, persists, or projects with ordinary code. A **provider adapter** translates a stable semantic operation into a provider-specific interface and owns transport, auth, schema pinning, and failure mapping. A **model invocation** is one bounded request to a model backend under a prompt, schema, and budget. A **model instance** is a deployed model identity or backend, which may serve multiple invocations. An **operational component** such as API, worker, persistence, or observability makes the run durable but is not a product-facing agent.

#### Proposed v1 scope budget for the mock-safe brief

These are recommended **v1 defaults**, not universal laws or Captain-approved service guarantees. They make the mock-safe Audience Data Readiness Brief measurable and reviewable. Any expansion requires a measurement showing a safety, authority, evidence, quality, recovery, scale, or traceability benefit, or an explicit Captain decision.

| Budget | Recommended v1 default | Why it exists | Expansion gate |
|---|---:|---|---|
| Primary objectives per role | 1 | Prevents one role from mixing intake, evidence interpretation, writing, and approval. | A paired ablation shows a second objective improves a named metric without reducing independent evaluation clarity. |
| Primary output artifacts per role invocation | 1 | Keeps ownership and provenance unambiguous. Supporting fields, events, hashes, and evidence IDs remain within that artifact. | A second artifact has a distinct consumer, schema, authority, and failure test, and Captain approval if it changes the handoff. |
| Authority boundaries per role | 1 | Prevents a role from both observing evidence and deciding what that evidence authorizes. | A separate boundary prevents a reproducible safety or traceability regression and can be evaluated independently. |
| Semantic operations or tool scope | 1 semantic operation or tool family for a specialist; 5 fixed read operations maximum for the Evidence Coordinator: `resolve_asset`, `describe_asset`, `read_quality`, `read_governance`, and `read_lineage` | Keeps provider access finite, server-owned, and explainable. Actual MCP names stay inside the adapter. | Add an operation only with a manifest entry, a distinct evidence or recovery need, conformance tests, and no broader authority. |
| Model calls | 0 live model calls in the mock-safe default. The optional model-backed path plans for 2 calls per run, one Request Interpreter and one Brief Writer, plus at most 1 bounded repair. | Proves the workflow without credentials and prevents recursive model routing. `FakeModel` exercises the same contracts without an external call. | Compare the added call against the deterministic path for quality, safety, latency, token use, and cost. No five-model deployment is justified by the current workflow. |
| Evidence classes owned by an evidence role | 1 authoritative class per evidence branch: Quality, Governance, or Lineage. The Coordinator may assemble Asset, Quality, Governance, and Lineage into an `EvidenceBundle` but owns no source truth. | Keeps evidence coverage additive and makes missing versus denied versus stale independently visible. | A new class needs a user outcome, authority source, schema, policy mapping, fixture set, and Captain approval before it enters the workflow. |

The budget is deliberately a starting point. Role count, prompt count, model invocation count, model instance count, branch count, and trace span count are independent dimensions. A five-role diagram does not require five prompts or five deployed models, and five prompts do not prove five useful roles. The current recommendation is one shared model backend for the optional Request Interpreter and Brief Writer, with separate prompt IDs, schemas, budgets, and evaluation slices. A model never owns provider choice, evidence authority, policy status, persistence, recovery, or approval.

#### Role selection and scope saturation gates

Retain a named role only when removing it causes a reproducible regression in at least one of safety, authority, evidence coverage, quality, recovery, or traceability, or when it owns a non-delegable human or code boundary. Otherwise merge the responsibility into the smallest existing role and retain only the artifact or trace step that remains useful. The test is an ablation on the same fixtures, provider mode, model backend, budgets, and output schema, not visual prominence in a diagram.

A role is approaching scope saturation when it has any of these signals:

- multiple unrelated primary objectives or several different user promises;
- multiple authorities, especially evidence observation plus policy or approval;
- competing primary outputs or handoffs that cannot be evaluated independently;
- cross-domain tools such as governance reads plus public web, SQL, publishing, or messaging;
- hidden routing, dynamic tool discovery, or model-selected provider and threshold behavior;
- recovery, persistence, or approval decisions hidden inside a language transformation;
- a handoff whose success cannot be tested without inspecting another role's private reasoning;
- repeated retries, repairs, or exceptions that make the role's field of vision impossible to state in one paragraph.

Scope saturation is a merge or split signal, not permission to add another autonomous model. A deterministic service should be split only when failure isolation, scaling, ownership, or evidence authority improves. A model role should be split only when a measured capability, policy, prompt-clarity, or trace-legibility benefit exceeds the decomposition tax of more calls, tokens, latency, cost, state, and injection surface. [MRC: Do not reward unnecessary decomposition; MI: Role contract pattern]

#### Minimal and expanded role sets

The **minimal mock-safe set** is Intake/Request Validator, Evidence Coordinator with Asset Resolution as a sub-step, Policy Gate, Brief Writer using a deterministic template by default, and Verifier/Safe Projection. Recovery is a durable worker responsibility supporting those roles. MockProvider, FakeModel, API, Persistence, and Observability are implementation components. Zero external model calls and zero partner calls are valid for this path.

The **expanded staged set** keeps the same contracts and adds the optional Request Interpreter, independently observable Quality, Governance, and Lineage evidence branches, and a Provider Adapter for the selected read-only seam. Brief Writer may use the same shared model backend as the Request Interpreter. Reviewer is future-only and belongs only to a separately approved side-effect workflow. Expansion increases evidence or operational isolation, not autonomous authority.

| Role | Set, class, and model status | Objectives | Primary output artifact | Authority boundary | Allowed operations | Prohibited scope | Named handoff | Promotion or merge rationale |
|---|---|---:|---|---|---|---|---|---|
| Intake / Request Validator | Minimal and expanded; user-facing deterministic service; must never be an agent | 1 | `RunRequest@1` | Preserves the user's bounded question and purpose | Browser validation, normalization, API submission, rate limits | Provider, tenant, endpoint, tool, model, threshold, status, credentials, SQL, URLs, and side effects | `RunRequest` to API accepted run | Keep because input safety and user intent are a distinct boundary. |
| Request Interpreter, optional | Expanded only; product-facing bounded model transformation or deterministic fixture; may use the shared model backend | 1 | `RequestInterpretation@1` with plan-or-clarification kind | Proposes intent and one clarification, never authority | One structured `ModelGateway` call with no external tools | Asset identity, provider, tool, policy, threshold, status, approval, routing, and action | `RequestInterpretation` to Evidence Coordinator | Merge with Intake unless clarification or intent metrics show a reproducible benefit. |
| Evidence Coordinator with Asset Resolution sub-step | Minimal and expanded; deterministic orchestration service and provider gateway; must never be an agent | 1 | `EvidenceBundle@1` containing `AssetResolution` | Fixes one asset, bounded branch scheduling, normalization, and evidence IDs | Five fixed semantic reads within server scope; bounded parallelism and cancellation checks | Guessing, tenant changes, arbitrary tool discovery, status, mutation, and provider fallback | `EvidenceBundle` to Quality, Governance, Lineage branches or Policy Gate | Keep for sequencing and bundle ownership; retain Asset Resolution as a sub-step rather than a separate agent. |
| Quality | Expanded branch; deterministic evidence service; must never be an agent | 1 | `QualityEvidence@1` | Reports quality observations and freshness | One `read_quality` operation through MockProvider or approved adapter | Rule creation or execution, threshold changes, status, SQL, and writes | Quality evidence to EvidenceBundle and Policy Gate | Keep as a branch contract when independent failure and freshness evaluation matter; otherwise deploy within the Evidence Service. |
| Governance | Expanded branch; deterministic evidence service; must never be an agent | 1 | `GovernanceEvidence@1` | Reports authoritative governance and purpose evidence | One `read_governance` operation and bounded normalization | Privacy approval, classification mutation, policy creation, legal conclusion, and writes | Governance evidence to EvidenceBundle and Policy Gate | Keep separate because authority and missing-evidence semantics differ. |
| Lineage | Expanded branch; deterministic evidence service; must never be an agent | 1 | `LineageEvidence@1` | Reports bounded upstream or downstream impact | One `read_lineage` operation with fixed depth and node limits | Unbounded traversal, schema change, impact approval, and writes | Lineage evidence to EvidenceBundle and Policy Gate | Keep as a branch contract when truncation, timeout, or scale isolation is measurable; otherwise deploy within the Evidence Service. |
| Policy Gate | Minimal and expanded; deterministic authority service; must never be an agent | 1 | `PolicyDecision@1` | Sole owner of `READY`, `REVIEW`, `BLOCKED`, or `UNKNOWN` | Pure policy code, configured thresholds, freshness rules, and versioned clock | Model calls, provider calls, explanation style, inferred rules, and side effects | `PolicyDecision` to Brief Writer and Verifier | Non-negotiable separate boundary because observation cannot approve itself. |
| Brief Writer | Minimal and expanded; user-facing bounded model transformation or deterministic template; may use the shared model backend | 1 | `BriefDraft@1` | Explains verified facts, gaps, risks, and up to three checks | One structured `ModelGateway` call with normalized evidence only, or deterministic template | Status, evidence creation, provider/web/MCP/SQL tools, approval, and execution | `BriefDraft` to Verifier/Safe Projection | Keep for language value; merge to a template when model quality does not beat the deterministic path. |
| Verifier / Safe Projection | Minimal and expanded; deterministic final service; must never be an agent | 1 | `VerifiedProjection@1` containing public and reviewer views | Enforces schema, claim coverage, status agreement, redaction, and provenance | Validation, hashing, redaction, safe template fallback, persistence | Status override, open-ended repair, raw prompts, secrets, unsafe HTML, and unapproved URLs | `VerifiedProjection` to API and authorized reviewer route | Keep separate because a writer cannot be its own verifier and it is the only browser boundary. |
| Recovery / Worker | Minimal and expanded; operational deterministic component; must never be an agent | 1 | `RecoveryEvent@1` containing the durable state transition | Owns leases, deadlines, retry classification, cancellation, expiry, and child runs | Queue, persistence CAS, clock, bounded retry, cancellation checkpoints | Silent fallback, deleting history, status invention, untracked work, and remote cancellation claims | `RecoveryEvent` to user/API and the next worker step | Keep in the worker because lifecycle recovery is not a reasoning job. |
| Reviewer, future-only | Future side-effect workflow; authenticated human role plus approval service; must never be an agent | 1 | `ApprovalRecord@1` | Approves or rejects one exact proposed effect | Review an action digest and approve, reject, or let it expire | Broad approval, changed arguments, v1 writes, and model-delegated approval | `ApprovalRecord` to a separately gated dispatcher | Do not include in the read-only MVP; add only with identity, policy, audit, idempotency, and reconciliation controls. |
| Provider Adapter | Expanded staged component; deterministic adapter; must never be an agent | 1 | `ProviderObservation@1` | Maps one approved semantic operation to one provider under a pinned manifest | Transport, auth reference, semantic mapping, schema validation, redaction, timeout, and read-only checks | Model-selected tools, tenant override, unallowlisted operations, raw catalog exposure, and mutation | Provider observation to Evidence branch | Reuse mature provider surfaces behind an adaptation layer; add a custom adapter only when its conformance suite passes. |
| API | Minimal and expanded; deterministic service; must never be an agent | 1 | `RunAccepted@1` | Auth, input bounds, tenant scope, idempotent run creation, and safe reads | HTTP validation, persistence transaction, SSE, polling, cancel, and retry | Long-running work inline, model/provider authority, and unsafe projection | `RunAccepted` to durable Worker | Keep as the web boundary, separate from orchestration authority. |
| Persistence | Minimal and expanded; deterministic store; must never be an agent | 1 | `StoredRunRecord@1` | Canonical runs, artifacts, evidence, events, hashes, and retention metadata | Transactional reads/writes, CAS, append-only events, and scoped retrieval | Hidden reasoning, unbounded raw payload retention, policy decisions, and tool discovery | Stored records to Worker, API, and Observability | Keep as source of truth; never replace it with an agent session or memory feature. |
| Observability | Minimal and expanded; operational deterministic pipeline; must never be an agent | 1 | `TraceRecord@1` | Redacted operational trace and metrics correlation | Safe events, spans, hashes, latency, attempts, and error classes | Secrets, raw private rows, chain-of-thought, or user-facing policy authority | Trace record to reviewer-safe Trace and operations | Keep for recovery and evaluation; it observes the product but does not decide it. |

This matrix applies the contract to both role sets without changing role identity by phase. The expanded set may expose more branch detail, provider connectivity, recovery depth, or reviewer metadata, but it may not silently give a role a new authority at runtime.

#### Model, role, branch, and handoff glossary

| Term | Meaning in this PRD |
|---|---|
| **Role** | A named responsibility and authority boundary in the user outcome. It may be implemented by a service, human, adapter, or bounded model transformation. |
| **Responsibility** | The outcome a role must reliably produce; it is not a list of every action the implementation can perform. |
| **Job specification** | The role's bounded contract: objective, inputs, output, authority, operations, failure states, metrics, disclosure, and non-goals. Adding job specifications expands scope and must not be mistaken for capability. |
| **Model invocation** | One request and response against a model backend under one prompt, schema, context, and budget. |
| **Model instance** | A deployed model identity, endpoint, or backend that may serve multiple role invocations. |
| **Branch** | A bounded independently observable path, such as Quality, Governance, or Lineage, with one output and terminal failure state. |
| **Service** | Deterministic application or operational code that owns validation, state, policy, persistence, projection, or transport. |
| **Provider adapter** | A deterministic translation and enforcement boundary between a stable semantic operation and a provider or MCP interface. |
| **Handoff artifact** | The versioned typed output passed to one named next owner, with provenance, status, and an owning authority. |

## 6. Google platform assumptions versus product-owned contracts

### Google assumptions to validate later

Current research uses **Gemini Enterprise Agent Platform** as the current Google platform family, with Agent Studio, ADK, Agent Runtime, Agent Registry, Agent Gateway, and evaluation/observability surfaces. The repository's existing "Google Cloud Agent Builder" wording is intent-level shorthand, not a selected current API. The exact Google runtime, region, SDK versions, model IDs, billing, and deployment path remain Captain decisions. [MRC: Evidence ledger G1-G6; TIV2: Current official evidence rechecked]

If selected, ADK may run a small fixed graph, and Agent Runtime may host that graph. The product must not put durable run state, policy authority, tenant selection, or safe projection inside an agent session. The application remains authoritative even if Google supplies execution, tracing, or evaluation.

Gemini function calling is an application protocol: the model proposes a function and arguments, and the application executes it. Structured output still requires semantic validation. The product therefore uses Gemini only behind `ModelGateway`, with shallow versioned schemas and no raw provider catalog in the prompt. [MRC: Evidence ledger G3-G4]

Agent Gateway may add defense in depth if the selected deployment can register the approved HTTP/MCP endpoint. Its documented default-deny and tool-level read-only/read-write policies are useful, but they do not replace app-level semantic authorization, tenant checks, manifest pinning, evidence normalization, or product policy. The research found no official Google out-of-the-box IBM watsonx connector in the searched official sources. The honest composition is an application-owned backend or approved MCP path, not a native Google-IBM integration claim. [MRC: Evidence ledger G2-G3, I1; TIV2: Current official evidence rechecked]

### Product-owned contracts that must not depend on Google naming

The following remain stable if Google changes product names or hosting:

- `RunRequest`, `PlanningOutput`, `EvidenceBundle`, `PolicyDecision`, `BriefDraft`, `ReadinessBrief`, `RunEvent`, and error schemas;
- the role and authority matrix, state machine, policy vocabulary, evidence fields, provenance labels, and approval record;
- `ModelGateway` and `EvidenceProvider` interfaces;
- durable API/worker state, idempotency, cancellation, retries, safe projections, browser events, and retention controls;
- the immutable provider capability manifest and no-side-effect v1 flag.

## 7. IBM and partner boundary

### IBM WDI: one conditional read-only staging seam

IBM watsonx.data intelligence is the recommended **candidate** for one internal staging seam because its pinned public tool reference documents asset search/details, data quality, glossary/governance artifacts, and lineage. This proves a possible tool surface, not this project's tenant access, endpoint, entitlement, synthetic asset, authentication, data-sharing approval, or media-specific truth. No IBM call is enabled by this PRD. [MRC: Partner decision table; TP: IBM-first partner boundary; TIV2: IBM MCP]

The semantic interface is:

```text
EvidenceProvider
  capabilities() -> CapabilityManifest
  resolve_asset(context, query) -> AssetResolution
  describe_asset(context, asset) -> AssetEvidence
  read_quality(context, asset, window) -> QualityEvidence
  read_governance(context, asset, purpose) -> GovernanceEvidence
  read_lineage(context, asset, window) -> LineageEvidence
```

Candidate WDI mappings, subject to a tenant contract test and manifest approval:

| Semantic operation | Candidate IBM operation | v1 boundary |
|---|---|---|
| `resolve_asset` | `search_asset` | Fixed project/catalog scope; bounded result count; one exact result or `NEEDS_INPUT`. |
| `describe_asset` | `get_asset_details` | Metadata needed for identity and evidence; redact unnecessary owner/contact data. |
| `read_quality` | `get_data_quality_for_asset` | Read observations only; never run or create a quality rule. |
| `read_governance` | `get_asset_glossary_artifacts`, optionally `search_governance_artifacts` | Read assigned artifacts only; no classification or policy mutation. |
| `read_lineage` | `search_lineage_assets`, `convert_asset_to_lineage_id`, `get_lineage_graph` | Bounded depth and node count; visible truncation. |

The manifest must pin provider version, endpoint reference, tenant/project/catalog scope, transport, auth mode, semantic-to-actual mapping, input/output schema hashes, read-only annotation, timeouts, limits, and manifest hash. Any drift, unknown operation, schema mismatch, missing scope, or unexpected write annotation fails closed. Do not import or expose SQL, imports, publish, role changes, rule creation, data product mutation, or deletion for this workflow.

IBM's general MCP documentation describes limitations including manual tool refresh and no cancellation for normal imported tool execution. A cancellation request therefore stops not-yet-started work, waits for an in-flight call to return, and discards the late response if cancellation has won. This is not a claim about a particular tenant.

### IBM Flow MCP: future alternative

IBM Flow MCP is documented as a Public Preview surface with Streamable HTTP, synchronous/asynchronous execution, status, sessions, authorization, elicitation, and management operations including cancellation. It could become a future named-flow adapter for an approval or long-running review workflow, if a specific flow, tenant, tool schema, and preview posture are supplied and tested. It is not combined with WDI in v1 and does not prove a media rights or publishing flow exists. [MRC: Partner decision table; MR: E13-E16]

### Other listed partners

| Partner | Product role if later selected | Boundary |
|---|---|---|
| Parallel | Optional public-source evidence worker | Public sources are not private governance, rights, or catalog authority. Requires a Captain-approved source policy and separate evidence authority class. |
| ClickHouse | Separate audience-pulse analytics workflow | Use read-only, parameterized query contracts; do not combine analytics with readiness or accept free-form SQL. |
| Grafana | Operational observability and health surface | Keep traces and operational metrics out of customer evidence; no v1 workflow dependency. |
| Replit | Optional build/hosting or reviewed developer artifact surface | Its documented tools operate on Replit apps, not media evidence. Never present it as a source of truth. |

There is no hidden fallback between these partners. A different partner requires a product decision and its own semantic contract and evaluation set.

## 8. Provenance and evidence requirements

### Provenance modes

Model provenance and provider provenance are independent axes. Store and display both.

| Actual mode | Required label | Meaning | Prohibited implication |
|---|---|---|---|
| Fake model plus MockProvider | `Demo evidence` or `Deterministic mock` | Fixture data and deterministic output; no external call | Current partner observation or model judgment |
| Stored earlier result | `Recorded replay` plus capture date | Immutable prior response/trace | Current observation |
| Live Gemini plus MockProvider | `Gemini-backed / MockProvider` | Hosted model call with synthetic provider | Live IBM or current external data |
| Live Gemini plus approved IBM staging | `Gemini-backed / IBM WDI staging` | Both backend calls were live in gated staging | Public production access, legal/rights approval |

A label such as `model-backed replay` is insufficient because it conflates model and provider axes. The browser must never call Gemini or IBM directly. A live provider label is permitted only when the server trace proves the configured provider call occurred.

### Evidence record

Every user-visible factual claim, risk, or check result maps to an evidence record or is explicitly labelled as an evidence gap. An evidence record contains at least:

- `evidence_id`, run ID, check kind, and status: `complete`, `missing`, `denied`, `stale`, `timed_out`, `unavailable`, or `invalid`;
- normalized facts with units and a redaction class;
- provider ID, provider backend, semantic operation, source reference, and authority class;
- `observed_at`, `fresh_until` or freshness rule, and timezone;
- content/response hash, schema/provider version, policy rule/version, and provenance mode;
- optional safe source link only when the source policy allows it;
- raw payload reference only in private, short-lived, explicitly approved incident capture. Default is no raw payload.

A missing record is not a negative record. An unavailable or denied source cannot be rendered as no risk. A lineage truncation, freshness failure, or source conflict remains visible.

Public evidence shows the claim, status, authority/source label, observation and freshness, normalized facts, policy reference, and safe hash. Reviewer evidence adds redacted request/response summaries, actual tool name, manifest/version hashes, latency, retry history, and state transitions. Neither surface exposes chain-of-thought or bearer tokens.

## 9. Approval boundary for future writes

V1 has no write-capable tool and therefore no approval interruption in the primary path. The approval boundary is specified now so a future side effect cannot be smuggled into the model graph.

For any future submit, publish, edit, send, export, role change, deployment, paid action, or irreversible operation:

1. Code constructs the exact provider, tool, target, normalized arguments, expected effect, reversibility, result/payload hash, and expiry.
2. Code verifies user and reviewer authorization and confirms the operation is in a separately approved manifest.
3. The browser shows that exact proposed effect in a human-readable approval card.
4. An authenticated reviewer approves that exact action hash, or rejects/lets it expire.
5. Code revalidates policy, identity, hash, provider availability, and idempotency immediately before dispatch.
6. The adapter dispatches once with an idempotency key and records the provider result or unknown result.
7. The audit record stores approver, action, arguments hash, timestamps, outcome, retry/cancellation history, and provider reference.

If the provider returns an unknown result after dispatch, the system must not blindly retry a potentially duplicated action. It moves to an explicit `UNKNOWN` action outcome and requires a provider lookup or operator resolution chosen by a future Captain decision. This is distinct from the read-only readiness `UNKNOWN` decision.

## 10. Recovery, cancellation, retry, and unknown semantics

### Persistence and job execution

The recommended production shape is application API plus durable worker, with a relational store and a queue. A possible Google deployment is Cloud Run API, Cloud Tasks, Cloud Run worker, and Cloud SQL PostgreSQL, but these are platform options, not product contracts. Cloud Run Jobs are better reserved for evaluation and batch replay. [TIV2: Architecture options and selection; TP: Request lifecycle and orchestration]

Core records:

- `run`: tenant/subject, request hash, workflow, provider/model modes, state, decision, deadline, cancellation flag, parent run, policy/schema/manifest versions;
- `run_step`: step name, attempt, lease, state, input/output hashes, versions, latency, error class;
- `run_event`: append-only sequence, safe event type, step, display text, safe payload, timestamp;
- `evidence`: normalized facts, branch status, provenance, freshness, source hash, redaction class, retention expiry;
- `idempotency_key`: tenant plus key hash, request hash, run ID, expiry;
- `artifact`: private object reference, MIME type, hash, owner, retention, and authorization policy;
- `approval_record`: reserved for future side effects, exact action/arguments hash, approver, expiry, decision.

The worker receives only `run_id`, claims work with compare-and-set or a lease, checks terminal state/cancellation/deadline, and checkpoints each step. A queue redelivery or restart is safe. The API creates the run, event, idempotency record, and queue task in a transaction where possible.

### Retry rules

Initial internal budgets are recommendations to benchmark, not Google or IBM guarantees:

- API acceptance p95 target under 1 second;
- Planner target 10 seconds;
- each read branch target 8 seconds;
- evidence fan-out target 15 seconds wall clock;
- Writer plus verifier target 12 seconds;
- total run deadline 90 seconds;
- maximum two attempts for a transient read/model transport error, with bounded backoff and jitter;
- retry only timeout, connection reset, 429, 502, 503, and 504 for read-only operations;
- do not retry invalid input, 401, 403/policy denial, schema drift, malformed response, or hard stop;
- at most one Writer repair request; then use a deterministic template or safe failure;
- maximum three parallel evidence calls per run unless a later capacity decision changes it.

These values are implementation targets and must not be presented as service guarantees or pricing claims.

### Idempotency

A repeated `(tenant, idempotency_key_hash)` with the same request hash returns the original run and does not enqueue duplicate work. Reusing a key for a different request returns `409 IDEMPOTENCY_KEY_REUSED`. Retry is an explicit child run with a new key; the original remains immutable. Step claims, evidence IDs, and terminal projections are idempotent. No late task can overwrite a terminal run.

### Cancellation

`POST /cancel` records intent transactionally. The worker checks before every model/provider operation and after every call. It prevents queued and not-yet-started branches. A provider that does not support cancellation may finish; the UI remains `Cancellation requested`, then the worker discards the late result if the run is canceled. The system never claims a remote operation stopped when it only stopped waiting for it.

### Partial and unknown results

- One denied, stale, unavailable, invalid, or timed-out branch remains visible and normally produces `REVIEW`.
- All required evidence absent or unusable produces `UNKNOWN`.
- An explicit authoritative hard stop produces `BLOCKED`.
- Complete evidence with unavailable Gemini Writer uses a deterministic template and retains the policy decision.
- A provider outage does not silently switch providers. The user may explicitly start a separate `Demo evidence` run.
- A hard deadline produces a safe partial `REVIEW` or `UNKNOWN` projection if possible. If persistence or validation prevents a safe projection, use `expired` with retry.
- A future side-effect call with an unknown external result requires lookup or operator resolution and must not be blindly retried.

## 11. Security, privacy, retention, and browser requirements

### Authentication and tenancy

- Anonymous access is allowed only for isolated synthetic MockProvider fixtures with no partner or private data. Apply rate limits and short retention.
- Any real Gemini or IBM run requires an explicitly selected authentication model. Verify issuer, audience, expiry, subject, tenant, workspace, and role server-side.
- Tenant, provider, endpoint, project/catalog, asset scope, and reviewer role come from verified identity and server configuration. Client text and model output cannot override them.
- Every run, evidence, event, artifact, and endpoint query is tenant-scoped. Cross-tenant IDs return the same safe not-found behavior as unknown IDs.
- Prefer runtime identity and least privilege for shared synthetic staging. Delegated/OBO IBM identity remains open if per-user permissions or attribution is required.
- Cookie-authenticated cancel/retry/approval routes require CSRF protection. Use strict CORS, CSP, frame, content-type, and origin policies.

### Secrets and untrusted content

- Store model credentials, IBM endpoint references, OAuth secrets, database credentials, and signing keys in an approved secret store. No credential enters browser state, prompt text, SSE payload, logs, artifacts, or error messages.
- Separate local, CI, mock staging, IBM staging, and production identities and secrets. CI must run without external credentials and prove no external calls.
- Treat user text, media metadata, provider descriptions, MCP tool descriptions, MCP results, public web content if later approved, and model output as untrusted data.
- Keep evidence in typed data fields, not instructions. Use fixed operations, endpoint and tenant allowlists, argument validation, response size limits, and output escaping. Model safety controls are defense in depth, not authorization.
- Render all model/provider text as text. Reject unsafe URL schemes and unapproved links. Do not store or show hidden reasoning.

### Retention assumptions

The following are recommended defaults, not Captain-approved policy:

- public mock request/result/events: 24 hours;
- staging normalized evidence and redacted traces: 7 days;
- authenticated production result metadata: 30 days or less if policy requires;
- raw provider payloads: disabled by default; incident capture only in private staging with encryption, access logging, redaction, and short expiry;
- artifacts: private, encrypted, tenant-scoped, hash-addressed, and accessed through short-lived authorization.

Data residency, deletion SLA, export, prompt/response retention, raw-payload debugging, quotas, and token/cost ceilings remain open Captain decisions.

### Accessibility and browser

The browser must meet the following implementation requirements:

- semantic landmarks, one `h1`, associated labels, visible focus, keyboard-only operation, and first-error focus;
- status communicated through text and icon, never color alone, with WCAG AA contrast target;
- polite `aria-live` for phase changes, `aria-busy` for indeterminate work, and no raw token stream;
- evidence is a non-modal drawer on desktop where practical and a true labelled dialog on mobile with focus entry, containment, Escape close, and focus return;
- support 200% zoom, reduced motion, high contrast where available, VoiceOver/Safari, and NVDA/Firefox;
- no page-level horizontal overflow or clipped recovery action at 320, 390, 768, 1024, and 1280 CSS pixels;
- use responsive evidence cards or controlled table scrolling, never clipped facts;
- Playwright or equivalent browser coverage for Chromium, Firefox, and WebKit, including mobile emulation, refresh, SSE loss, polling fallback, cancellation, and retry.

## 12. Evaluation and metrics

Build a golden set before any real partner access. A minimum demo set is nine cases; a stronger pre-launch set is at least 30 cases covering pass, conflict, missing, ambiguous asset, denied, stale, timeout, cancellation, retry, malformed model output, injection, schema drift, duplicate submission, and unknown asset.

Track these required safety and product metrics:

- deterministic Policy Gate agreement with the oracle: 100%;
- visible factual claim to valid evidence-ID coverage: 100%;
- missing/denied/stale/timed-out branch visibility: 100%;
- unallowlisted or mutating provider calls: zero;
- false-`READY` rate on hard-stop and missing-evidence safety fixtures: zero;
- cancellation late-projection rate: zero;
- duplicate run/projection rate for repeated idempotency key: zero;
- clear-case asset resolution accuracy: target at least 90% before staged expansion;
- p95 time to first progress, p95 mock completion, staged completion, retry count, failure-state distribution, token/call budget, and cost estimate;
- clarification correctness, browser completion, refresh/reconnect success, evidence comprehension, and accessibility defects.

A successful paragraph or screenshot is not sufficient. Evaluate final output and trajectory/tool use. Google evaluation can supplement local policy, contract, browser, and security tests, but it does not replace them. [MRC: Evaluation; TIV2: Test strategy]

## 13. Staged implementation roadmap

This roadmap is a product requirement sequence, not an instruction to build in this documentation task. The numbered phases below sit inside three explicit product journey stages. Role identities, narrow contracts, output schemas, authority boundaries, and named handoffs remain stable across stages. Only orchestration policy, evidence depth, provider connectivity, reliability targets, approval boundaries, and permitted side effects may mature, and each change must be disclosed and phase-gated rather than selected opaquely at runtime.

### Early, middle, and late product journey

| Stage | Entry criteria | Permitted maturity | Exit criteria |
|---|---|---|---|
| **Early: mock and replay** | Workflow and policy remain explicit proposals or Captain decisions; role contracts, handoff artifacts, fixtures, no-side-effect flag, and role-scope budget are documented. | Mock or recorded-replay execution, minimal role set, deterministic Policy Gate, transparent evidence and gaps, zero consequential external writes, and zero required live model or partner calls. | A first-time user completes pass, review, unknown, clarification, and recovery runs; the golden set and role ablations measure policy agreement, claim coverage, recovery, traceability, and scope saturation; no unallowlisted or mutating path exists. |
| **Middle: guarded operational use** | Early exit criteria pass; a provider seam, identity model, manifest, schema suite, retention posture, and rollback path are Captain-approved for the selected staging environment. | Optional shared model backend, guarded provider adapters, richer branch recovery, measured latency and reliability targets, internal allowlists, and reviewer/operator trace. The role contract does not change when a provider becomes live. | Mock and guarded-provider semantics match; contract, security, redaction, drift, recovery, identity, and reconciliation tests pass; measured operational use demonstrates value without false-ready, unallowlisted-call, duplicate, or provenance failures. |
| **Late: scale and approved effects** | Middle exit criteria pass and a new capability has a user outcome, stable contract, provenance, privacy controls, evaluation set, and measured value. | Scale, collaboration, artifact/project continuity, reusable role packs, provider/plugin ecosystem, and selectively approved side effects only after identity, policy, security, audit, approval, idempotency, and reconciliation controls exist. | Scale and recovery targets are measured, historical context remains attributable, partner/plugin boundaries are revocable, and every side effect has exact action binding, human authority where required, durable audit, and unknown-result reconciliation. |

A phase changes execution policy, not role identity or authority. Do not let a live flag silently turn a deterministic branch into an agent, add a second objective, widen a tool scope, or make a model output authoritative. If a role must change its field of vision, treat that as a new contract and rerun the role selection, scope-saturation, and evaluation gates.

### Phase 0: Captain decisions and platform spike

Confirm the workflow, policy, source boundary, identity, retention, Google surface, IBM seam, and future side-effect posture. If Google is selected, run a trivial local ADK or non-public Agent Runtime spike to validate current names and version assumptions. No partner credential or live endpoint is needed for this gate.

**Exit:** decisions are recorded, platform assumptions are separated from domain contracts, the fake path is specified, and any unresolved numeric role-scope budget is registered as a Captain decision rather than silently promoted to policy.

### Phase 1: contracts and deterministic mock engine

Define versioned schemas, the role contracts and handoff artifact chain, `MockProvider`, `FakeModel`, normalizer, policy oracle, verifier, redaction, fixtures, state machine, and local API/worker interfaces. Run the minimal-versus-expanded role ablation with no Google, IBM, or partner dependency.

**Exit:** all statuses and fault cases have deterministic expected results and no-side-effect tests; every retained role has one objective, one output, one authority, one handoff, and an independently measurable reason to exist.

### Phase 2: usable browser vertical slice

Implement Ask, Clarify, Role Run, Decision, Evidence, Recovery, the on-demand Role Map, `202` API integration, event cursor/polling, refresh, retry child runs, cancellation intent, safe provenance labels, accessibility, and responsive acceptance. Keep Trace and Setup role-gated or documented, not in public navigation. Lavish or equivalent review must show bounded handoffs and must not imply one card equals one agent.

**Exit:** a first-time user completes pass, review, unknown, clarification, and recovery mock runs without credentials, and each visible claim opens the matching evidence or explicit gap.

### Phase 3: optional Gemini with MockProvider

Add a server-side `GeminiApiBackend` or selected ADK graph through `ModelGateway`, keeping `FakeModel` as the deterministic regression path. Use at most the proposed Request Interpreter and Brief Writer calls, record model/prompt/schema hashes, and run trajectory evaluation. Provider remains mock.

**Exit:** Gemini cannot select provider/tool/status; malformed and unsupported output is safely handled; quality, scope, provenance, and token/call budget gates pass. A second model instance requires a measured benefit and Captain approval.

### Phase 4: conditional IBM WDI staging

Only after Captain approval, tenant access, endpoint/auth, synthetic data, exact tool schemas, capability manifest, redaction, and contract tests exist, implement `IbmWdiMcpProvider` for the five semantic reads. Enable only for an internal allowlist. Do not add Flow MCP simultaneously.

**Exit:** WDI staging produces the same normalized semantics as MockProvider, schema drift fails closed, and no mutating operation is reachable. Public IBM enablement remains a separate decision.

### Phase 5: future alternatives and side effects

Evaluate Parallel for a separately approved public-source workflow, ClickHouse for a separate audience-pulse workflow, Grafana for operations, and Replit for build/host support. Treat contextual memory, artifact and project continuity, feedback loops, reusable role packs, collaboration, and partner/plugin capabilities as late ecosystem opportunities with their own user outcome, stable contract, provenance, privacy, and value measurement. A future IBM Flow named flow or release-readiness submission requires a separate approval state machine, action hash, human approval, idempotency, unknown-result lookup, and evaluation set.

**Exit:** each later workflow or ecosystem capability is independently selected, measurable, revocable, and does not weaken the first workflow's contracts.

## 14. PRD-level acceptance criteria

The implementation satisfies this PRD only when all of the following are true:

1. The public experience presents the Audience Data Readiness Brief as a recommendation or Captain-selected workflow, never as a generic swarm.
2. A first-time user can complete a deterministic mock run without Google, IBM, partner credentials, or external side effects.
3. The request contract rejects unknown fields and client-selected provider, endpoint, tool, model, threshold, SQL, approval, and publish values.
4. `POST /v1/runs` returns `202`, creates one durable run, and does not perform long model/provider work inline.
5. Progress is monotonic, safe, refreshable, replayable by event ID, and available through polling fallback.
6. Ambiguous asset resolution produces `NEEDS_INPUT` and no downstream evidence call before clarification.
7. Quality, Governance, and Lineage are distinct bounded evidence branches with explicit complete, missing, denied, stale, timed-out, unavailable, invalid, or skipped outcomes.
8. `READY`, `REVIEW`, `BLOCKED`, and `UNKNOWN` are computed by deterministic code and cannot be changed by Gemini, a provider response, or a user-provided field.
9. Every factual user-visible claim or risk cites valid evidence, or is clearly labelled as an evidence gap.
10. Result shows the resolved asset, decision, explanation, all bounded next checks, coverage, policy version, and exact model/provider provenance.
11. The product never describes readiness as legal, privacy, rights, or publishing approval.
12. Writer failure produces a deterministic evidence-based template or safe terminal error, never invented claims.
13. Retry is bounded, creates a new child run, and preserves the original. Duplicate idempotency keys do not duplicate work or artifacts.
14. Cancellation prevents queued and not-yet-started work and discards late results from an uncancellable operation without claiming remote cancellation.
15. Public evidence and reviewer trace are separately authorized projections. Neither contains credentials, raw private rows, unsafe HTML, arbitrary URLs, or chain-of-thought.
16. The browser meets keyboard, screen reader, focus, contrast, responsive, reduced-motion, and evidence-dialog requirements at the stated matrix.
17. Mock, replay, model-backed/mock-provider, and live staged-provider labels are accurate and never conflated.
18. IBM is considered integrated only after a Captain-approved WDI seam, tenant/endpoint/auth, exact read-only manifest, synthetic data, contract suite, redaction checks, and internal enablement pass. Until then it remains conditional and disconnected.
19. No v1 path can submit, publish, mutate, export, send, purchase, deploy, change roles, or otherwise create a side effect.
20. Evaluation reports policy agreement, claim coverage, false-ready rate, unallowlisted/mutating calls, cancellation correctness, duplicate rate, latency, and failure-state distribution.
21. Every named role or role-like service declares one primary outcome, bounded input/context, one typed output artifact, one authority boundary, allowed operations, prohibited actions and non-goals, one named handoff, failure states, evaluation metrics, and user-visible disclosure.
22. The role-scope gate retains a role only when removal causes a reproducible safety, authority, evidence coverage, quality, recovery, or traceability regression. Multiple unrelated objectives, authorities, outputs, cross-domain tools, hidden routing, or unevaluable handoffs are treated as scope saturation.
23. The mock-safe Audience Data Readiness Brief uses the proposed v1 scope budget as a measured default: one objective, one primary output, one authority, bounded semantic operations, zero required live model calls, and one evidence class per evidence branch. Any expansion is measured or Captain-approved and is not presented as a universal law.
24. Minimal and expanded role sets preserve the mature role names and responsibilities. Only the optional Request Interpreter and Brief Writer may use one shared model backend; API, worker, persistence, observability, provider adapter, evidence branches, Policy Gate, Verifier, and Recovery are not autonomous agents.
25. Role count, prompt count, model invocation count, model instance count, and trace span count are reported separately. No five-model deployment is justified by this workflow without a distinct measured need and Captain decision.
26. Early, middle, and late phase entry and exit criteria are recorded. Phase changes may mature orchestration, evidence depth, provider connectivity, reliability, approval, and side-effect policy, but may not silently change role authority or field of vision.
27. The Lavish journey shows role contracts and typed handoffs rather than a swarm, keeps Setup operator-only, keeps Reviewer future-only, links every displayed claim to its matching evidence or gap, and labels ecosystem direction as future and phase-gated.

## 15. Open Captain decisions

Recommendations below are explicit proposals. They are not resolved decisions and must not be encoded as hidden defaults that imply approval.

| Decision area | Open Captain choice | Recommended default | Status and impact |
|---|---|---|---|
| Workflow | Audience Data Readiness Brief, release-readiness packet, video ideation, or another first workflow | Audience Data Readiness Brief | **Open.** Changes the user promise, evidence classes, fixtures, and evaluation set. Existing research keys include `workflow-policy` and `workflow`. |
| Readiness policy | Exact freshness windows, quality thresholds, hard-stop codes, and wording | Deterministic four-value oracle above; no legal/privacy/rights meaning | **Open.** Changes `READY` versus `REVIEW` and must be owned by a product/policy authority. |
| Public identity | Anonymous mock-only public mode versus authenticated public runs | Anonymous isolated mock; authentication for any real provider | **Open.** Changes tenancy, rate limits, reviewer access, and data handling. |
| Source policy | Fixture and explicitly approved sources versus live public research through Parallel or Google grounding | Fixture plus approved sources for v1; no public browsing | **Open.** Changes trust, citations, privacy, cost, and prompt-injection surface. |
| Google surface | Local fake, ADK, Agent Runtime, Agent Studio/Managed Agents API, region, SDK/model versions | Fake first, then pinned ADK/selected runtime after spike | **Open.** Changes deployment, auth, observability, and resumability. |
| IBM seam | No IBM, one WDI read-only seam, or a named Flow MCP seam | At most one WDI read-only staging seam; Flow is future alternative | **Open.** Requires tenant, entitlement, endpoint, auth, tool schemas, synthetic data, and terms. No integration is implied. |
| IBM identity | Shared least-privilege synthetic staging identity versus delegated/OBO | Shared synthetic identity for internal staging only until per-user need is proven | **Open.** Changes reviewer attribution and tenant enforcement. |
| Reviewer identity | Browser user, IBM-authenticated user, or simulated persona for future approval | No v1 approval; choose explicitly before any live write | **Open.** Changes who can authorize and what audit means. |
| Evidence surface | Public depth, reviewer roles, source links, raw samples, and trace visibility | Public normalized facts/gaps; reviewer redacted metadata; raw payloads off by default | **Open.** Changes privacy, supportability, and UI scope. |
| Retention and budget | Prompt/evidence retention, residency, deletion, token/cost ceilings, concurrency, quotas | Short retention, no raw payloads, hard call/token/deadline budgets, fail closed | **Open.** Changes infrastructure and compliance posture. |
| Role-scope budget | Whether the proposed one-objective, one-output, one-authority and operation/model/evidence defaults become Captain-approved v1 policy, and what measured expansion threshold applies | Use the section's defaults as a testable proposal; measure before expanding | **Open.** Registered through decision-hold-lifecycle as `role-scope-budget`; changes role contracts, topology evaluation, prompts, calls, and phase gates. |
| Future side effect | Whether to add review submission, publish, export, or another write workflow | No v1 side effect; revisit as separate workflow with exact approval hash | **Open.** Changes state machine, approval, unknown-result, and idempotency requirements. |

These choices correspond to the unresolved Captain records in the durable research backlog, including `gemini-agents-market-research-decision-*`, `gemini-agents-technical-plan-decision-*`, `gemini-agents-fullstack-implementation-research-decision-*`, and `gemini-agents-market-inspiration-implementation-decision-*`. This PRD consolidates them into product areas without resolving them.

## 16. Research and source appendix

### Evidence labels

- **Official capability fact:** a product or protocol document states a capability or limitation. It still requires version, tenant, and contract validation.
- **Partner claim:** a listed partner documents its own surface. It proves a possible seam, not project access or domain fit.
- **Observed market pattern:** a vendor product or announcement demonstrates a user-facing pattern. It is not independent ROI evidence.
- **Recommendation:** a proposed product or technical behavior derived from consistent evidence.
- **Hypothesis:** a claim that needs user, fixture, latency, or evaluation validation.
- **Captain decision:** an unresolved product, identity, policy, source, runtime, partner, or retention choice.

### Durable research set

The following reports were read as evidence for this PRD. They are durable artifacts outside this repository and should remain the traceable research record:

- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-market-research-consolidation/report.md` - master synthesis, current market position, evidence ledger, recommended graph, status/provenance semantics, and differentiated MVP.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-technical-implementation-research-v2/report.md` - current Google/IBM technical constraints, contracts, state machine, API, deployment, security, reliability, and acceptance gates.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-market-research/report.md` - partner comparison, useful orchestration patterns, release-readiness alternative, and evidence E1-E25.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-fullstack-implementation-research/report.md` - full-stack vertical slice, browser contract, provider seam, fixtures, and delivery plan.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-technical-plan/report.md` - initial typed workflow, durable runtime, IBM candidate mapping, state/retry/approval plan, and Captain decisions.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-market-inspiration-implementation/report.md` - screen-by-screen critique, provenance and public/reviewer surfaces, responsive/accessibility requirements, and ranked mock-safe roadmap.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-market-inspiration-research-v2/report.md` - fresh market patterns for reviewed plans, role contracts, evidence history, recovery, role maps, and phase-gated ecosystem opportunities.
- `/Users/jacksonloh/firstmate-clean/data/gemini-agents-role-architecture-critique/report.md` - role necessity, topology ablation, scope saturation, model-count independence, and deterministic-versus-agent dispositions.
- `/Users/jacksonloh/firstmate-clean/data/captain.md` and the Gemini Agents entries in `/Users/jacksonloh/firstmate-clean/data/backlog.md` - Captain preferences and unresolved decision records.
- `README.md` - current repository product baseline and safety direction.

### In-document source shorthand

References such as `[MRC]`, `[TIV2]`, `[MR]`, `[FS]`, `[TP]`, and `[MI]` point to the durable reports above and their named sections. Those reports retain the exact URLs, access dates, and source evidence. The following primary sources are the key externally verifiable anchors:

- Google Gemini Enterprise Agent Platform overview: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/overview>
- Google Agent Gateway overview: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/gateways/agent-gateway-overview>
- Gemini function calling and Remote MCP: <https://ai.google.dev/gemini-api/docs/function-calling>
- Gemini structured output: <https://ai.google.dev/gemini-api/docs/structured-output>
- ADK workflow agents: <https://google.github.io/adk-docs/agents/workflow-agents/>
- Google agent evaluation: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/optimize/evaluation/agent-evaluation>
- IBM MCP server limitations and import behavior: <https://www.ibm.com/docs/en/watsonx/watson-orchestrate/base?topic=tools-mcp-servers>
- IBM Flow MCP Public Preview: <https://developer.watson-orchestrate.ibm.com/tools/flows/mcp_workflows>
- IBM Data Intelligence MCP tool reference at the pinned research commit: <https://github.com/IBM/data-intelligence-mcp-server/blob/9ad1cf85171a93ed93e745c805089b51ebb50c36/TOOLS_PROMPTS.md>
- MCP authorization specification: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- MDN Server-sent events: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>
- WAI-ARIA dialog pattern: <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- Playwright Test: <https://playwright.dev/docs/intro>

Partner alternatives and market-pattern URLs are retained in the source registers of `[MRC]`, `[MR]`, and `[MI]`, including Parallel, ClickHouse, Grafana, Replit, Google Shopping, AWS Rufus/Alexa for Shopping, Dalet, Avid, Cloudinary, OpenAI orchestration/approval, and LangGraph workflows. No source above establishes that Movie-Inator has access to any of those services.

### Research interpretation and traceability notes

The README describes a public web-first media MVP, a plain-language instruction, Gemini and a Google orchestration concept, IBM as a possible first partner direction, narrow roles, bounded tools, durable records, and human approval for sensitive actions. The reports resolve the broad concept into this fixed, mock-safe workflow because it is read-only, deterministic enough to evaluate, and aligned with candidate WDI read surfaces. The release-readiness and video-ideation directions remain explicitly later alternatives because their source-of-truth and side-effect boundaries are not verified.

This appendix is evidence and recommendation, not permission to build or connect. Any implementation must first resolve the Captain decisions above and maintain the no-side-effect v1 boundary.
<!-- PRD:END -->
