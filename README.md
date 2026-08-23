> **PRD source of truth:** [`docs/prd.md`](docs/prd.md) is canonical for the complete product and contract specification. The README includes the current MovieNator product surface and an exact PRD copy below; maintain `docs/prd.md` and run `npm run check:docs` to detect drift.

# MovieNator

MovieNator is a web-first producer workspace whose primary product direction is the **Producer Intake Decision Packet**: upload a bounded screenplay and explicitly labelled companion material, then receive one read-only, source-linked view of what is established, implied, supplied, assumed, conflicting, unknown, or already decided before the next production conversation. The existing single-document Script Brief and Audience Data Readiness workflows remain compatibility surfaces.

The target producer flow is:

```text
Upload source bundle -> Label inputs -> Generate packet -> Review facts, unknowns, and conflicts -> Open citations -> Copy or export a read-only handoff
```

MovieNator is the current display name, with `movieinator` as the machine-safe identifier for new product-owned keys. Existing run IDs, API routes, workflow IDs, document IDs, session keys, and durable records remain compatible. New browser state uses `movieinator-*`; legacy `movie-inator-*` and `gemini-agents-*` values are read and copied without deletion while the packet contract is implemented.

## Product boundaries

The packet is a bounded intake and evidence surface, not a generic summarizer or production system of record. It reduces repeated first-pass reading, manual extraction, re-entry, and lost source context. It does not replace scheduling, budgeting, document control, legal or business affairs, booking, permitting, safety review, rights clearance, or human producer approval. A screenplay location is not a booked location, a named actor is not an available or contracted actor, a described stunt is not a safety approval, and a cost driver is not a budget amount.

The deterministic local path is labelled **Demo mode** and uses no credentials or external calls. Gemini and any partner or managed runtime are optional, server-owned, credential-gated, and not enabled by this documentation ship. There is no silent provider fallback and no live call from validation. Technical evidence, provenance, recovery history, and Audience Data Readiness remain behind Developer details.

## Current status

The repository contains the implemented single-document Script Brief browser flow, versioned grounded-script contracts, bounded PDF/plain-text ingestion, whole-document local condensation with source locations, deterministic citations, safe recovery, the credential-gated Gemini seam, the secondary Audience Data Readiness workflow, Phase 3 partner infrastructure, and Phase 4 local state and logic-hosting foundations. The Producer Intake Decision Packet is the authoritative next product contract, but its multi-file routes are not claimed complete here. No IBM, IVM, or other live partner product, tenant, endpoint, credential, hosted model, managed runtime, or side-effect integration is enabled.

```sh
npm test
npm run check
npm run check:docs
npm start
# open http://127.0.0.1:4173
npm run smoke:deployment

# Optional explicitly enabled ADC-backed Gemini model path, using ignored .env.local
npm run start:google
```

The local server exposes the existing `/v1/runs` API and evidence paths unchanged, plus the current `/v1/documents` upload, `/v1/documents/{document_id}/briefs` Script Brief requests, script progress events, and citation excerpt routes. The future packet routes and `producer-intake-decision-packet@1` contract are defined in `docs/prd.md` and require a later implementation. Local run and source records are written under `.data/` and are ignored by git. Set Google configuration only on an authorized server operator machine; never commit tokens, ADC files, private source material, or partner credentials.

## Local documentation

- [Product requirements document](docs/prd.md) - the authoritative Producer Intake Decision Packet, compatibility, safety, integration, and evaluation contract.
- [Implementation guide](docs/implementation.md) - current contracts, mock fixtures, recovery semantics, browser behavior, and validation commands.
- [MovieNator Phase 4 state and logic hosting guide](docs/phase4-state-logic-hosting.md) - durable checkpoints, allowlisted local tools, bounded proposals, recovery, and the future runtime boundary.
- [MovieNator Phase 2 script grounding operator guide](docs/phase2-script-grounding.md) - current single-document upload bounds, whole-document condensation, citations, operator boundaries, and future provider seams.
- [Phase 5 deployment and safety runbook](docs/phase5-deployment.md) - container, Cloud Run placeholders, runtime modes, Secret Manager seam, safety budgets, audit events, and the later Agent Runtime path.
- [Phase 3 partner integration operator guide](docs/partner-integration.md) - local automation, read-only registry rules, readiness and recovery, and the later live-access boundary.

The PRD remains the source of truth for product detail. Producer Intake Decision Packet is the primary direction; current Script Brief and Audience Data Readiness remain compatibility surfaces until a later implementation replaces neither route nor stored record.

---

<!-- PRD:START -->
# MovieNator product requirements document

**Status:** Captain-authorized Producer Intake Decision Packet v1 direction
**Authority:** This file is the authoritative product, safety, and implementation contract. It authorizes no credentials, cloud mutation, publishing, approval action, or external partner side effect.
**Product name:** MovieNator. The current browser displays **Movie-Inator** and keeps the machine-safe identifier `movie-inator`; that compatibility identity is preserved until a separate rename decision.
**Primary product direction:** `Producer Intake Decision Packet`
**Compatibility surfaces:** single-document `Script Brief` and `Audience Data Readiness`
**Research basis:** desk research report at `/Users/jacksonloh/firstmate-clean/data/movieinator-producer-market-research-s1/report.md`, read as evidence only. It is not customer validation.

## 1. Product promise

MovieNator is for producers and production-adjacent teams who receive a screenplay plus scattered companion material and need one trusted, source-linked view before the next production decision.

The core problem is the translation and reconciliation gap between a versioned screenplay, director or cast notes, location and access information, schedule assumptions, budget assumptions, rights and clearance records, department inputs, and the producer's next human decision. MovieNator is not generic prose summarization and is not a replacement for a production system of record.

The product turns a bounded, explicitly labelled source bundle into a read-only **Producer Intake Decision Packet**. The packet makes the source record, the source-implied interpretation, externally supplied material, assumptions, conflicts, unknowns, and recorded decisions visible in one place. Every material claim is linked to a source location or is explicitly marked as not established.

MovieNator replaces or reduces:

- repeated first-pass reading of the same package by different people;
- manual extraction of scenes, roles, locations, timing, departments, and production drivers;
- re-entry of the same source detail into early handoff documents; and
- lost source context when a detail is copied into a spreadsheet, meeting note, or downstream tool.

MovieNator does not replace scheduling, budgeting, document control, legal or business affairs, booking, permitting, safety review, clearance review, production-management software, or human producer approval. It does not make a production decision, book a location, contract a performer, approve a stunt, or create a budget amount.

The target flow is:

```text
Upload source bundle -> Label each input -> Generate packet -> Review facts, unknowns, and conflicts -> Open citations -> Copy or export a read-only handoff
```

