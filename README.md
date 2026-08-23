> **PRD source of truth:** [`docs/prd.md`](docs/prd.md) is canonical for the complete PRD. The README includes the current Movie-Inator product surface and an exact PRD copy below; maintain `docs/prd.md` and run `npm run check:docs` to detect drift.

# Movie-Inator

Movie-Inator is a niche, filmmaker-focused source-grounded research and synthesis workspace. Its primary experience is **Script Brief**: upload one bounded PDF or text screenplay, optionally ask what to focus on, and receive a concise structured brief with traceable source citations. It is inspired by the source-grounded experience people associate with products such as NotebookLM, but it is not Google's product, branding, or a general-purpose notebook.

The primary flow is:

```text
Upload script -> Tell us what you want -> Create brief -> Read or copy the result
```

The workspace is calm and filmmaker-facing. Technical provenance, Demo/live state, recovery history, and Audience Data Readiness remain behind Developer details. The MVP is read-only and does not provide rights or legal advice, approval, publishing, partner writes, or media generation.

## Current repository truth

The deterministic local path is implemented and credential-free. It accepts bounded PDF/TXT sources, condenses the whole bounded document locally, validates the v2 Script Brief contracts, preserves source locations and citations, and labels output **Demo mode**. The optional Google REST seam is server-only and readiness-gated, but this repository contains no live Google call evidence. No IBM product/API/MCP selection, IBM runtime partner, Agent Builder/Agent Runtime deployment, hosted URL, Bob evidence, license, or contest eligibility is proven.

Movie-Inator is the display name, with `movie-inator` as the machine-safe identifier for new package and browser-state keys. Existing run IDs, API routes, workflow IDs, and durable records remain compatible. See the canonical PRD for the exact operator sequence, launch gates, and open submission checklist.

```sh
npm ci
npm test && npm run check
npm run check:docs
npm start
# open http://127.0.0.1:4173
npm run smoke:deployment

# Optional operator-only ADC-backed Google path, using ignored .env.local
npm run start:google
```

The local server exposes the existing `/v1/runs` Audience Data Readiness API and evidence paths, plus `/v1/documents` upload, `/v1/documents/{document_id}/briefs` Script Brief requests, script progress events, and citation excerpt routes. Local run and source records are written under `.data/` and ignored by git. Do not add tokens, ADC files, private endpoints, or source material to the repository.

## Local documentation

- [Product requirements document](docs/prd.md) - the canonical MVP definition, implementation truth, operator gates, and submission checklist.
- [Implementation guide](docs/implementation.md) - contracts, mock fixtures, recovery semantics, browser behavior, and validation commands.
- [Movie-Inator Phase 4 state and logic hosting guide](docs/phase4-state-logic-hosting.md) - durable checkpoints, allowlisted local tools, bounded proposals, recovery, and the future runtime boundary.
- [Movie-Inator Phase 2 script grounding operator guide](docs/phase2-script-grounding.md) - upload bounds, whole-document condensation, citations, operator boundaries, and future provider seams.
- [Phase 5 deployment and safety runbook](docs/phase5-deployment.md) - container, Cloud Run placeholders, runtime modes, Secret Manager seam, safety budgets, audit events, and the later Agent Runtime path.
- [Phase 3 partner integration operator guide](docs/partner-integration.md) - local automation, read-only registry rules, unresolved IBM selection, readiness, and recovery.

The PRD remains the source of truth for product detail. The current implementation keeps Audience Data Readiness and technical inspection available behind Developer details while the Script Brief flow stays primary.

---

<!-- PRD:START -->
# Movie-Inator MVP product requirements

**Status:** Finalized MVP product definition; launch gates remain open unless the evidence below is directly verified
**Scope:** Canonical product and contract source. This document does not grant credentials, cloud access, publishing permission, approval authority, or external partner authority.
**Display name:** Movie-Inator
**Primary workflow:** `Script Brief`
**Secondary workflow:** `Audience Data Readiness`

## 1. Product definition

Movie-Inator is a niche, filmmaker-focused source-grounded research and synthesis workspace. It is inspired by the useful source-grounded brief experience people associate with general notebook products such as NotebookLM, but it is not Google's product, branding, notebook model, or a general-purpose notebook clone.

