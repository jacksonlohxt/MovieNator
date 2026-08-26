# Parallel Search external evidence enrichment

MovieInator's Producer Intake Decision Packet can optionally enrich itself with bounded, cited,
real-world research from [Parallel](https://parallel.ai)'s Search API. This is additive, read-only,
credential-gated, and off by default; the deterministic packet builder never depends on it, and no
existing packet field, classification, or evidence state is changed by enabling it.

## What it does

When configured, the packet builder deterministically detects up to a few bundle-relevant research
topics from the already-built strict `producer-intake-decision-packet@1` packet (never from a live
model, never randomly):

- **Location suggestions and permit lead time** - when the primary screenplay's scene index establishes a setting or scene heading. The request uses the configurable `target_region` packet field, defaulting to Singapore.
- **Minor labor rules** - when a cast or role demand references a minor (child, kid, or teenager), with the configured target region included in the cited request.
- **Stunt safety and turnaround rules** - when a production element is classified `stunts`, with the configured target region included in the cited request.
- **Vendor or day-rate ranges** - when the bundle supplies a budget input. These are external estimate ranges only and never a computed total or tier decision.

For each selected topic it issues one Parallel Search call (`objective` plus 2-3 short keyword
`search_queries`) and maps every returned result into a new `external_evidence` row on the packet. Location suggestions, permit guidance, minor-labor material, stunt/turnaround guidance, and vendor/day-rate ranges remain externally supplied evidence for a human to verify.

- `classification: "externally_researched_fact"`
- `evidence_state: "externally_researched_not_verified"`
- a citation (`producer-citation@1`, `media_type: "text/html"`, `source_kind: "external_research"`)
  whose `source_locations` entry is the exact Parallel result URL, and whose `excerpt` is the exact
  Parallel excerpt text
- a `next_action` that routes the finding to the responsible producer or department lead for manual
  verification

A Parallel finding is **never** presented as a legal conclusion, an approval, a booking, or a verified
fact. It is always additional, clearly labelled, cited evidence for a human to check, consistent with
every other externally supplied row in the packet's existing evidence-state model (see
`docs/prd.md` section 5 and `schemas/producer-intake-decision-packet@1.json`).

If a Parallel call fails (auth, rate limit, timeout, or any other transport failure), the topic
degrades to a single bounded `evidence_state: "unavailable"` row instead of failing the whole packet
build; no provider fallback content is invented.

## Configuration

The feature is controlled entirely by server-owned environment configuration, read by
`readParallelConfig` in `src/parallel-search.js` (the same "config-gated, fail-closed" seam pattern used
by `src/gemini-rest.js` and `src/secrets.js`):

| Variable | Effect |
|---|---|
| `PARALLEL_API_KEY` | Required to enable the feature at all. Never commit this value. Read it from your own secret store or `.env.local` (already git-ignored), exactly like other credentials described in `src/secrets.js`. |
| `PARALLEL_ENABLED=false` | Explicit override to force the feature off even when `PARALLEL_API_KEY` is set. |
| `PARALLEL_SEARCH_MODE` | One of `turbo`, `fast`, `basic`, `advanced` (default `advanced`, per the Parallel Search API). |
| `PARALLEL_TIMEOUT_MS` | Per-call timeout, bounded to 1,000-30,000ms (default 8,000). |
| `PARALLEL_MAX_TOPICS` | Maximum research topics per packet, bounded to 1-4 (default 2). |
| `PARALLEL_MAX_RESULTS_PER_TOPIC` | Maximum Parallel results mapped into evidence per topic, bounded to 1-5 (default 3). |

Without `PARALLEL_API_KEY`, `readParallelConfig` reports `enabled: false`, the packet builder never
imports a live client or makes a network call, and every packet's `external_evidence` array is `[]`
with `provenance.external_evidence_enabled: false`. This is the default for `npm test`, `npm run check`,
local development, and CI.

## Runtime shape

- `src/parallel-search.js` imports the official `parallel-web` SDK (`import Parallel from "parallel-web"`)
  and constructs `new Parallel({ apiKey, timeout })` only when a client is not injected and an API key is
  configured; `ParallelSearchClient.search()` calls the real `client.search(objective, search_queries)`.
  No LangChain, Vercel AI SDK, or other agent framework is used; Google Gemini remains the only other
  runtime AI dependency (`src/gemini-rest.js`).
- `createApp` in `src/server.js` wires a default producer packet builder via
  `createParallelEnrichedProducerBuilder`, which runs the existing deterministic
  `buildProducerDecisionPacket` first and then, only when configured, calls
  `enrichProducerPacketWithParallelEvidence`. Passing an explicit `producerBuilder` (as tests already do
  for retry scenarios) fully overrides this composition.
- Tests inject a mock object exposing an async `search(body, options)` method (matching the SDK's exact
  request/response shape) via the `client`/`parallelClient` options, so `test/parallel-search.test.js`
  exercises query construction, evidence mapping, citation shape, config gating, and error handling with
  zero live network calls. One test also drives the real `Parallel` SDK class with an already-aborted
  `AbortSignal` to prove the genuine import-and-call path works without any network I/O.
- The strict packet schema (`schemas/producer-intake-decision-packet@1.json`) adds an optional
  `external_evidence` array (reusing the existing `canonical_item` shape), two new `provenance` fields
  (`external_evidence_enabled`, `external_evidence_provider`), a `target_region` packet field, a `text/html` citation `media_type`, and
  two new evidence values (`externally_researched_fact` classification,
  `externally_researched_not_verified` evidence state). `src/contracts.d.ts` mirrors these additions. The
  older `producer-decision-packet@1` legacy compatibility contract is untouched; enrichment is a no-op
  for it.
- The browser's Producer tab renders `external_evidence` through the same generic
  `renderProducerEvidenceList` used for every other evidence section, plus a dedicated "External evidence
  (Parallel Search)" section in `web/index.html`, and the read-only Markdown/JSON/CSV handoff exports
  include it as well.

## Enabling it locally

```sh
# .env.local (already git-ignored)
PARALLEL_API_KEY=<your Parallel API key from platform.parallel.ai>
```

Then start the server with `npm run start:google` (or any command that loads `.env.local`) or export the
variable directly in your shell before `npm start`. See
[`docs/operator-runbook.md`](operator-runbook.md) for the exact operator steps.