## 2. Users, jobs, and decision boundary

The primary user is a producer. The packet must also be useful to the production-adjacent people who prepare or receive the next handoff.

| User hypothesis | Job after receiving the package | MovieNator helps with | Human decision that remains outside MovieNator |
|---|---|---|---|
| Producer | Establish the current source picture before a scale, rights, budget, location, financing, or team conversation | See source facts, supplied constraints, production drivers, gaps, conflicts, owners, and next questions without losing citations | Approve scale, budget, rights strategy, locations, key hires, financing, or production direction |
| Development producer or script editor | Read a draft quickly and identify story and practical questions | Source-grounded story orientation, role and location signals, revision metadata, questions for writer or director | Develop, commission, request rewrites, pitch, or pass |
| Line producer or 1st AD | Start a breakdown and identify what must be checked before schedule and budget work | Scene and element index, supplied schedule or budget inputs, department questions, unknowns, and conflict register | Build and approve the schedule, budget, crew plan, page loads, work hours, and safety process |
| Production manager or coordinator | Coordinate logistics, records, changes, and handoffs | Location, cast, rights, access, department, and document evidence states with owners when supplied | Arrange suppliers, transport, permissions, insurance, releases, call sheets, and change communications |
| Director, cast lead, or department lead | Confirm whether the packet reflects the intent and identify corrections | A cited read-only handoff with explicit versus inferred material | Confirm creative intent, availability, feasibility, technical method, and departmental approval |

The product must answer these questions quickly and defensibly:

1. What does each supplied source actually say?
2. Which production-relevant items are explicit, source-implied, externally supplied, assumed, conflicting, or absent?
3. Which file is claimed to be current, and what evidence supports that claim?
4. What changed or disagrees across the supplied sources?
5. What question or decision is next, and is an owner supplied?
6. What can be handed to the next person without turning uncertainty into fact?

The request text is intent only. It cannot select a provider, model, endpoint, credential, tool, threshold, role, workflow, approval, publication, export destination, or side effect.

## 3. Raw inputs, decisions, and outputs

The screenplay is one input, not the whole production package. A companion document can be a human-produced derivative or an external record. The packet preserves that distinction.

| Raw material | What it may establish when supplied | Human decision or next action | Packet output |
|---|---|---|---|
| Primary screenplay, shooting script, or draft | Scenes, dialogue, characters named or speaking, settings named, time language, action, story beats, and source pagination or sections | Confirm source authority and begin a human breakdown | Cited executive summary, scene index, role demands, production-element index, and gaps |
| Script revision or prior screenplay | Supplied version labels, dates, revision marks, scene changes, and differences that can be compared safely | Choose or confirm the working source and decide whether downstream work must be refreshed | Version manifest, relationship graph, changed or conflicting source rows, and limitations |
| Director notes, treatment, or cast notes | Intent, interpretation, requested changes, or external notes explicitly present in the file | Confirm intent and route questions to the right person | Clearly labelled external inputs, intent notes, conflicts, and questions |
| Breakdown, lined script, scene list, one-liner, or stripboard | A prior human or tool translation into elements, pages, days, units, or shooting order | Validate, correct, complete, or hand off the breakdown | Derived-source rows with provenance, scene and element links, and unresolved tags |
| Cast and role material | Role lists, actor candidates, availability, deal status, minors, extras, or workday assumptions only when supplied | Assess casting and logistics with the responsible team | Role demand matrix and cast questions; no inferred availability or contract |
| Location, recce, access, and logistics material | Candidate locations, access notes, owner or contact, recce observations, permits, insurance, parking, travel, or cost notes only when supplied | Confirm suitability, permission, access, travel, cost, and safety paths | Location and timing evidence states, access checklist, and open questions |
| Department inputs | Props, wardrobe, makeup and hair, vehicles, animals, special equipment, stunts, VFX/SFX, sound, music, graphics, or specialist notes | Route each item for department review and preparation | Department requirements with category, scene links, citations, and status |
| Schedule assumptions | Supplied dates, work hours, prep or move days, location groupings, day breaks, unit splits, and availability constraints | Test feasibility and resolve conflicts with production leadership | Schedule input ledger, dependencies, and conflicts, not a schedule |
| Budget assumptions or quotes | Rates, fringes, incentives, estimates, travel, access, contingency, currency, units, and source attribution only when supplied | Seek line producer, production accountant, or department review | Budget input ledger and missing-rate list, not invented totals |
| Rights, clearance, release, and business-affairs material | Supplied chain-of-title notes, releases, music, brand, archive, permission, legal review, or status claims | Ask legal or business affairs to verify rights and contingencies | Rights and clearance evidence states, owners, citations, and gaps |
| Handoff and delivery documents | The supplied record of what was sent, agreed, or delivered, with its own version and provenance | Check currentness, recipients, omissions, and change history | Handoff manifest, current-version warning, missing-document list, and read-only export |

A script location is never an exact booked location. A named actor is never an available or contracted actor. A described stunt is never a safety approval or stunt plan. A cost driver is never a budget amount. A mention of music, a brand, or a place is never a clearance, permission, or right to use it.

## 4. Evidence and classification contract

Every claim, row, question, conflict, and decision in a packet uses exactly one primary `classification` from this allowlist. A row may include several citations, but it may not omit its evidence state.

| Classification | Meaning and required behavior |
|---|---|
| `source_fact` | The source explicitly states or depicts the value. Cite the source location. Do not strengthen the wording beyond the source. |
| `source_implied_inference` | A bounded interpretation of source language, such as a likely production element implied by an action line. Cite the source and record a short `inference_basis`. It is not an established external fact. |
| `externally_supplied_fact` | A fact supplied in a companion document or human input. Preserve its source, supplied status, and date or version when present. Do not independently verify or upgrade it. |
| `human_assumption` | A person explicitly labelled a value or constraint as an assumption. Preserve the author or owner when supplied. Never create an assumption merely because a field is missing. |
| `conflict` | Two or more supplied sources or records make incompatible claims, versions, statuses, or values. Preserve each side and its citations; never silently choose a winner. |
| `open_question` | The supplied material does not establish the answer, or explicitly leaves it unanswered. A question about absence may have an empty citation list, but it must say what is missing. |
| `decision` | A human decision is explicitly supplied in the source bundle. MovieNator records the decision and provenance but never makes, approves, or publishes one. A decision still needing a human is an `open_question`, not a generated decision. |

Each typed claim or row has at least:

```json
{
  "classification": "source_fact",
  "value": "INT. OBSERVATORY - NIGHT",
  "source_ids": ["src_..."],
  "citation_ids": ["cite_..."],
  "evidence_state": "established",
  "limitations": []
}
```

`evidence_state` is separate from classification. The minimum states are `established`, `supplied_not_verified`, `assumed`, `not_established`, `conflict`, `recorded_decision`, `stale`, and `unavailable`. A supplied fact can therefore be `supplied_not_verified`; an open question is normally `not_established`; a conflict remains `conflict` until a human resolves it. No status is upgraded by model confidence.

Citations must resolve to the same source version used for the claim and retain a page for PDF or section and line range for text. Citations are evidence of what a source says. They are not evidence of rights, approval, feasibility, availability, affordability, safety, audience performance, or permission to publish.

## 5. Bounded source bundle contract

The first Producer Intake implementation accepts one bounded bundle. The limits are product limits, not model recommendations, and must be enforced before extraction or model invocation.

| Limit | Producer packet v1 requirement |
|---|---|
| Bundle size | At most 12 files per bundle, with exactly one `primary_screenplay` source and at most two `screenplay_revision` sources. The remaining files are companions. |
| File types | PDF with `application/pdf` and `.pdf`, or UTF-8 plain text with `text/plain` and `.txt`. Extension and media type must match. No DOCX, image, audio, video, archive, spreadsheet, URL, or remote import in v1. |
| File bytes | At least 1 byte and at most 5 MiB per file. Aggregate multipart body at most 25 MiB, including bounded manifest overhead. |
| Manifest | At most 32 KiB before normalization. Unknown fields are rejected. Each client reference, label, version, status, and relationship is bounded and normalized. |
| Extracted text | At most 120,000 normalized characters per file and at most 480,000 normalized characters per bundle. Truncation is recorded, never hidden. |
| Chunks | At most 240 chunks per source, each at most 900 characters, and at most 960 chunks retained per bundle. Each chunk keeps its source ID, ordinal, and location. |
| Grounding selection | The deterministic whole-bundle condensation selects at most 24 excerpts and approximately 18,000 characters for one writer invocation. It must preserve source coverage, including readable companion sources where possible, rather than keyword-only selection. |
| Packet output | At most 240 scene or element rows, 120 questions or decisions, 120 conflicts, 24 citations, and 8 limitations. Additional material becomes a bounded gap with a count and safe next step. |
| Text fields | User intent is at most 1,000 characters. Safe labels are at most 120 characters. Claim and question values use field-specific schema maxima and reject control characters and unsafe markup. |

A source entry has a client-provided `input_ref` only for the upload transaction. The server assigns stable IDs and does not expose raw input references as authority. The manifest requires:

- `source_kind`: `primary_screenplay`, `screenplay_revision`, `director_notes`, `cast_notes`, `location_access`, `schedule_assumptions`, `budget_assumptions`, `rights_clearance`, `department_input`, `breakdown`, `handoff`, or `other`;
- an optional fixed `department`: `development`, `production`, `line_production`, `production_management`, `director`, `cast`, `locations`, `camera`, `art`, `costume`, `makeup_hair`, `sound_music`, `vfx_sfx`, `stunts_safety`, `legal_business_affairs`, `finance`, or `other`;
- a safe filename and media type derived and validated by the server;
- optional `version_label` and `status_label`, retained only when supplied by the user or source manifest. A filename, file order, or model output cannot establish version or status;
- optional relationships to another `input_ref`: `revises`, `supports`, `derived_from`, `references`, `conflicts_with`, or `unknown`; and
- a short optional source note that is displayed as supplied context, not fact.

The server assigns:

- `bundle_id = bdl_<hash>` over the normalized manifest and ordered source content hashes;
- `source_id = src_<hash>` over canonical source content and accepted source identity fields;
- `chunk_id = chunk_<hash>` over source ID, ordinal, excerpt, and source location; and
- `citation_id = cite_<hash>` over source ID and chunk ID.

IDs are stable for the same canonical content and labels, do not contain source text or credentials, and are not supplied by the browser as authority. Relationships are validated as a bounded graph. Missing targets, self-contradictory relationships, duplicate primary screenplays, or an absent primary screenplay fail closed as a bundle error or safe source gap.

### Normalization, redaction, and retention

Ingestion must:

- normalize Unicode with NFKC, line endings, safe filenames, and bounded whitespace;
- remove control characters and reject invalid UTF-8 or malformed or textless PDFs;
- redact obvious credentials, bearer tokens, passwords, API keys, URLs, HTML, and executable markup before storage or model input, recording a bounded redaction marker;
- never put raw multipart bodies, raw source text, credentials, prompts, hidden reasoning, or provider responses in logs, browser state, events, or public projections; and
- keep page, section, and line mapping through normalization so a citation still opens useful evidence.

The local demo stores normalized source records under the existing ignored `.data/` store and has no external retention. A hosted packet deployment must declare a server-owned retention policy before accepting private material: source bytes and extracted text expire or are deleted at the configured TTL, citations become `expired` rather than pointing at missing content, and bounded manifest hashes, packet status, and audit records may remain for the declared audit window. The browser has no authority to extend retention, share a source, or delete an operator record. A retention-expired packet fails safely and never regenerates from an unavailable source.

Safe ingestion failure returns a bounded structured error with a stable code such as `UNSUPPORTED_DOCUMENT_TYPE`, `DOCUMENT_TOO_LARGE`, `INVALID_ENCODING`, `INVALID_PDF`, `PDF_NO_TEXT`, `EMPTY_DOCUMENT`, `BUNDLE_LIMIT_EXCEEDED`, `INVALID_SOURCE_RELATIONSHIP`, or `PRIMARY_SOURCE_REQUIRED`. It does not create a partial packet, call a model, call a partner, or guess from a missing file.

## 6. Producer Intake Decision Packet result contract

The packet request and result are versioned independently of the compatibility Script Brief contracts.

### Request schema

The target request is `producer-intake-request@1`. Its minimum shape is:

```json
{
  "schema_version": "producer-intake-request@1",
  "bundle_id": "bdl_...",
  "decision_context": "Prepare the next production conversation about scale, access, and department readiness."
}
```

Only `schema_version`, `bundle_id`, and optional normalized decision intent are client-controlled. The server supplies the fixed output sections, safety policy, evidence taxonomy, provider mode, model configuration, thresholds, tool catalog, deadlines, and retention. Unknown fields, authority fields, URLs, credentials, provider names, model names, tools, thresholds, approval requests, publishing requests, or external destinations are rejected.

### Result schema