A filmmaker, producer, writer, editor, or creative operations user uploads one bounded PDF or plain-text screenplay, optionally says what to focus on, and receives a useful, structured, cited **Script Brief**. The brief supports story understanding, development conversations, and production preparation while keeping the uploaded source and its limits visible.

The product promise is:

> Turn one screenplay into a calm, source-traceable first brief without asking a filmmaker to understand models, providers, prompts, or run records.

The primary flow is:

```text
Upload script -> Tell us what you want -> Create brief -> Read or copy the result
```

The first experience should feel like a calm filmmaker workspace. Technical provenance, mock/live status, recovery history, and the secondary Audience Data Readiness workflow belong behind **Developer details** or an equivalent operator surface. Progressive disclosure is a product boundary, not an authorization boundary: server projections must remain safe even when a user reaches a technical route directly.

## 2. Problem, users, and core jobs

### Problem statement

Screenplay understanding is often spread across rushed reads, notes, treatments, development emails, and production conversations. A general chat or notebook tool can summarize text, but it does not necessarily use the vocabulary, structure, source locations, uncertainty handling, or production lens that a filmmaker needs. Users need a fast first pass that is useful in a room and honest about what the screenplay does not establish.

Movie-Inator solves the bounded first-pass problem. It does not replace a creative read, development judgment, department preparation, legal review, rights work, or production approval.

### Target users

- **Filmmaker or writer:** wants the story spine, character arcs, themes, and open questions before a rewrite or development conversation.
- **Producer or development executive:** wants a consistent brief for coverage, meeting preparation, or comparing a small set of creative questions against the screenplay.
- **Creative operations or production lead:** wants source-grounded locations, roles, tone, setting, and other details to prepare a conversation or early planning pass.
- **Editor or collaborator:** wants a concise, cited shared starting point without turning the product into a publishing or collaboration system.

The MVP is optimized for one person working with one source at a time. It is not a multi-user project workspace.

### Core jobs to be done

1. **Understand the story:** identify the logline, synopsis, main characters, setting, tone, and themes from one screenplay.
2. **Prepare a conversation:** focus the brief on a requested arc, question, gap, or development topic.
3. **Prepare production discussion:** surface bounded source details such as scene locations, named roles, sections, and other useful preparation cues.
4. **Know what is missing:** distinguish a source gap from a fact and bring open questions into the room.
5. **Trace the brief:** open the source location behind a material statement and copy the brief into an existing working document.

## 3. Why this is different from a general notebook product

Movie-Inator is differentiated by focus and restraint rather than by claiming a new general-purpose AI category:

| General notebook experience | Movie-Inator MVP |
|---|---|
| May support many source types, notebooks, and broad questions | One bounded PDF or text screenplay per brief |
| General summarization and question answering | A fixed filmmaker brief with logline, synopsis, characters, setting, tone, themes, production details, gaps, and citations |
| User may need to create their own structure | Movie-Inator provides a stable structure designed for development and production conversations |
| Broad exploration can invite unsupported inference | Material claims are citation-checked and unsupported details become open questions |
| Technical provenance may be the main workflow | Calm filmmaker reading is primary; provenance and recovery are inspectable on demand |
| May support broad tools, browsing, or notebook actions | No arbitrary web browsing, tool calls, provider selection, publishing, or side effects |

The product must not use Google's branding, copy Google's UI, imply an affiliation that is not verified, or describe Movie-Inator as NotebookLM. The comparison explains the category reference only; Movie-Inator's product contract is this document.

## 4. MVP boundaries

### In scope

- One upload containing one bounded PDF or UTF-8 plain-text screenplay.
- An optional plain-language focus request, with a server-owned default when omitted.
- Bounded whole-document condensation with page or section and line locations.
- A concise structured Script Brief with source citations and explicit gaps.
- Read, copy, and expandable citation interactions in a responsive browser workspace.
- Deterministic local Demo mode with no credentials or external calls.
- A server-only, credential-gated Google model seam that can be enabled only by an authorized operator after the checklist in this document passes.
- Safe progress, recovery, retry lineage, and technical inspection for authorized operators.
- The existing Audience Data Readiness workflow as a secondary read-only developer/operator demonstration.

### Deliberately out of scope for this MVP

