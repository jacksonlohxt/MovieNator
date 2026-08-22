# Movie-Inator product requirements document

**Status:** Captain-approved Script Brief v1 launch direction
**Scope:** Product and contract source of truth. This document authorizes no credentials, cloud mutation, publishing, approval action, or external partner side effect.
**Primary workflow:** `Script Brief`
**Secondary workflow:** `Audience Data Readiness`

## 1. Product promise

Movie-Inator helps a filmmaker turn one bounded script into a useful first brief. The filmmaker uploads a PDF or plain-text script, says what would be useful, and receives a concise brief grounded in the uploaded source. The default brief is useful without requiring the filmmaker to know anything about models, providers, phases, checkpoints, or run records.

The primary customer flow is:

```text
Upload script -> Tell us what you want -> Create brief -> Read or copy the result
```

The first screen uses plain filmmaker language. It does not expose phase names, provider or model details, partner status, run IDs, checkpoints, role maps, technical evidence, or backend jargon. A collapsed **Developer details** surface keeps the Audience Data Readiness workflow and technical inspection available without making either part of the first interaction.

The product is a read-only brief and evidence surface. It does not provide legal advice, privacy certification, rights clearance, publishing permission, or approval to produce or distribute a work.

## 2. Primary user and job

The primary user is a filmmaker, producer, writer, editor, or creative operations lead who needs a fast understanding of a script before a conversation, treatment, production meeting, or planning pass.

The user should be able to:

- upload one bounded PDF or UTF-8 text script;
- use a default request or enter a plain-language request for a particular focus;
- read a concise, structured Script Brief immediately;
- copy the result into another working document;
- expand source citations and open the relevant page, section, or line excerpt;
- see open questions when the source does not establish something clearly.

The request text is intent only. It cannot select a provider, endpoint, model, tool, credential, threshold, role, workflow, approval, publication action, or external side effect.

## 3. Script Brief output

The default Script Brief contains these sections:

1. **Logline** - a concise source-grounded story statement, no more than 35 words in the default template.
2. **Synopsis** - approximately 100 words and no more than 140 words in the default template.
3. **Main characters** - a short list of named roles found in the source, with bounded descriptions.
4. **Setting, tone and themes** - source-grounded setting and tone, plus themes when they are stated or strongly represented in the source.
5. **Useful production details** - bounded source details such as scene locations, sections, and named roles that can help a production conversation.
6. **Open questions and gaps** - items the source does not establish clearly. A gap is not silently converted into a fact.
7. **Source citations** - expandable citations that open the relevant source excerpt and its page or section location.

Material statements in logline, synopsis, characters, setting, tone, themes, and production details carry one or more citation IDs. Open questions may have no citation when they describe an absence in the source. The safe result contains only normalized text, source locations, bounded citations, provenance labels, and limitations.

The result contract is `grounded-script-result@2`. The model proposal contract is `grounded-script-brief@2`. The legacy `grounded-script-result@1` and `grounded-script-brief@1` contracts remain readable for existing records and focused compatibility tests, but new browser requests use `grounded-brief-request@2` and produce the v2 Script Brief result.

A v2 request has this shape:

```json
{
  "schema_version": "grounded-brief-request@2",
  "request": "Focus on the protagonist's arc and what production should prepare for."
}
```

The request is optional. When it is omitted, the server applies this default intent:

> Create a concise filmmaker-facing brief with the story essentials, key characters, setting, tone, themes, useful production details, and any open questions or gaps.

The v2 result has this shape at its core:

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

The browser also offers **Copy brief**. Copying creates no external record and does not publish or share the source.

## 4. Bounded whole-document grounding

The previous excerpt picker selected at most six matching excerpts and approximately 6,000 characters. That is not the v1 product strategy.

The v2 local grounding seam performs a bounded whole-document condensation:

- upload size remains at most 5 MiB;
- extracted text remains bounded at 120,000 characters;
- source chunks remain bounded at 240 chunks of at most 900 characters;
- condensation evaluates every available bounded chunk;
- up to 24 excerpts and approximately 18,000 characters are sent to the brief writer;
- relevant chunks receive priority, while evenly spaced chunks preserve opening, middle, ending, and section coverage for long scripts;
- every condensed excerpt retains its citation ID, ordinal, page or section location, and source mapping;
- a missing or unreadable source produces a safe gap rather than an invented brief.

This is a condensation strategy, not a claim that an unbounded document is held in a model context. A future external grounding adapter must preserve the same bounded selection, location, citation, retention, and failure contract and requires a separate product decision.

A source excerpt is evidence for what the source says. It is not evidence of rights, approval, production feasibility, audience performance, or permission to publish.

## 5. Prompt and model boundary

The Script Brief prompt is server-owned and versioned as `movie-inator-script-brief@2`. The browser supplies only request intent. The prompt defines:

- the filmmaker-facing role and the source-only boundary;
- the exact `grounded-script-brief@2` output schema;
- logline, synopsis, list, citation, and output length limits;
- the rule that each material claim cites supplied source IDs;
- the rule that open questions can identify an unsupported absence without a citation;
- rejection of invented facts, unsafe text, tools, browsing, providers, credentials, approval, publishing, and side effects;
- safe failure behavior using empty lists or a clearly labelled source gap.

The default `FakeModel` path is deterministic and credential-free. It exercises the same v2 schema and citation checks. The optional Gemini REST path is server-only and credential-gated. It is selected only when server configuration is explicitly enabled, complete, and marked ready. No browser value can enable Gemini or select its project, location, model, endpoint, auth mode, or generation settings. No credentials are added or enabled by this release.

