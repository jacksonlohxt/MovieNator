> **PRD source of truth:** [`docs/prd.md`](docs/prd.md) is canonical for the complete PRD. The README includes the current MovieNator product surface and an exact PRD copy below; maintain `docs/prd.md` and run `npm run check:docs` to detect drift.

# MovieNator

MovieNator is a focused media-production workspace whose primary experience is a producer-facing **Script Brief**: upload one bounded screenplay PDF or TXT, optionally choose a production focus, and receive a structured intelligence brief with exact source citations and follow-up questions. It is designed to reduce manual production preparation, not to replace a producer's judgment.

The primary flow is:

```text
Upload screenplay -> Choose an optional producer focus -> Create brief -> Inspect citations and next questions
```

MovieNator is the exact product display name, with `movieinator` as the machine-safe identifier for new package, browser-state, container, local endpoint, schema-host, and related product-owned identifiers. Existing run IDs, API routes, workflow IDs, durable records, and legacy browser/session keys remain compatible during the rename. New browser state is written under `movieinator-*`; existing `movie-inator-*` and `gemini-agents-*` values are read and copied without deleting the old values.

## Product boundaries

MovieNator is inspired by source-grounded research tools, but it is not a general NotebookLM-style notebook, a broad research assistant, or Google's product. It reads one bounded screenplay and produces operational preparation: scene and location wording, INT/EXT and day/night, cast and role demands, physical requirements, timing and continuity signals, source-indicated risk signals, and unanswered producer decisions.

The local default remains deterministic/mock and requires no credentials or external calls. The reviewed producer-intelligence implementation described in the PRD is not claimed as landed by this documentation update. An optional provider seam in the repository is not a claim of live Gemini use. No budget, permit, schedule, availability, legal, booking, rights, external-location, publishing, approval, or autonomous-production conclusion is supplied by the product.

## Current status

The repository contains mock-safe Script Brief upload and grounding plumbing, source-location citation infrastructure, an existing broad Script Brief result shape, and the browser shell. It does not claim a live Gemini integration, Agent Builder integration, IBM or other partner integration, hosted deployment, Bob evidence, or contest eligibility. No credentials, cloud resources, external source material, or side effects are enabled by this PRD refinement.

```sh
npm test
npm run check
npm run check:docs
npm start
# open http://127.0.0.1:4173
```

The current server routes and secondary Audience Data Readiness workflow remain available for implementation compatibility. They are not evidence that the reviewed producer-intelligence output contract has shipped. Local run and source records are written under `.data/` and are ignored by git.

## Local documentation

- [Product requirements document](docs/prd.md) - the canonical producer-intelligence product and contract definition.
- [Implementation guide](docs/implementation.md) - current contracts, mock fixtures, recovery semantics, browser behavior, and validation commands.
- [MovieNator Phase 4 state and logic hosting guide](docs/phase4-state-logic-hosting.md) - durable checkpoints, allowlisted local tools, bounded proposals, recovery, and the future runtime boundary.
- [MovieNator Phase 2 script grounding operator guide](docs/phase2-script-grounding.md) - current upload bounds, whole-document condensation, citations, operator boundaries, and future provider seams.
- [Phase 5 deployment and safety runbook](docs/phase5-deployment.md) - operator-only deployment placeholders and future runtime boundaries, not a hosted-product claim.
- [Phase 3 partner integration operator guide](docs/partner-integration.md) - local automation, read-only registry rules, readiness and recovery, and the later live-access boundary.

The PRD remains the source of truth for product detail. Audience Data Readiness and technical inspection stay behind Developer details while the producer-facing Script Brief remains primary.

---

<!-- PRD:START -->
# MovieNator product requirements document

**Status:** Canonical producer-intelligence MVP definition; this document describes the reviewed product target, not proof that every target behavior is already shipped.
**Scope:** Product and contract source of truth. This document authorizes no credentials, cloud mutation, publishing, approval action, external research, or production side effect.
**Primary workflow:** `Script Brief`, delivered as a producer intelligence brief
**Secondary workflow:** `Audience Data Readiness`

## 1. Product definition and promise

MovieNator is a focused media-production workspace. It takes one bounded screenplay PDF or TXT and turns it into a source-grounded producer brief: what the screenplay explicitly requires, where and when scenes occur, who and what production must prepare, which signals may affect planning, and which decisions remain unanswered. The product is inspired by source-grounded research tools, but it is not a general notebook, a general research assistant, a NotebookLM clone, or Google's product.