- General-purpose notebooks, arbitrary multi-document research, web search, browsing, or persistent customer memory.
- Video, audio, image, music, VFX, or other media generation and transformation.
- Rights clearance, copyright conclusions, legal advice, privacy certification, content classification, or production feasibility guarantees.
- Publishing, distribution, export to a platform, campaign activation, approval, purchase, submission, or any partner write.
- Autonomous production planning, scheduling, casting, budgeting, procurement, or department sign-off.
- User-selected providers, models, endpoints, tools, credentials, thresholds, SQL, MCP discovery, or URLs.
- Automatic fallback between external providers or a hosted public service without the launch gates below.
- IBM live partner access, an IBM runtime deployment, an IBM product/API/MCP selection, or a claim of IBM integration before direct evidence exists.

## 5. End-to-end user journey

### Customer journey

1. **Open the workspace.** The landing state names Movie-Inator and Script Brief, shows **Demo mode** when the local path is active, and explains that the file stays in the Movie-Inator instance.
2. **Upload one screenplay.** The user chooses one PDF or TXT file. The product reports type, size, extraction, and source-location readiness in filmmaker language.
3. **Choose a focus.** The user may enter a request such as “Focus on the protagonist's arc and what production should prepare for.” Blank uses the server-owned default. The request is intent only and has no system authority.
4. **Create the brief.** One action starts the bounded, read-only worker. Progress uses language such as “Reading your source”, “Preparing your brief”, and “Checking source links”.
5. **Read the result.** The user sees the fixed sections, limitations, open questions, and source citations. Empty sections say that the source did not establish the detail rather than inventing one.
6. **Inspect or copy.** The user expands citations to open a bounded excerpt with its page, section, or line location and may copy the brief. Copying creates no external record and does not publish or share the source.
7. **Recover honestly.** An unreadable source produces a source gap. A recoverable worker failure offers a bounded retry that creates an immutable child run. No failure silently becomes a live call or a different provider.

### Developer/operator journey

A collapsed Developer details surface exposes the secondary Audience Data Readiness flow and safe technical inspection. It may show mock/live state, provenance, recovery, checkpoints, partner readiness, and local evidence, but it must never expose prompts, hidden reasoning, raw provider payloads, tokens, private source rows, or secret values. The secondary workflow must not dominate the first screen.

## 6. UX principles

1. **Calm first:** use clear hierarchy, restrained status language, and a reading surface that feels appropriate for a filmmaker's working session.
2. **Source before confidence:** show what the screenplay supports and link it before using interpretive language.
3. **Gaps are useful:** “not established in the source” is a valid result and a useful conversation starter.
4. **Progressive disclosure:** keep implementation vocabulary behind Developer details, while preserving safe direct access to technical routes.
5. **No false magic:** label local synthetic output as Demo mode and never imply that a provider, deployment, partner, license, hosted URL, or contest eligibility exists without evidence.
6. **Accessible by default:** retain semantic labels, keyboard focus, visible focus, focus return from citation dialogs, reduced-motion behavior, responsive layout, safe text rendering, and forced-colors support.
7. **Copy without commitment:** copying is local user convenience, not publication, approval, sharing, or a downstream action.

## 7. Script Brief product contract

### Required sections

The default Script Brief contains:

1. **Logline:** a concise source-grounded story statement, no more than 35 words in the default template.
2. **Synopsis:** approximately 100 words and no more than 140 words in the default template.
3. **Main characters:** named roles found in the source, with bounded descriptions.
4. **Setting, tone and themes:** source-grounded setting and tone, plus themes when stated or strongly represented.
5. **Useful production details:** bounded details such as scene locations, sections, named roles, and other cues useful in a production conversation.
6. **Open questions and gaps:** what the source does not establish clearly. A gap is never silently converted into a fact.
7. **Source citations:** expandable citations that open the relevant bounded excerpt and its page, section, or line location.

Material statements in the logline, synopsis, character descriptions, setting, tone, themes, and production details carry one or more citation IDs. Open questions may have no citation when they describe an absence. The safe result contains normalized text, bounded source locations, citation IDs, provenance labels, and limitations only.

### Request and result versions

New browser requests use `grounded-brief-request@2` and new Script Brief results use `grounded-script-result@2`. The model proposal is `grounded-script-brief@2`. The legacy `grounded-script-result@1` and `grounded-script-brief@1` contracts remain readable for compatibility and are not the new browser contract.

A v2 request is:

```json
{
  "schema_version": "grounded-brief-request@2",
  "request": "Focus on the protagonist's arc and what production should prepare for."
}
```