The target result is `producer-intake-decision-packet@1`. A successful result must contain at least these top-level fields. Its safe `provenance` object must include `contract_version`, `mode`, `bundle_manifest_hash`, `grounding_strategy`, `source_manifest_hash`, `fallback_used`, and `retention_state`; it may include bounded model or partner identifiers only when server policy permits them and must never include credentials, tokens, raw prompts, hidden reasoning, or raw provider payloads.

```json
{
  "schema_version": "producer-intake-decision-packet@1",
  "packet_id": "packet_...",
  "bundle_id": "bdl_...",
  "status": "succeeded",
  "generated_at": "2026-08-23T00:00:00.000Z",
  "executive_summary": { "text": "...", "citation_ids": [], "classification": "source_fact" },
  "source_manifest": [],
  "scene_index": [],
  "production_elements": [],
  "locations_and_timing": [],
  "cast_role_demands": [],
  "department_requirements": [],
  "schedule_inputs": [],
  "budget_inputs": [],
  "rights_access_logistics": [],
  "conflicts": [],
  "decision_question_register": [],
  "gaps_and_next_steps": [],
  "citations": [],
  "limitations": [],
  "provenance": {}
}
```

The minimum sections have the following contract:

1. **Executive production summary** - a concise account of what the current bundle establishes, the decision context supplied by the user, the major production drivers, and the most consequential gaps. It must not contain an invented total, date, location, cast commitment, legal conclusion, or approval.
2. **Source and version manifest** - one row per source with `source_id`, safe filename, media type, byte size, content hash, source kind, department when supplied, `version_label` and `status_label` only when supplied, relationships, ingestion state, truncation, and source limitations. It must expose missing or competing version authority.
3. **Scene index** - each row has a scene reference or source location, script source ID, scene description, setting, interior or exterior marker, time marker, page or section location when established, classification, evidence state, and citation IDs. `shooting_order`, `day_break`, `page_count`, or `unit` are included only when supplied or explicitly source-grounded.
4. **Production-element index** - each row has a controlled category, label, scene references, classification, evidence state, source IDs, citation IDs, and optional department. Categories include cast or role, extras, location or set, props, set dressing, wardrobe, makeup and hair, vehicles, animals, stunts, VFX/SFX, special equipment, sound, music, graphics, and other. A source-implied row is visibly distinct from a source fact.
5. **Locations and timing** - reports only established settings, INT/EXT, day/night, travel or timing language, and explicitly supplied candidate or access records. Script settings are never labelled booked, permitted, available, or approved without supplied evidence.
6. **Cast and role demands** - roles, speaking or named-character evidence, extras, minors, physical or continuity demands, and supplied candidate or availability records. A role demand is not a cast commitment and an actor name is not availability or contract status.
7. **Department requirements** - department, scene or element, required preparation or question, classification, evidence state, owner when supplied, and citations. Stunts and physical action are routed to specialist safety review and never labelled safe or approved.
8. **Supplied schedule inputs** - only supplied dates, work hours, prep or move assumptions, location groupings, scene-day relationships, availability inputs, and dependencies. No autonomous stripboard, optimized shooting order, feasibility certification, or call-sheet publication.
9. **Supplied budget inputs** - only supplied rates, units, currencies, quotes, estimates, fringes, incentives, travel, access, contingency assumptions, and cost drivers. Every numeric value has a source and unit when supplied. No invented rate, currency, total, forecast, or contingency amount.
10. **Rights, access, and logistics evidence states** - separate rows for rights and clearance, releases, location permission, insurance, access, parking, travel, equipment, cast logistics, and safety dependencies. Each row uses an evidence state such as `established`, `supplied_not_verified`, `not_established`, `conflict`, `stale`, or `unavailable`, with owner and last-supplied version only when present.
11. **Conflicts** - both or all conflicting assertions, source IDs, citation IDs, conflict kind, impact, and the human question needed to resolve it. A conflict is not resolved by source order, filename, model confidence, or a hidden precedence rule.
12. **Decision and question register** - an `entry_type` of `decision` or `open_question`, the related scene or element, owner only when supplied, decision maker only when supplied, due date only when supplied, evidence state, citations, and a handoff-ready next action. A generated recommendation is never written as a decision.
13. **Gaps and handoff-ready next steps** - missing source or metadata, suggested human owner or department only when the role is evident or supplied, why it matters, and what evidence would close it. Next steps are read-only instructions, not tasks sent to anyone.
14. **Citations and limitations** - every material claim resolves to a bounded citation containing `citation_id`, `source_id`, `chunk_id`, source locations, and a safe source label. Limitations state truncation, unreadable or missing material, unverified external inputs, retention limits, and the fact that the packet does not grant rights, approval, booking, safety clearance, or permission to publish.

A packet may be `succeeded` while containing conflicts and open questions. `source_gap` means the required source was unreadable, absent, or outside the safe bound; `failed` means no verified result was produced; `expired` means source retention no longer permits citation access. A partial or malformed packet is never presented as succeeded.

## 7. User journey and browser language

The producer-facing browser is the primary experience once the packet implementation is available. The first screen uses production language, not model or orchestration language.

1. **Upload source bundle** - the user chooses the screenplay and companion files. The UI shows the 12-file and 5 MiB limits, accepted PDF/TXT types, privacy and retention notice, and a safe error if any file is rejected.
2. **Label inputs** - each file receives a source kind and optional department label. The user may add a version or status exactly as supplied and relate a companion to the screenplay or another source. The UI warns that labels do not verify a fact.
3. **Generate packet** - the user may add a plain-language decision context, then selects **Prepare intake packet**. The browser does not expose provider, model, credential, endpoint, tool, threshold, approval, publish, or partner controls.
4. **Review** - the result opens with tabs or sections for **Summary**, **Sources and versions**, **Scenes and elements**, **Locations and timing**, **Cast and roles**, **Departments**, **Schedule and budget inputs**, **Rights and access**, **Conflicts**, **Questions and decisions**, and **Gaps and next steps**. Filters make classification and evidence state visible.
5. **Open citations** - a citation button opens a bounded source excerpt, page or section and line location, source kind, version label when supplied, and limitations. Focus returns to the invoking control and the browser renders source text as text, never HTML.
6. **Copy or export handoff** - **Copy read-only handoff** copies a bounded text or Markdown view. A read-only JSON, Markdown, or CSV export can be downloaded or requested from a server route. Export does not publish, send, book, approve, or modify a downstream system.

Progress language is **Uploading source bundle**, **Mapping sources**, **Reading the supplied material**, **Reconciling source records**, **Checking citations**, and **Packet ready**. If a safe failure occurs, the UI says what could not be established and offers a new upload or retry without hiding the original run.