The promise is operational rather than summarization-oriented:

> Give a producer a cited first-pass production intelligence brief from one screenplay, so manual extraction becomes a focused review of facts, uncertainties, risks, and next questions instead of a second read performed with a spreadsheet open.

The brief reduces preparation work without pretending that the screenplay contains a budget, permit status, schedule, location availability, legal answer, or other fact it does not contain. Every material production fact is traceable to the screenplay. Every absent or unclear fact is labelled as such and turned into a useful producer question where possible.

### The producer problem

A producer can receive a screenplay and still be far from ready to plan. Before a production conversation can begin, someone usually has to manually extract scene locations and headings, INT/EXT and day/night, cast and role demands, props, vehicles, costumes, set requirements, stunts, VFX, sound, weather, crowds, minors, animals, company moves, continuity clues, timing signals, production risks, and unanswered decisions. That work is repetitive, easy to miss, and difficult to audit when the source wording matters.

A generic logline, synopsis, or broad script summary does not solve this problem. It can explain what the story is about while leaving a line producer without a scene breakdown, a production manager without a list of physical requirements, and a development producer without a clear set of questions to take back to the writer or director. MovieNator therefore treats story orientation as supporting context, not as the product's operational output.

### Product boundary

MovieNator reads the uploaded screenplay and produces a read-only preparation artifact. It does not decide whether a production is feasible, set a budget, secure a location, determine a legal obligation, obtain a permit, book a person or resource, clear rights, or make an autonomous production decision. A source citation proves what the screenplay says. It does not prove that the described thing is available, affordable, legal, permitted, safe, or approved.

## 2. Target users and jobs to be done

Primary users include:

- **Line producers and production managers** preparing an early breakdown and the first planning conversation.
- **Development producers** assessing a screenplay and preparing practical questions before advancing it.
- **Writers and directors** preparing to discuss the production implications of their screenplay with a producing team.
- **Creative operations teams** turning script information into a consistent review packet without losing source traceability.
- **Assistant directors, coordinators, and other production staff** who need a fast, cited orientation before a human-led planning pass.

The primary job is:

> When I receive a screenplay, help me see the production-relevant facts and gaps in a scanable structure, with exact citations, so I can prepare the next conversation without manually rereading the whole script to build the first checklist.

Supporting jobs are:

- When I am preparing a breakdown, find every stated location, scene condition, cast demand, physical requirement, and timing signal without silently filling gaps.
- When I am preparing a writer or director conversation, show which decisions the screenplay leaves open and phrase them as useful follow-up questions.
- When I am challenged on a detail, let me inspect the exact scene heading or excerpt instead of relying on an uncited paraphrase.
- When I am handing work to another producer, give me a bounded brief that preserves what is known, what is unclear, and where each statement came from.
- When I have a particular concern, let me choose a focus such as night exteriors, minors, vehicles, or company moves without allowing that focus to change the source boundary.

## 3. Key moments and user journey

### Key moments

1. **Script receipt:** A producer receives a screenplay and needs a useful first read before a planning meeting.
2. **First breakdown:** The producer wants to spot scene logistics and physical demands before opening a stripboard, budget, or location conversation.
3. **Creative conversation:** A writer or director needs to know which production questions will come up and which details need clarification.
4. **Uncertainty review:** The team needs to separate screenplay facts from assumptions and decide what to ask next.
5. **Handoff:** A colleague needs a compact preparation artifact with citations rather than a new uncited summary.

### User journey

```text
Upload one screenplay PDF or TXT
  -> optionally choose a producer focus
  -> receive a structured production intelligence brief
  -> scan scene, cast, requirements, risks, and open decisions
  -> inspect exact source citations
  -> turn missing or ambiguous facts into follow-up questions
  -> copy the brief into the next human-led production conversation
```

The upload is one bounded screenplay. The optional focus is plain-language intent, for example `focus on locations, night work, and company moves` or `prepare questions about minors and animals`. It is not a provider, model, browsing, budget, approval, or side-effect control.

After upload, the result is useful when a reviewer can immediately answer:

- Which scenes and exact source locations need attention?
- What does the screenplay explicitly require from cast, crew, objects, environments, and special effects?
- Which timing, continuity, movement, or risk signals should be discussed?
- What does the screenplay not establish, and what should the producer ask next?
- Where in the screenplay can each material statement be checked?