The request is optional in the product journey. When omitted, the server applies:

> Create a concise filmmaker-facing brief with the story essentials, key characters, setting, tone, themes, useful production details, and any open questions or gaps.

The v2 result has this core shape:

```json
{
  "schema_version": "grounded-script-result@2",
  "workflow": "script_brief",
  "status": "succeeded",
  "title": "Script Brief",
  "logline": { "text": "...", "citation_ids": ["cite_..."] },
  "synopsis": { "text": "...", "citation_ids": ["cite_..."] },
  "main_characters": [
    { "name": "Mara", "description": "...", "citation_ids": ["cite_..."] }
  ],
  "setting_tone_themes": {
    "setting": "...",
    "tone": "...",
    "themes": ["..."],
    "citation_ids": ["cite_..."]
  },
  "production_details": [
    { "label": "Scene locations", "value": "...", "citation_ids": ["cite_..."] }
  ],
  "open_questions": [
    { "question": "What is not established?", "citation_ids": [] }
  ],
  "cited_citation_ids": ["cite_..."],
  "citations": []
}
```

### Grounding bounds

The local v2 grounding seam reads the whole bounded source through deterministic condensation. These are product and safety bounds, not a claim that an unbounded screenplay is placed in a model context:

- upload size: at most 5 MiB;
- extracted text: at most 120,000 characters;
- source chunks: at most 240 chunks of at most 900 characters;
- condensation: evaluates every available bounded chunk;
- writer input: at most 24 excerpts and approximately 18,000 characters;
- coverage: request-relevant chunks receive priority while evenly spaced chunks preserve opening, middle, ending, and section coverage;
- citation retention: each selected excerpt keeps its citation ID, ordinal, source mapping, and page or section/line location.

A missing or unreadable source produces a safe source gap. A source excerpt proves only what the screenplay says. It does not prove rights, approval, production feasibility, audience performance, permission to publish, or any legal conclusion.

## 8. Functional requirements

- **FR-1 Intake:** accept exactly one matching PDF or TXT upload; reject unsupported type, invalid UTF-8, malformed or textless PDF, invalid filename, and bodies over the bound.
- **FR-2 Normalization:** normalize and redact unsafe source text before storage; preserve a content-derived document identity, chunk identity, and source locations.
- **FR-3 Intent:** accept only bounded plain-language request intent. Reject unknown fields and client authority fields. Never let request text select a model, provider, tool, endpoint, credential, threshold, role, workflow, approval, or side effect.
- **FR-4 Grounding:** use bounded whole-document condensation for v2, retain source coverage metadata, and never claim unbounded context coverage.
- **FR-5 Composition:** produce the approved Script Brief structure, length bounds, normalized text, and citation IDs.
- **FR-6 Verification:** reject or safely repair malformed, unsafe, over-budget, unsupported, or unknown-citation proposals before publication to the safe result projection.
- **FR-7 Gaps:** represent absent evidence as an open question or labelled source gap; never fill an absence with a plausible fact.
- **FR-8 Citations:** allow a user to open one bounded source excerpt with its source location. Do not return prompts, tokens, raw provider responses, hidden reasoning, or unrestricted source material.
- **FR-9 Copy:** provide Copy brief without an external write, share, publish, approval, or mutation.
- **FR-10 Progress and recovery:** expose safe progress events, bounded polling fallback, terminal status, cancellation where supported, and immutable retry lineage. Preserve the original failed record.
- **FR-11 Developer surface:** keep Audience Data Readiness and technical evidence secondary, read-only, deterministic in local mode, and safe under direct route access.
- **FR-12 Runtime truth:** show Demo mode for the local path. A live provider may be described as live only after the operator checklist and direct run evidence pass.