The UI must retain accessible labels, keyboard focus, visible focus states, safe text rendering, responsive layout, reduced-motion support, forced-colors support, bounded polling or SSE, and citation focus return. Demo mode must be visibly labelled as deterministic, local, and no-credentials. Technical provenance and recovery history may be available behind **Developer details**, but hiding a control is not an authorization boundary.

## 8. Server API and browser authority

The future packet API is server-owned and read-only. It is a target implementation contract; this documentation ship does not add these routes.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/v1/producer-source-bundles` | Ingest one multipart bundle containing a manifest and at most 12 PDF/TXT files. Assign stable IDs and return a safe bundle projection. |
| `GET` | `/v1/producer-source-bundles/{bundle_id}` | Read the safe manifest, source statuses, hashes, relationships, and retention state. |
| `POST` | `/v1/producer-source-bundles/{bundle_id}/packets` | Create an idempotent `producer-intake-request@1` and queue one immutable packet run. |
| `GET` | `/v1/producer-packets/{packet_id}` | Read the safe packet projection, progress, status, result, limitations, provenance summary, and recovery actions. |
| `GET` | `/v1/producer-packets/{packet_id}/events` | Read bounded safe progress events through SSE with cursor support. |
| `GET` | `/v1/producer-packets/{packet_id}/citations/{citation_id}` | Read one bounded cited excerpt and source location if retention permits. |
| `GET` | `/v1/producer-packets/{packet_id}/handoff?format=markdown\|json\|csv` | Return a bounded read-only handoff projection. The format is an allowlisted view, not an arbitrary destination or side effect. |
| `POST` | `/v1/producer-packets/{packet_id}/retry` | Create an immutable child after a recoverable failure. The original result, provenance, and error remain unchanged. |

All packet routes enforce bounded request and response sizes, safe content types, unknown-field rejection, idempotency keys for creation, and server-owned deadlines. Reusing an idempotency key with a different normalized request returns a conflict. A run cannot be published unless its schema, classifications, citation IDs, source locations, source relationships, output limits, and unsafe-text checks pass.

The browser may choose files, fixed source labels, optional supplied metadata, a bounded decision context, and a read-only handoff view. The server assigns source IDs, packet IDs, policy, model and provider configuration, budgets, tools, retention, and approvals. No browser field may select:

- a provider, model, API version, project, region, endpoint, credential, tenant, or runtime;
- an arbitrary URL, SQL query, MCP server, tool, permission, scope, threshold, or safety setting;
- an approval, booking, publication, message, export destination, partner write, or other side effect; or
- a source authority or version status that was not supplied and labelled by a human.

## 9. Processing, model boundary, and safety

### First implementation

The first Producer Intake implementation is one bounded, deterministic, source-grounded pipeline:

```text
Validate bundle -> Normalize and redact -> Assign IDs and citations -> Extract bounded source records -> Classify and reconcile -> Verify citations and semantics -> Project packet and handoff
```

A deterministic extractor and taxonomy provide the stable floor. An optional model may propose wording or structured rows inside the same server-owned schema, but the model is not an authority for source identity, classification, conflicts, provider selection, policy, retention, state, or side effects. The verifier rejects unknown citations, missing locations, unsupported fields, unsafe text, unbounded output, invented external facts, and forbidden leaps such as booked, contracted, permitted, approved, safe, or budgeted when those facts are not supplied.

The pipeline must preserve every source relationship and report conflicts rather than silently applying precedence. If one source is labelled primary and another is a revision, the packet can report the supplied relationship and compare safe fields; it cannot declare the primary current unless the supplied material establishes that status. A source gap produces a safe gap result, not a fluent guess.

### Demo mode and optional Gemini boundary

Demo mode is the default and must be deterministic, credential-free, network-free, and visibly labelled. It uses the local source store, deterministic condensation, fixed schemas, and synthetic fixtures only. `npm test`, `npm run check`, `npm run check:docs`, and deployment smoke validation make no live calls.

Gemini is an optional server-only boundary. It can be selected only by complete process-owned configuration and an explicit readiness state such as `GOOGLE_GEMINI_ENABLED=true`, `MODEL_BACKEND=google_rest`, `GOOGLE_GEMINI_READINESS=passed`, a server-selected project, location, model, API version, publisher, and approved authentication mode. No credential, ADC file, token, or private source is committed. The browser cannot enable or configure Gemini.

There is no silent provider fallback. A packet run records its selected mode at acceptance. If an explicitly enabled Gemini call is unavailable, malformed, unsafe, over budget, or not ready, the server returns a safe `model_unavailable` or `failed` state, or uses a deterministic packet fallback only when a server-owned policy explicitly enables that fallback and the result visibly records `fallback_used`, the reason class, and the actual deterministic provenance. A mock result is never labelled Gemini and no live call is retried against another provider.

The existing compatibility Script Brief worker retains its current deterministic writer fallback and legacy result behavior for old clients. That compatibility fallback is not permission to claim live Gemini readiness and must not be copied into a packet provider switch without the explicit provenance rule above.

Before any live Google integration is called for MVP, the operator must prove:

1. an exact Google Cloud project, region, model, API version, identity, quota, and retention decision;
2. a passed server-side readiness check and an injected-token or approved workload-identity test without browser input;
3. request and result conformance for the packet schema, citation integrity, unsafe-text rejection, timeouts, call budgets, and redaction;
4. representative producer-reviewed evaluation against the deterministic baseline, including citation correctness and unknown detection;
5. bounded cost, latency, rate, retry, and repair behavior with audit events and rollback to explicit Demo mode; and
6. that validation, tests, and smoke checks remain network-free and cannot accidentally use the live configuration.

### Multi-agent hypothesis

Multi-agent decomposition is an evaluation hypothesis, not an MVP requirement and not a brand promise. It must not be added merely to call the product agentic. A future evaluation may compare a single pipeline with narrow specialists such as:

- screenplay coverage and scene extraction;
- production-element breakdown;
- supplied schedule and budget input normalization;
- rights, access, and logistics evidence normalization; and
- an independent conflict, citation, and safety verifier.

Any specialist must receive a narrow evidence scope, a versioned input and output schema, fixed source IDs, a maximum tool and token budget, no arbitrary network or side effect, and a bounded deadline. A verifier-owned merge layer must preserve provenance, reject unsupported claims, and report conflicts. The multi-agent path is supported only if it materially improves producer-reviewed citation accuracy, element recall, unknown detection, conflict detection, correction rate, latency, or cost against the single-pipeline baseline.

## 10. Compatibility with the current repository

This PRD changes product direction, not existing compatibility behavior. The documentation ship does not modify application code, schemas, credentials, deployment, or generated state.

The current repository already provides a single-document Script Brief surface with:

- `POST /v1/documents` for one matching PDF or UTF-8 TXT upload, at most 5 MiB;
- `GET /v1/documents/{document_id}` for safe metadata;
- `POST /v1/documents/{document_id}/briefs` with `grounded-brief-request@2` for the current structured Script Brief;
- `GET /v1/script-briefs/{run_id}` and its SSE events;
- `GET /v1/documents/{document_id}/citations/{citation_id}` for bounded excerpts; and
- `POST /v1/script-briefs/{run_id}/retry` for an immutable child after a recoverable failure.

Current Script Brief grounding remains bounded at 120,000 extracted characters, 240 chunks of at most 900 characters, at most 24 selected excerpts, and approximately 18,000 selected characters. `grounded-script-brief@2` and `grounded-script-result@2` remain readable, while `grounded-script-brief@1` and `grounded-script-result@1` remain readable for existing records. The single-document request and result must not be reinterpreted as a producer bundle or silently rewritten.

Audience Data Readiness remains available through its existing `/v1/runs` API, evidence routes, deterministic policy, local mock partner, recovery, state, logic-host, and safe projections. It remains a secondary developer or operator workflow, not the producer packet's source of truth.

The browser may make the Producer Intake Decision Packet primary in a later implementation while keeping Script Brief and Audience Data Readiness as compatibility surfaces, linked from the existing Developer details area or their existing routes. Existing run IDs, document IDs, API routes, workflow IDs, session compatibility keys, and stored records remain valid. No migration may delete or reinterpret them.

The current local architecture is documented in `docs/implementation.md`, `docs/phase2-script-grounding.md`, `docs/partner-integration.md`, `docs/phase4-state-logic-hosting.md`, and `docs/phase5-deployment.md`. This PRD is the product contract; those guides remain implementation and operator references where they do not conflict with this direction.

## 11. Partner, Google, and contest readiness boundary

The official Agentic Cinema overview says: **"Build a functional agent - powered by Gemini and Google Cloud Agent Builder - that integrates a Partner Entity's product or MCP to power a real media & entertainment workflow."** The official rules describe the required project as a **"functional, production-ready AI agent or multi-agent network"** powered by Gemini and Google Cloud Agent Builder that integrates a Partner Entity product or MCP server. The official page also requires a hosted project URL, a public demonstration video of no more than three minutes on YouTube or Vimeo in English or with English subtitles, a public source repository with run instructions and a complete open-source license, a selected partner track, and a completed Devpost submission. The rules say the repository must demonstrate actual runtime use of Google Cloud and the chosen Partner service in code, not merely name them in the README.

For the contest path, the rules restrict AI and agent tooling to Google Cloud AI tools and the built-in AI features of the selected Partner product. That requirement applies to a future submission path, not to a claim that this repository already has a live integration. The official resources recommend Google Cloud agent tooling such as Agent Builder, the Google Gen AI or Vertex AI SDKs, ADK, and managed runtime or hosting paths. Those recommendations are not evidence that this repository currently has Google Cloud connectivity. The repository remains offline and mock-safe until operator prerequisites are completed.

### IBM track ambiguity

The official IBM resource page specifically says: **"your project must be built using IBM Bob as part of the development process"** and that projects that do not demonstrate IBM Bob usage do not meet the IBM track requirements. It says Confluent is optional and strongly encouraged. The page does not identify a required IBM runtime API, MCP server, IBM product endpoint, tenant, or runtime integration for this project.

Therefore:

- IBM Bob is a development-process evidence requirement for an IBM-track submission, not an invented runtime API or MCP choice.
- The PRD does not name watsonx, watsonx.data, Flow MCP, Confluent, or another IBM runtime product as if it were selected.
- IBM live adapter readiness remains `not_configured` until the operator confirms the exact product or MCP surface, version, endpoint, tenant, region, authentication, read-only operations, scopes, data terms, and test fixture.
- If no required IBM runtime surface is confirmed, the repository may remain locally ready but is not contest-submission-ready for the IBM track. A public demo cannot imply IBM runtime use that did not occur.

Before enabling any live partner adapter, the operator must record an exact capability manifest and evidence for:

1. selected partner track, exact product and API or MCP surface, version, and documentation;
2. tenant, region, data residency, opaque endpoint reference, and stable asset, scene, document, or revision IDs;
3. authentication mode, secret-store reference, least-privilege read scopes, identity owner, quotas, pricing, and rate limits;
4. allowed read-only operations, input and output schema hashes, response and timeout limits, and no mutating operation;
5. synthetic fixtures and expected redaction, unavailable, denied, stale, timeout, and circuit-open behavior;
6. retention, deletion, privacy, residency, logging, human-review, subprocessors, training-use, and export terms;
7. accountable technical, data, security, and rollback owners plus a contract-test date; and
8. runtime evidence that the selected partner operation was actually imported and called, not merely mentioned in documentation.

A partner observation is evidence input only. It cannot select a model, alter a policy decision, approve a packet, publish, mutate, submit, purchase, deploy, export to an arbitrary system, or trigger a message. No live partner adapter silently falls back to synthetic or another partner's data. When a partner is unavailable, the result says so and offers a separately labelled manual or Demo mode path.

## 12. MVP definition and acceptance criteria

### Repository and product MVP

The offline MVP is a producer-facing, read-only packet path that accepts one bounded labelled source bundle, produces a deterministic source-grounded packet, exposes citations and limitations, and keeps the current Script Brief and Audience Data Readiness contracts working. It does not require a live Google project, partner account, managed runtime, hosted URL, Devpost action, or IBM runtime endpoint.

The MVP is accepted only when all of the following are true:

**Input and bundle integrity**

- The API accepts only the bounded PDF/TXT bundle contract, enforces every file, aggregate, manifest, extraction, chunk, and output limit, and rejects malformed, empty, invalid, oversized, or unsupported sources safely.
- Every input has a validated source kind or department label, server-owned stable ID, hash, provenance, optional supplied version or status, and validated relationship. A missing or competing primary screenplay is visible and safe.
- Normalization and redaction preserve page, section, and line citations and keep raw source, credentials, prompts, and provider payloads out of logs, browser state, and public projections.

**Grounding and output truth**

- Demo mode is deterministic and produces the same packet for the same canonical bundle, request, and server contract.
- Every material output row has one allowed classification, an evidence state, source IDs, and valid citation IDs or a clearly stated open question with no invented citation.
- The packet includes the executive summary, source/version manifest, scene and production-element index, established locations and timing, cast and role demands, department requirements, supplied schedule inputs, supplied budget inputs without invented totals, rights/access/logistics evidence states, conflicts, decision/question register, gaps and handoff steps, citations, and limitations.
- A screenplay location is not rendered as booked, a named actor as available or contracted, a stunt as safety-approved, or a cost driver as a number unless the relevant external evidence was supplied and is labelled as supplied rather than independently verified.
- Conflicting sources are both shown with a resolution question. Unknown or missing external facts are not silently filled.

**API and browser behavior**

- A producer can upload and label a bundle, generate a packet, see bounded progress, review classifications and unknowns, open a citation, copy a read-only handoff, and request an allowlisted read-only export.
- End-to-end browser behavior is safe at narrow widths, keyboard accessible, focus-correct in citation drawers, and honest about Demo mode, source limitations, and failures.
- Browser fields cannot choose providers, models, credentials, URLs, tools, thresholds, approvals, publishing, or side effects. Server routes reject unknown or authority fields even if the UI is bypassed.

**Compatibility and readiness truth**

- Existing single-document Script Brief routes, `@1` and `@2` contracts, citation routes, retries, and browser behavior remain compatible.
- Existing Audience Data Readiness routes, deterministic policy decisions, local mock partner, state, evidence, recovery, and safe projections remain compatible.
- `/readyz`, operator status, packet provenance, and UI labels distinguish repository/demo readiness, Google readiness, partner readiness, hosting readiness, and contest submission readiness. No status claims live Google, IBM, or managed runtime connectivity without evidence.

**Tests and safe failure**

- Automated tests cover bundle limits, PDF/TXT validation, normalization/redaction, stable IDs, relationships, citations, all classifications, conflict and unknown semantics, deterministic output, unsafe or malformed model output, explicit fallback behavior, retention expiry, API idempotency, retry immutability, browser E2E behavior, compatibility routes, and safe exports.
- `npm test && npm run check` remains credential-free, network-free, and deterministic. `npm run check:docs` passes and the README PRD copy is exact.
- A source, model, partner, or runtime failure produces a safe gap or recoverable failure with preserved provenance and no side effect. It never invents output or silently selects another provider.

### Contest submission readiness is separate

Repository/demo readiness does not imply contest submission readiness. Submission readiness additionally requires operator-owned deliverables and evidence:

| Readiness | Required evidence | Current state in this documentation ship |
|---|---|---|
| Repository/demo | Offline tests, docs sync, deterministic browser/API flow, source-grounded fixture output, no committed credentials | Can be proven locally after implementation; this task changes docs only |
| Google readiness | Selected project, identity, model, region, quota, readiness check, live contract tests, actual allowed Google runtime use | Not complete; no live calls or credentials are added |
| Partner capability manifest | Exact selected partner product/API/MCP, terms, identity, scopes, fixtures, owners, failure behavior | Not complete; local `mock-provider` is the only default |
| Live partner adapter | Actual imported and called read-only partner operation with redacted evidence and rollback | Not complete; IBM runtime surface is intentionally unspecified |
| Managed runtime and hosting | Cloud Run or approved Agent Runtime deployment, IAM, secrets references, HTTPS hosted URL, readiness and smoke evidence | Not complete; manifests and runbooks are placeholders only |
| Evaluation | Producer-reviewed reference set, measured quality, unknown/conflict checks, latency and cost, correction and handoff results | Not complete; desk research is not validation |
| Devpost submission | Hosted URL, public video, public repository, open-source license, selected track, completed form, and any partner-specific evidence such as IBM Bob | Operator-only and not claimed by the repository |

## 13. Staged technical roadmap and dependencies

| Stage | Deliverable | Can be implemented offline now | External or operator dependency |
|---|---|---|---|
| 0. Contract foundation | `producer-source-bundle@1`, `producer-intake-request@1`, `producer-intake-decision-packet@1`, classification and citation schemas, fixtures, validators, retention state, compatibility tests | Yes | None, apart from product review of schema changes |
| 1. Producer packet MVP | Bounded multi-file ingest, source labelling, stable IDs and relationships, deterministic extraction and reconciliation, verifier, packet API, browser upload/review/citation/copy/export | Yes, with local store and synthetic fixtures | Permissioned scripts and companion materials for later evaluation |
| 2. Google readiness | Optional Gemini adapter behind the server boundary, readiness route, contract tests, budget and audit evidence, explicit fallback state | Adapter seam and tests can be built offline with injected transport | Captain-selected Google project, credentials or workload identity, model, region, quota, written retention and privacy decisions |
| 3. Partner capability manifest | Read-only manifest and projection for the selected partner track, exact operation schemas, synthetic fixtures, unavailable and denied tests | Registry, validation, and mock adapter can be built offline | Captain/operator must choose an exact partner product/API/MCP, tenant, region, terms, identity, scopes, and owner |
| 4. Live partner adapter | Narrow read-only operation, provenance, cache and retention behavior, rollback, contract tests, no fallback | Transport seam and failure tests can be built offline | Written partner confirmation, account access, credentials or secret reference, data license and privacy approval |
| 5. Managed hosting | Container, Cloud Run or approved Agent Runtime facade, Secret Manager references, IAM, readiness, HTTPS, smoke and rollback | Container and local smoke tests can be built offline | Project, billing, region, registry, service account, network, secret references, deployment and operator approval |
| 6. Evaluation | Anonymized or permissioned source bundles, producer reference matrices, single-pipeline baseline, optional multi-agent comparison | Harness, metrics, synthetic fixtures, and scoring code can be built offline | Producer interviews, observations, permissioned material, evaluator time, and privacy approval |
| 7. Demo and submission | Public hosted URL, three-minute public video, public repository and license, partner and Google runtime evidence, Devpost form | Demo script and offline rehearsal can be built offline | Deployment, public access, video publication, license decision, selected track, IBM Bob evidence if applicable, and Devpost action |

No stage may skip a failed readiness gate by changing the displayed status or silently falling back. A later stage must preserve the packet schemas and verifier boundary established in earlier stages.

## 14. Research evidence, unknowns, and validation plan

The completed report is desk research dated 2026-08-23 UTC. It supports a workflow hypothesis, not product-market fit, market size, willingness to pay, or customer trust.

### Evidence carried into the PRD

- **E1, ScreenSkills producer guidance:** producers choose or secure rights, decide scale and budget, approve locations, and delegate execution. This supports the producer decision boundary, not demand for this product.
- **E2, Nashville Film Institute script breakdown guidance:** identifying elements is described as tedious and essential for schedule, call sheets, and preparation. This is the strongest independent pain signal, but it does not quantify hours or cost.
- **E3, ScreenSkills line producer, production manager, and coordinator guidance:** production work joins money, crew, safety, logistics, documentation, script changes, rights, clearances, and communication. This supports the multi-document intake problem.
- **E4, ScreenSkills location guidance and Film London permission guidance:** location use, releases, insurance, permissions, and access are separate records. A screenplay location cannot prove permission or availability.
- **E5, LibreTexts, Into Film, and FSUFILM paperwork guidance:** breakdowns, schedules, call sheets, permits, releases, cast and location records, safety documents, correspondence, and delivery materials form a broad handoff chain.
- **E6, StudioBinder, Celtx, Movie Magic, Yamdu, and Scenechronize product materials:** existing substitutes provide breakdown, revision propagation, scheduling, budgeting, and document control. Vendor feature claims are not independent evidence that MovieNator is needed.

The canonical evidence URLs and passages remain in the report. The report must not be modified as part of this PRD task.

### Unvalidated hypotheses

1. Manual coverage, extraction, reconciliation, and re-entry take enough producer time or create enough risk to justify a cited intake layer.
2. The first valuable wedge is before a system of record, rather than a replacement for StudioBinder, Celtx, Movie Magic, Yamdu, Scenechronize, spreadsheets, or human experts.
3. Producers prefer an explicit fact, inference, unknown, conflict, and question register to a longer fluent summary.
4. Development producers, producers, line producers, production managers, and creative-operations leads are different jobs and should not be treated as one buyer.
5. Sensitive scripts and rights materials can be used only with acceptable access, retention, redaction, and deployment controls.
6. A single deterministic pipeline is sufficient for the first product and may outperform a multi-agent design on trust, correction rate, latency, and cost.
7. A live partner becomes valuable only if current external costs, access, document control, or downstream re-entry is a dominant observed problem. It is not an MVP dependency.

### Falsification criteria

The product or architecture hypothesis should be reconsidered if observation shows that:

- producers already have a trusted intake artifact with no meaningful source-context loss;
- the packet does not change a next action, reduce a real review step, or get handed into the next tool or meeting;
- users reject the retention or confidentiality boundary for the intended source material;
- a single pipeline matches or beats proposed specialists on citation accuracy, element recall, unknown detection, conflict detection, correction rate, latency, and total cost; or
- the dominant pain is scheduling, budgeting, legal clearance, booking, permitting, or document control that this read-only packet cannot responsibly address.

### Interview and observation plan

Recruit 12 to 16 people who handled a scripted project in the prior 18 months: development producers or script editors, producers, line producers or 1st ADs, production managers or coordinators, and a small number of creative-operations or department-side participants. Mix project sizes and do not recruit only existing AI or software advocates.

Use an artifact-first 45 to 60 minute interview. Ask what arrived, how version authority was determined, what happened in the first hour, how one complex scene moved from script to breakdown, schedule, budget, locations, cast, and department follow-up, what was re-entered, what changed, what was missed, who owned each question, and what the participant would trust in a cited packet. Ask about sensitive material, retention, approved tools, buyer, and the exact handoff point. Show the packet only after observing the current workflow.

Observe or replay 4 to 6 real prep sessions. Collect anonymized folder inventories or screenshots for screenplay revisions, breakdowns, scene lists, cast and location trackers, schedule and budget inputs, rights/access records, call-sheet inputs, and handoff checklists. Measure elapsed time, source switches, duplicate fields, revision propagation steps, unresolved questions, human corrections, and whether the packet is copied into a next tool or meeting.

Proceed with product investment only when at least two personas independently describe a recurring intake or handoff problem, participants identify a real artifact where source context or version status was lost, a cited packet changes a next action or review step, a consumer handoff point is named, trust requirements are acceptable, and a human owner remains clear for every production decision.

### Measurable evaluation criteria

Use a small permissioned or anonymized set of representative scripts and companion bundles with an experienced producer or 1st AD reference matrix. Measure:

- scene and production-element precision and recall by category;
- citation correctness, citation completeness, and time from claim to source excerpt;
- classification accuracy for source fact, source-implied inference, external supplied fact, assumption, conflict, open question, and decision;
- false assertion rate for booked, available, contracted, permitted, safe, cleared, approved, and budgeted claims, with a target of zero in the accepted set;
- version and conflict detection precision and recall;
- unknown or gap detection precision and recall;
- question-register usefulness, owner accuracy when supplied, and severity of human corrections;
- time to first useful producer conversation, source switches, repeated entry points, and handoff adoption;
- packet latency, deterministic replay rate, model call count, cost, output size, and recovery behavior; and
- comparison of the single pipeline with any future specialist design using the same fixtures and budgets.

Do not treat desk research or a favorable demo as willingness to pay, product-market fit, customer validation, or contest readiness.

## 15. Non-goals and operator prerequisites

The producer packet does not add:

- automatic location search, recommendation, booking, outreach, or permit application;
- budget amounts, rates, incentives, forecasts, or financial approval not supplied by the user;
- scheduling optimization, call-sheet publication, crew booking, availability claims, or production approval;
- rights, copyright, defamation, clearance, insurance, permitting, or safety conclusions;
- arbitrary browsing, web search, SQL, MCP discovery, external vector search, or unapproved partner data;
- video, audio, image, music, VFX, or other media generation;
- publishing, distribution, messaging, partner writes, or downstream mutations;
- credentials, ADC files, tokens, hidden customer memory, or raw provider payloads in the repository; or
- a claim that a partner, Google Cloud, IBM runtime, managed Agent Runtime, hosted URL, public video, open-source license, or Devpost submission is complete.

Before a live or public action, an authorized operator must separately choose and record project, billing, region, runtime identity, model, quota, retention, partner product, endpoint, scopes, terms, deployment target, public access, license, video, selected track, and Devpost deliverables. The operator must use secret-store references or workload identity rather than pasting secrets into chat, source, browser, issue, PR, prompt, or log. This documentation task supplies no such values and runs no cloud or partner mutation.

## 16. Validation and definition of documentation done

The repository documentation gate is:

```sh
npm test
npm run check
npm run check:docs
```

The default gate requires no credentials, network, Google account, IBM account, partner service, hosted runtime, or Devpost access. A successful local gate proves repository and demo documentation readiness only. It does not prove Google readiness, partner runtime use, IBM Bob evidence, hosting, public video, license, or contest submission readiness.

`README.md` must contain an exact byte-for-byte copy of this file between its PRD copy markers. Any future PRD change must update `docs/prd.md` first, copy it into those markers, and run `npm run check:docs`. No generated state, credentials, private source material, desk-research report, or review artifact belongs in the repository.
<!-- PRD:END -->