The result remains read-only. Copying a brief creates no external record and does not publish, share, book, approve, or alter the source.

## 4. Actionable production intelligence brief

The production intelligence brief is a structured artifact, not a long narrative summary. It should put the following sections in an obvious, scanable order. Empty sections remain visible as `Not stated in the source` or an equivalent explicit gap rather than disappearing or being filled by inference.

### Required sections

| Section | Required content and behavior |
|---|---|
| **Brief orientation** | A short source-grounded premise or story orientation may help a reviewer enter the document, but it is not a substitute for the breakdown. |
| **Scene and location breakdown** | Scene order or identifier when present, exact scene heading or location wording, `INT`/`EXT`, day/night, and scene-specific logistics, each with source citations. |
| **Cast and role demands** | Named roles, speaking or appearing demands, groups, extras, role relationships, and explicit performance or action demands. Do not infer casting, availability, age, rates, or contracts. |
| **Props and vehicles** | Explicitly used, carried, displayed, damaged, or required props and vehicles, tied to the scene or passage that names them. |
| **Costumes and set needs** | Costume changes or notable wardrobe requirements, built or dressed set requirements, practical locations, and set-specific action stated by the screenplay. |
| **Stunts, VFX, sound, and weather** | Written stunts or hazardous action, visual effects or special physical phenomena, sound or music cues that affect production preparation, and weather or environmental conditions explicitly present in the source. |
| **Crowds, minors, and animals** | Explicit crowd or extra demands, minors, animals, and their scene context. The brief must not turn a role description into a legal or welfare conclusion. |
| **Company moves and continuity** | Named movement between locations, repeated locations, continuity-sensitive objects or states, time jumps, chronology cues, and other scheduling signals stated or directly signalled by the screenplay. |
| **Production risk signals** | Source-indicated planning signals such as a written crowd, night exterior, stunt, animal, weather event, or location change. The brief reports the signal and its citation, not a cost, feasibility, safety, permit, or legal verdict. |
| **Unanswered producer decisions** | Concrete questions created by missing, ambiguous, or conflicting source information, with relevant context citations when available. These questions are the handoff to the next human conversation. |
| **Source citations and coverage** | Expandable citations to the exact page, scene heading, section, or line excerpt used for each material statement, plus a clear note about source limits or unreadable portions. |

A scene-level entry should make the source wording and production meaning separable. A useful record has, at minimum, the scene reference, the exact source text or faithful quoted wording, a concise production fact, a status such as `stated`, `ambiguous`, or `not_stated`, and one or more citation IDs. A producer question is a question, never a disguised fact.

### Location fidelity rule

MovieNator must preserve the screenplay's exact location wording at the level the source provides. If the source says `Singapore`, the brief may report `Singapore` with a citation. If a scene heading says `EXT. JALAN BESAR - NIGHT`, the brief preserves `JALAN BESAR` and `NIGHT` rather than replacing the street with a generic city label. If the screenplay names a district, street, building, venue, or other place, that wording stays attached to the relevant scene and citation. A broad source mention and a narrower scene heading may both be retained when both are present.

If the source only says `A STREET`, `AN APARTMENT`, or otherwise does not identify an exact place, the brief says that the exact location is **not stated in the source**. It then asks a useful question such as `Which street or venue should production hold for this scene?` It must not guess a Singapore district, a building, a permit, a budget, a schedule, location availability, or a legal conclusion.

The same rule applies to every category. If the screenplay does not state a crowd size, vehicle availability, date, duration, budget, permit, casting decision, weather forecast, or rights position, the brief says so and asks the appropriate producer question instead of inventing precision.

### Example

Suppose the source contains:

```text
12. EXT. JALAN BESAR - NIGHT
Rain needles the pavement. A HUNDRED EXTRAS pour from the station as LINA runs toward a waiting van.
```

A source-grounded production section can say:

- **Scene 12:** `JALAN BESAR`; `EXT`; `NIGHT`; rain is written; a hundred extras are written; Lina runs toward a van. Each item links to the scene citation.
- **Risk signal:** The scene combines a night exterior, rain, a crowd, running action, and a vehicle. This is a source-indicated preparation signal, not a budget, safety, permit, or feasibility conclusion.
- **Not stated:** The screenplay does not state the exact station, rain method, van availability, crowd procurement plan, or permit status.
- **Producer questions:** Which station or venue is intended? What crowd and vehicle approach should the production evaluate? These questions do not assert answers.