The current API surface is:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/v1/documents` | Upload one bounded PDF or text source. |
| `GET` | `/v1/documents/{document_id}` | Read safe document metadata. |
| `POST` | `/v1/documents/{document_id}/briefs` | Create an idempotent Script Brief request. |
| `GET` | `/v1/script-briefs/{run_id}` | Read the safe Script Brief projection. |
| `GET` | `/v1/script-briefs/{run_id}/events` | Read safe progress events. |
| `GET` | `/v1/documents/{document_id}/citations/{citation_id}` | Read one bounded source citation. |
| `POST` | `/v1/script-briefs/{run_id}/retry` | Create an immutable child after a recoverable failure. |

The existing `/v1/runs` and evidence routes remain the Audience Data Readiness workflow and are not the primary Script Brief journey.

## 9. Safety, provenance, and fallback truth

### Safety boundary

Movie-Inator is a read-only brief and evidence surface. It does not provide legal advice, rights clearance, privacy certification, publishing permission, production approval, or distribution permission. The worker must reject unsafe text and side-effect instructions. Browser and model output cannot supply URLs, SQL, tools, providers, model settings, credentials, approval, publication, or mutation instructions.

All source text and model proposals are bounded, normalized, schema-validated, citation-validated, and safely rendered. Server-owned policy controls input, output, request, model-call, repair, deadline, and rate budgets. Public projections omit raw source beyond a requested bounded citation, prompts, secrets, hidden reasoning, private rows, and raw partner/provider payloads.

### Provenance

An authorized technical projection may include content-derived identifiers, hashes, and labels for the uploaded source, grounding strategy, prompt, schema, model backend, provider seam, generation outcome, run lineage, and recovery. Provenance is evidence about how Movie-Inator produced a result. It is not evidence of screenplay rights, truth outside the source, or external approval.

### Explicit mock/live boundary

- **Local Demo mode:** the default. `FakeModel`, the local deterministic grounding source, `MockProvider`, synthetic Demo evidence, and the local JSON store require no credentials and make no external calls. `GET /readyz` reports `mode: mock-only`, Google disabled, and Demo evidence.
- **Optional Google path:** a server-only `google_rest` model seam. It is selected only from complete operator configuration with explicit readiness `passed` and approved ADC or workload identity. Browser fields cannot enable it. Tests use fake transport and injected token providers; they do not prove a live Google call.
- **IBM or other partner path:** no live partner is registered. The default registry contains only the local synthetic `mock-provider` at `local://movie-inator/mock`. The IBM-compatible adapter name is a disabled seam, not an IBM integration.

Fallback truth is intentionally specific:

1. If local configuration is not ready, the application remains in deterministic Demo mode where safe and labels it. In a declared production or Cloud Run live target, incomplete configuration fails closed rather than silently becoming mock mode.
2. If an explicitly selected model call is unavailable, malformed, unsafe, or over budget, the Script Brief worker uses its deterministic grounded template and emits a safe fallback event. This is still a local deterministic result, not proof that a live call succeeded.
3. If the source is missing, unreadable, or yields no safe excerpts, the worker returns `grounding_gap` with a labelled gap. It does not invent a brief.
4. Partner unavailability returns a safe unavailable result with `provider_fallback_used: false` and an explicit manual or demo alternative. No automatic partner fallback occurs.

## 10. Architecture responsibilities

| Boundary | Responsibility | MVP truth |
|---|---|---|
| Browser | Calm upload, optional focus, progress, brief, copy, citations, and progressive disclosure | Implemented dependency-free browser route; no authority fields |
| HTTP server | Same-origin API, bounded bodies, safe errors, SSE, health/readiness | Implemented in `src/server.js` |
| Document ingestion | PDF/TXT parsing, normalization, bounds, deterministic IDs, locations | Implemented in `src/documents.js` |
| Grounding source | Whole-document bounded condensation and citation mapping | Local deterministic implementation only |
| Brief worker | Queue, grounding, composition, validation, projection, retry | Implemented in `src/grounding-engine.js` and `src/store.js` |
| Model gateway | Proposal-only model boundary and provenance | Fake model by default; Google REST seam is disabled unless operator-enabled |
| Verifier | Schema, safety, citation, length, and safe result checks | Application-owned; model never owns publication authority |
| Store | Local atomic records, events, hashes, recovery, and lineage | `FileStore` is local mock infrastructure, not a durable multi-instance public database |
| Audience workflow | Deterministic policy, synthetic partner observations, safe evidence | Secondary read-only local workflow |
| Partner boundary | Registered, read-only capability and readiness checks | Only `mock-provider`; IBM product selection remains unresolved |
| Hosting/runtime boundary | Container and future managed runtime contract | Cloud Run manifest is placeholder-only; Agent Builder/Agent Runtime is future |

Application code owns state, policy, tool allowlists, provider selection, source retention behavior, safe projections, cancellation, recovery, and all side effects. A future model host or managed runtime may schedule or propose work, but may not become the source of truth for those responsibilities.