If Gemini is unavailable, malformed, unsafe, over budget, or not ready, the worker uses the deterministic safe template or records a recoverable failure according to the existing recovery boundary. It never silently changes to a live provider or uses a credential supplied by the user.

## 6. Browser experience

The landing experience is the Script Brief upload flow. It visibly labels local mock mode as **Demo mode** and explains that files remain in the Movie-Inator instance. The first interaction presents:

1. **Upload script** - one PDF or TXT file, with bounded size and safe ingestion feedback.
2. **Tell us what you want** - an optional plain-language request. Leaving it blank uses the server-owned default.
3. **Create brief** - one action that starts the bounded read-only worker.
4. **Read or copy the result** - the structured sections, source citations, and limitations.

The active result view uses filmmaker language such as “Reading your source”, “Preparing your brief”, and “Checking source links”. Internal phase, provider, model, provenance, and recovery details remain available to the developer/operator surface or safe citation drawer, not the first screen.

The browser must retain accessible labels, keyboard focus, visible focus states, reduced-motion support, safe text rendering, responsive layout, and source citation focus return. A result remains useful if a section is empty: it says that the source did not establish the detail and surfaces an open question.

## 7. Secondary Audience Data Readiness workflow

Audience Data Readiness remains available from **Developer details**. It is not the landing workflow and must not dominate the primary page. Its existing contracts, deterministic policy authority, evidence bundle, recovery, SSE, durable state, and safe projections are preserved.

The readiness workflow remains a bounded read-only demo for one audience or campaign asset. `READY`, `REVIEW`, `BLOCKED`, and `UNKNOWN` remain deterministic policy decisions. Its technical progress, role map, partner readiness, checkpoints, and evidence inspection stay behind the secondary surface. No publishing, approval, external partner side effect, or data mutation is added.

## 8. Existing backend phases and evidence

The Script Brief uses the existing document upload, local source, citation, store, worker, model gateway, Gemini seam, provenance, retry, and safe projection boundaries where sound. The worker may retain internal states such as accepted, queued, grounding, composing, validating, succeeded, grounding gap, failed, and canceled. Those states are not the customer-facing first-screen vocabulary.

The backend continues to preserve:

- deterministic local source records and source hashes;
- page or section and line source locations;
- prompt, schema, model, source, and generation provenance for authorized technical inspection;
- bounded events, recovery, retry lineage, and immutable failed runs;
- server-side Gemini readiness and credential gates;
- safe citation routes that do not return prompts, tokens, raw provider payloads, or hidden reasoning;
- existing Audience Data Readiness records and APIs.

Technical details are developer-only disclosure. Hiding a button is not an authorization boundary, so server routes continue to return safe projections rather than private model reasoning or secrets.

## 9. API and safety boundaries

The existing document routes remain:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/v1/documents` | Upload one bounded PDF or text source. |
| `GET` | `/v1/documents/{document_id}` | Read safe document metadata. |
| `POST` | `/v1/documents/{document_id}/briefs` | Create an idempotent Script Brief request. |
| `GET` | `/v1/script-briefs/{run_id}` | Read the safe Script Brief projection. |
| `GET` | `/v1/script-briefs/{run_id}/events` | Read safe progress events. |
| `GET` | `/v1/documents/{document_id}/citations/{citation_id}` | Read one bounded source citation. |
| `POST` | `/v1/script-briefs/{run_id}/retry` | Create an immutable child after a recoverable failure. |

Requests reject unknown fields and client authority fields. Uploads reject unsupported types, invalid encoding, malformed PDFs, and oversized bodies. Source text is normalized and redacted before storage. The browser cannot provide URLs, SQL, tools, providers, model settings, credentials, approval, publication, or side-effect instructions.

The worker must not publish a result unless the proposal matches the approved schema, every material citation ID exists in the selected source, source locations are preserved, and unsafe text is rejected. One bounded model repair remains allowed only where the configured Gemini budget permits it; deterministic fallback is preferred in mock mode.

## 10. Non-goals and future decisions

This launch does not add:

- video, audio, image, music, or VFX generation;
- rights or legal conclusions;
- publishing, distribution, campaign, approval, or partner writes;
- arbitrary web browsing, SQL, MCP discovery, or tool calls;
- cloud document stores, external vector search, or automatic provider fallback;
- credentials, ADC files, tokens, or hidden customer memory.

A future grounding provider, media adapter, collaboration surface, project memory, or side-effect workflow needs its own versioned contract, provenance, safety limits, evaluation set, retention decision, and Captain approval.

## 11. Acceptance and validation

The release must have focused tests for:

- PDF and text upload bounds and source locations;
- default request and plain-language request intent;
- v2 structured output for every Script Brief section;
- long-source whole-document coverage and late-source material;
- citation integrity for every material claim;
- deterministic mock selection and visible Demo mode;
- credential-gated Gemini selection with zero credentials in mock mode;
- safe malformed and unsafe model fallback;
- immutable recovery and retry behavior;
- the primary browser flow, copy action, expandable citations, and secondary readiness surface.

The repository regression gate is:

```sh
npm test && npm run check
```

`npm run check:docs` verifies that the README product description contains an exact copy of this PRD between its markers. No generated state, credentials, temporary source material, or review artifact belongs in the repository.