The brief must not change the location to `Singapore city`, claim that a permit is required, estimate a crowd budget, or assign a shooting date. If the source instead only said `EXT. A STREET - NIGHT`, it would preserve `A STREET` and ask for the intended place.

## 5. Source grounding, uncertainty, and traceability

The source is the screenplay supplied for this run. The default brief covers the whole bounded source through a bounded extraction or condensation process. Relevance ranking may help presentation, but it must not discard opening, middle, ending, or scene-heading coverage in a way that makes the brief appear complete when it is not.

Every material claim in the brief must carry a citation ID that resolves to a bounded source excerpt and its page, section, scene, or line location. Citations must be inspectable from the result without exposing prompts, credentials, hidden reasoning, or raw provider payloads.

The brief distinguishes at least these states:

- **Stated:** the screenplay explicitly supplies the fact.
- **Ambiguous or conflicting:** the screenplay contains unclear or inconsistent wording; the brief quotes the context and asks for clarification.
- **Not stated:** the bounded source does not establish the requested fact.
- **Producer question:** a follow-up prompt derived from a stated gap or ambiguity. It is not evidence that an answer is true.

A citation is evidence for what the screenplay says. It is not evidence of rights, approval, feasibility, availability, safety, budget, permits, schedule, legal status, or permission to produce or distribute the work. The brief never infers those conclusions from genre convention, geography, a likely production practice, or outside knowledge.

## 6. Producer focus and UX principles

The optional producer focus changes emphasis and ordering, not the source boundary or required uncertainty behavior. A focus may ask for locations, night work, cast demands, animals, VFX, continuity, or another bounded production concern. The default focus covers all required sections.

The experience follows these principles:

1. **Producer-first, not summary-first:** lead with what a planning team needs to prepare, then offer only enough story orientation to navigate the brief.
2. **Scan before deep read:** use clear sections, scene references, category labels, and concise facts so a reviewer can identify follow-up work quickly.
3. **Citation at the point of use:** keep the exact source excerpt one click away from each material fact.
4. **Uncertainty is a first-class result:** show `not stated`, ambiguity, and questions prominently. Do not make a blank field look like a confirmed negative.
5. **No false precision:** preserve exact wording and source scope. Never add a place, number, date, cost, availability, permit, or legal conclusion.
6. **Questions are useful output:** missing facts become specific producer prompts, not a generic warning that the script is incomplete.
7. **Bounded and honest:** show source limitations, keep input and output bounded, and fail safely when the source is missing, unreadable, unsafe, or over budget.
8. **Read-only by default:** the product prepares a human decision, but does not make or execute the decision.
9. **Accessible and reviewable:** retain keyboard access, visible focus, responsive layout, reduced-motion support, safe text rendering, and citation focus return.

## 7. MVP commitments

The producer-intelligence MVP commits to:

- accepting one bounded PDF or UTF-8 TXT screenplay;
- allowing an optional plain-language producer focus;
- producing the required structured sections, including scene/location wording, scene conditions, cast and role demands, physical requirements, timing and continuity signals, production risk signals, and unanswered producer decisions;
- attaching valid source citations to material production facts and preserving exact named locations and scene headings;
- explicitly marking absent or ambiguous information and generating useful follow-up questions;
- keeping the result read-only, copyable, and bounded in source, response time, and response size;
- using a deterministic local/mock default so product behavior can be reviewed without credentials or external services;
- exposing technical provenance only as an operator or developer concern, not as a substitute for a producer-facing brief.

The MVP may include a short logline or synopsis for orientation, but a generic story summary is not an acceptable substitute for any required production section. The implementation must not claim the producer-intelligence MVP is complete until its versioned output contract, source citations, uncertainty behavior, fixtures, and browser presentation have been reviewed against this PRD. This document does not itself authorize application code, schema, provider, hosting, or credential changes.

## 8. Explicit non-goals and future work

The MVP does not provide:

- budgeting, cost estimation, financing, or rate calculation;
- permit research, location availability, external location intelligence, or web research;
- stripboard scheduling, shooting-day allocation, call sheets, or production calendar commitments;
- booking, procurement, casting, crew assignment, or resource reservation;
- rights clearance, legal advice, insurance advice, safety certification, or compliance conclusions;
- autonomous production decisions, approvals, publishing, distribution, or external partner writes;
- general multi-source notebooks, open-ended chat over a personal knowledge base, or a general-purpose research assistant;
- video, audio, image, music, or VFX generation.

Budgeting, permit and location research, stripboard scheduling, booking, rights clearance, external location intelligence, collaboration, project memory, and autonomous or side-effect workflows are future work. Each future capability needs its own input and output contract, provenance, safety and authority boundary, retention decision, evaluation fixtures, and explicit product approval. A future grounding or model provider must preserve this source and citation contract; the presence of a provider seam is not a product commitment.

## 9. Measurable MVP success criteria

These are pass/fail product and engineering criteria for a fixed screenplay evaluation set. They are not unsupported business forecasts or claims about market outcomes.

1. **Actionable source facts:** Every seeded production fact in the evaluation screenplay that is emitted as a material claim appears in the correct brief section with at least one citation ID that resolves to the source passage and location. Unknown citation IDs and uncited material production claims are failures.
2. **Location fidelity:** Every emitted exact location is supported by the cited screenplay wording at the same or narrower scope. A test screenplay containing a named city, district, street, building, and venue must preserve the supplied wording and must not introduce a more specific place that is absent.
3. **Explicit uncertainty:** For each seeded fact intentionally removed or made ambiguous from an evaluation screenplay, the brief marks it `not stated` or `ambiguous` and produces a useful follow-up question where a producer could act on the gap. No withheld value may appear as a confirmed fact.
4. **Category coverage:** The evaluation set exercises locations, scene conditions, cast, props, vehicles, costumes, set needs, stunts, VFX, sound, weather, crowds, minors, animals, company moves, continuity or scheduling signals, risk signals, and unanswered decisions. Each supplied signal is either surfaced with a citation or explicitly reported as not stated when it is absent.
5. **Next-question usability:** In a review protocol, a reviewer who has not reread the screenplay can identify the evaluation set's seeded unanswered producer decisions from the brief alone. A question is not counted if it is only a generic `please clarify` prompt or if it presents an invented answer.
6. **Bounded response:** The implementation enforces a request deadline and returns either a completed bounded brief or a safe, clearly labelled failure before that deadline. It never waits indefinitely. The brief has explicit configured maximum characters and item counts for every list, and tests assert those caps. The test also asserts the existing bounded ingestion limits of 5 MiB per upload, at most 120,000 extracted characters, bounded source chunks, and bounded citation excerpts; the producer-intelligence output contract must define and test its own caps before it is landed.
7. **Deterministic default:** With the same source, focus, and configuration, the local default produces repeatable facts, uncertainty labels, citation mappings, and bounded output without credentials, network access, or external side effects.
8. **Reviewer traceability:** For each sampled material claim, a reviewer can open the citation and find the supporting screenplay wording without rereading the entire screenplay. A citation that only points to a broad document or an unrelated passage fails.

## 10. Current implementation status and validation

The local default remains deterministic/mock. The committed repository contains mock-safe upload and grounding plumbing, source-location citation infrastructure, a broad Script Brief result shape, and the existing browser shell. Those pieces are scaffolding for this refinement. The reviewed producer-intelligence implementation and the output contract described in Sections 4 and 7 are not being claimed as landed by this PRD update.

An optional server-only Gemini adapter may exist in the repository behind explicit operator configuration, but no live Gemini use is claimed or required here. This repository and PRD make no claim of live Gemini, Agent Builder, IBM or other partner integration, hosted deployment, Bob evidence, or contest eligibility. No credentials, cloud resources, external sources, or production side effects are enabled by this product definition.

Before the producer-intelligence implementation is considered landed, validation must cover PDF and TXT bounds, whole-document scene coverage, exact location preservation, every required production category, citation integrity, absent and ambiguous facts, focus behavior, deterministic mock behavior, bounded failure, copy and citation UX, and the reviewer next-question protocol. The secondary Audience Data Readiness workflow remains outside this primary producer problem.

The repository documentation gate is:

```sh
npm run check:docs
```

The default regression gate remains:

```sh
npm test && npm run check
```

`README.md` must contain an exact copy of this PRD between the required PRD boundary markers. No generated files, credentials, temporary source material, or review artifact belongs in the repository.
<!-- PRD:END -->