## 11. Current implementation status versus launch evidence

The repository proves implementation artifacts and deterministic tests. It does not prove external access, deployment, partnership, development-tool usage, licensing, or contest eligibility.

| Claim | What the repository proves | What remains unproven and must not be claimed |
|---|---|---|
| Deterministic local Script Brief | PDF/TXT bounds, whole-document local condensation, v2 contracts, citations, safe gaps, recovery, and unit/integration coverage exist | A public service, multi-user durability, or production data retention policy |
| Primary browser workspace | The Script Brief route, Demo mode label, upload/focus/create/read/copy/citation surfaces, and secondary Developer details are in the repository | A completed independent browser E2E sign-off or public user study |
| Google model | Credential-gated REST seam, readiness state, configuration validation, and fake transport tests exist | No live Google request, selected project, billing, region, exact model, API version, ADC, workload identity, or live-run evidence is present in the repository |
| Agent Builder or Agent Runtime | A provider-neutral future host contract and placeholder deployment/runbook exist | No Agent Builder configuration, Agent Runtime deployment, managed runtime URL, IAM grant, quota, billing, or hosted agent exists |
| IBM partner | Read-only capability contracts, local mock provider, and an IBM-compatible disabled seam exist | No exact IBM product, API or MCP surface, version, tenant, endpoint, credential, SDK, live adapter, runtime partner, or IBM evidence exists |
| IBM Bob development | No Bob artifact is committed or referenced as proof | Captain must obtain and retain acceptable Bob development evidence before making that claim |
| Hosting | `Dockerfile`, Cloud Run placeholder, health/readiness routes, and deployment smoke script exist | No hosted Movie-Inator URL, deployed service, TLS endpoint, access policy, persistent store, or deployment owner is proven |
| License and submission | Product wording and documentation are in the repository | No license file, contest eligibility, category acceptance, Devpost authority, or submitted entry is proven |

Existing run IDs, API routes, workflow IDs, and durable records remain compatible with the current implementation. The display name is Movie-Inator and new machine-safe browser/package identifiers use `movie-inator`; this PRD does not authorize unrelated mechanical rename work.

## 12. Operator sequence and launch gates

### A. What Firstmate can implement and prove locally

1. Keep the default local runtime in mock mode; do not create credentials or cloud resources.
2. Run `npm ci` and the repository gate `npm test && npm run check`.
3. Run `npm run check:docs` and confirm the README PRD copy is byte-equivalent to this file.
4. Start `npm start`, open `http://127.0.0.1:4173`, and exercise one bounded TXT and one readable PDF fixture through Upload script, optional focus, Create brief, result, copy, and citation expansion.
5. Confirm `/readyz` is a successful `mock-only` response with Google disabled and Demo evidence. Confirm no outbound provider or partner transport is needed.
6. Exercise a source gap, malformed/unsafe model proposal, and recoverable retry using the repository tests and fixtures. Confirm fallback labels and immutable lineage.
7. Use `npm run smoke:deployment` only against a local or explicitly supplied operator target. It does not prove a hosted URL.

These steps prove a deterministic local implementation and its documentation gate. They do not prove a live provider, hosted deployment, IBM integration, Bob usage, license, or contest eligibility.

### B. Exact Google live-run checklist

A Captain or authorized operator must own every step that needs credentials, cloud access, billing, a project, or a public claim:

1. **Select and record decisions:** project ID, billing account, API (`aiplatform.googleapis.com`), region and endpoint host, exact model ID, REST API or SDK version, authentication/workload identity mode, source retention/residency policy, quotas, budget, and public enablement decision.
2. **Inspect before mutation:** verify the selected project and billing state, enabled services, region/model availability, identity owner, quota, and policy with read-only operator commands. Do not infer these from a browser request or model response.
3. **Enable only with authority:** if approved, an operator enables the API and applies the minimum IAM. The repository and tests do not run these mutations.
4. **Prepare private server configuration:** use an ignored `.env.local` for local ADC or an operator-controlled deployment configuration. Set `RUNTIME_MODE=adc_local` and `DEPLOYMENT_TARGET=local` for local live testing, or use the explicit `deployed_identity` Cloud Run shape. Set `MODEL_BACKEND=google_rest`, `GOOGLE_GEMINI_ENABLED=true`, `GOOGLE_GEMINI_READINESS=passed`, the selected project/location/model/API version, and `GOOGLE_AUTH_MODE=adc` or the approved deployed identity. Do not put secrets in the repository, browser, source, events, logs, or PR.
5. **Establish identity safely:** use `gcloud auth application-default login` only on an authorized operator machine for local ADC, or use attached workload identity/workload federation for hosting. Never create or store service-account JSON keys. Secret Manager values are created and rotated by the operator and referenced by resource name only.
6. **Start and check readiness:** run `npm run start:google`; require `GET /readyz` to return HTTP 200 with `mode: google_rest`, the selected runtime mode, configured Google state `passed`, and no secret material. A readiness response alone is not a live model-call proof.
7. **Run a synthetic screenplay check:** upload a non-sensitive, operator-approved screenplay fixture and create exactly one Script Brief. Verify the safe response has the v2 schema, required sections, citations that resolve to the uploaded source locations, bounded output, and no prompt, token, raw provider payload, or hidden reasoning.
8. **Prove the live call separately:** preserve an operator-controlled, redacted record that the request reached the selected Google endpoint and returned an accepted model response, together with the Movie-Inator run/provenance and audit outcome. Do not call fake transport tests or a `passed` readiness state live evidence.
9. **Exercise failure truth:** test an unavailable, malformed, unsafe, or over-budget model response in a controlled environment. Confirm deterministic fallback or recoverable failure is labelled and never presented as a successful live response. Confirm partner fallback remains unused.
10. **Decide release posture:** record model, source, retention, cost, rate, safety, access, and rollback review. If any gate is missing, keep the public description in Demo mode and do not claim a live Google integration.

No Google live run, selected cloud configuration, or live evidence exists in the current repository.

### C. IBM partner and Bob evidence gates

The exact IBM partner product and protocol are unresolved. `watsonx.data intelligence`, `Flow MCP`, and any other IBM product/API/MCP surface are possibilities only, not selections. Before any IBM work is described as integration, the Captain must choose and record:

- exact IBM product name, API or MCP surface, version, and supported read operations;
- tenant, project/catalog/workspace, region, data residency, and endpoint represented only by an opaque configuration reference;
- least-privilege authentication mode, scopes, identity owner, and secret-store reference;
- synthetic dataset and contract fixtures;
- normalized evidence, redacted event, raw-payload, retention, deletion, and incident-capture policy;
- security/data owner, rollback owner, readiness test, and approval.

Then the operator must implement or approve the adapter, run contract and redaction tests, perform a bounded read-only readiness check, and retain direct evidence of the exact product/API/MCP call. A pending IBM-compatible seam, a local mock, or a product family name is not an IBM integration.

**IBM Bob development evidence is a separate requirement.** If a public submission or contest rule requires development with IBM Bob, the Captain must confirm the rule and acceptable evidence with the governing submission authority, then retain reviewer-usable evidence such as an authorized Bob transcript/export or dated screenshots that directly show the Movie-Inator development work. The current repository contains no Bob transcript, export, screenshot, metadata, or other proof. Do not claim Bob usage until that evidence is captured and approved for submission.

### D. Hosting requirements

The current Cloud Run file is a placeholder-only deployment shape. A public hosted Movie-Inator requires all of the following before a URL is advertised:

- an authorized operator-selected project, billing, region, service name, artifact image, runtime identity, and exact model/runtime configuration;
- HTTPS, access control appropriate for screenplay uploads, request/body/rate/cost limits, health and readiness checks, safe error handling, and bounded logs/alerts;
- a reviewed storage and retention plan for uploaded source, local records, citations, audit events, backups, deletion, residency, and incident access;
- a persistence strategy that is appropriate for the chosen scale. `FileStore` and the local `.data` JSON path prove local mock behavior only and are not a durable multi-instance public database;
- Secret Manager or an equivalent approved secret reference with workload identity/federation, never a committed token or service-account key;
- a rollback, operator owner, smoke test, accessibility check, and cost/quota review;
- direct proof of the final URL, runtime mode, model/partner status, and safe user journey.

No hosted URL or public service is proven by the manifest, Dockerfile, or local smoke script in this repository.

### E. Public submission checklist

The following checklist remains open until the Captain or authorized submission owner verifies each item:

- [ ] Confirm final Movie-Inator name, description, screenshots, and filmmaker-focused product positioning.
- [ ] Confirm whether the public demo is explicitly Demo mode or a verified live Google mode; label it truthfully.
- [ ] Produce and verify a hosted HTTPS URL, access instructions, storage/retention notice, and final smoke result if a hosted demo is required.
- [ ] Select and evidence the exact Google product/model/runtime claim, if any. Do not substitute a repository seam for live proof.
- [ ] Select and evidence the exact IBM product/API/MCP integration, if required. Do not substitute `mock-provider`, `IBM-compatible`, or a placeholder.
- [ ] Capture and approve IBM Bob development evidence if the rules require it.
- [ ] Confirm license choice and add the authorized license file if submission requires one; no license is currently proven.
- [ ] Confirm privacy, screenplay handling, deletion, residency, accessibility, safety, and attribution disclosures.
- [ ] Confirm category, eligibility, deadlines, media requirements, terms, and Devpost/contest submission authority.
- [ ] Run the final local regression, documentation check, hosted smoke check, and human review without exposing a secret or private screenplay.
- [ ] Obtain Captain/submission-owner approval before publishing, submitting, or claiming any external integration.

## 13. Measurable acceptance criteria

### Product acceptance

- A new user can complete Upload script -> optional focus -> Create brief -> Read or copy using one bounded PDF or TXT source without seeing provider, model, phase, or partner jargon on the primary path.
- The default result renders all seven named Script Brief areas, including a clearly labelled gap when a detail is not established.
- Every material output claim has citation IDs that exist in the result and resolve to the same uploaded document with a page, section, or line location. Unknown citation IDs are never published.
- A long bounded source exercises whole-document condensation and preserves opening, middle, ending, and section coverage within the stated 24-excerpt/18,000-character bound.
- A missing or unreadable source produces `grounding_gap` and no invented story content.
- Copy brief produces no external request or durable publication record.
- Local mode is deterministic across repeated runs, visibly labelled Demo mode, uses no credentials, and makes zero external provider/partner calls.
- Technical direct routes return safe projections and never return secrets, tokens, prompts, hidden reasoning, raw provider payloads, or unrestricted private source data.
- Recoverable failures offer a bounded immutable retry; no provider or partner fallback is silent.

### Engineering and documentation acceptance

- `npm test` passes.
- `npm run check` passes, including schema and README copy checks.
- `npm run check:docs` passes and the README PRD copy is byte-equivalent to this file.
- `docs/google-setup.md`, `docs/partner-integration.md`, and `docs/phase5-deployment.md` do not present placeholders as completed integrations and preserve the operator-only boundary.
- No credential, token, ADC file, private endpoint, private screenplay, generated state, or unverified external claim is added to the repository.

### Launch acceptance

A launch or public submission is accepted only after the operator checklist, hosting requirements, exact external product selections, Bob evidence requirement, license, and submission checklist are independently verified. The deterministic local path passing tests is necessary MVP evidence, but it is not evidence of a live Google call, Agent Builder/Agent Runtime deployment, IBM partner runtime, hosted URL, Bob development, license, or contest eligibility.

## 14. Future decisions and non-goals

The following remain future decisions, not hidden MVP capabilities:

- a grounding provider or external document store;
- multi-document or persistent project memory;
- collaboration, comments, export, publishing, or downstream production actions;
- media understanding or generation adapters;
- an exact IBM partner product, API/MCP protocol, runtime, tenant, identity, and data scope;
- Google Agent Builder and Agent Runtime packaging or deployment;
- a public multi-instance store, authentication, billing, or subscription model;
- any rights, legal, privacy, clearance, or approval workflow.

Each future capability requires a versioned contract, source and retention policy, provenance model, safety and budget limits, evaluation set, failure/recovery behavior, access control, rollback plan, and Captain approval. Until then, Movie-Inator remains a focused, bounded, read-only screenplay brief workspace.

## 15. Validation commands

The default credential-free regression gate is:

```sh
npm test && npm run check
```

The documentation-only check is:

```sh
npm run check:docs
```

For local inspection:

```sh
npm start
# open http://127.0.0.1:4173
npm run smoke:deployment
```

These commands prove only the repository's local behavior and documentation consistency. They do not create cloud resources, authenticate to Google or IBM, select a model or partner, deploy a runtime, create a hosted URL, establish a license, prove Bob development, or submit a contest entry.
<!-- PRD:END -->
