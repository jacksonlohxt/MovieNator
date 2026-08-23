# MovieNator Script Brief grounding

This is the primary filmmaker-facing workflow. Audience Data Readiness remains available from the secondary Developer details surface. The upload and grounding seams are reused, while the Script Brief result and browser flow are now the product default.

## What is automated

- The server accepts exactly one PDF or UTF-8 plain-text source per upload, enforces a 5 MiB file limit, normalizes a safe filename, bounds extracted text and chunks, and derives a deterministic document ID.
- The local deterministic `GroundingSource` condenses the whole bounded source. It evaluates every available chunk, prioritizes request-relevant chunks, then preserves evenly spaced coverage for long scripts. Every chunk and condensed excerpt keeps a citation ID and a page or section/line location.
- The brief worker receives the bounded condensed excerpts, their citation IDs and locations, and the server-owned v2 Script Brief prompt. It validates `grounded-script-brief@2`, requires citations for material claims, and rejects unknown citations, unsafe text, unbounded output, and side-effect language.
- The browser primary flow is Upload script, Tell us what you want, Create brief, then Read or copy the result. The result contains a logline, approximately 100-word synopsis, main characters, setting/tone/themes, production details, open questions, and expandable citations. There is intentionally no human approval screen because this MVP only reads the uploaded source and projects a bounded brief.
- Mock mode uses `FakeModel` and the local grounding source without credentials or network access. If the optional Google backend is not ready, the existing mock model path remains active. If an explicitly enabled model call is unavailable or invalid, deterministic grounded output is used without changing the source or creating a side effect.

The result is not legal, privacy, rights, publishing, or filmmaker approval. It does not generate or publish video, audio, images, music, or VFX. Mock mode is deterministic and visibly labelled Demo mode. Gemini remains server-only and credential-gated.

## Operator actions that remain manual

An operator still owns authentication, deployment configuration, source retention, access control, quota, budget, and any decision to enable a live model. The selected Google project, location, model, API version, and ADC mode remain server configuration and never come from the browser or model.

For a local ADC-backed run, create an ignored `.env.local` from the verified operator configuration or export the same variables explicitly:

```sh
MODEL_BACKEND=google_rest
GOOGLE_GEMINI_ENABLED=true
GOOGLE_GEMINI_READINESS=passed
GOOGLE_PROJECT_ID=<operator-selected-project>
GOOGLE_LOCATION=<operator-selected-location>
GOOGLE_MODEL_ID=<operator-selected-model>
GOOGLE_PUBLISHER=google
GOOGLE_ENDPOINT=https://aiplatform.googleapis.com
GOOGLE_REST_API_VERSION=v1
GOOGLE_AUTH_MODE=adc
```

Then run:

```sh
npm run start:google
```

Do not put an access token, ADC file, private source, or raw provider response in the repository, browser state, event stream, or logs. The command loads only `.env.local` if it exists. It does not create credentials, enable APIs, or select a project.

## Future grounding seam

`GroundingSource` is product-owned and provider-neutral. `LocalDeterministicGroundingSource` is the only implementation in this slice. A future `VertexAiSearchGroundingSource` or `BigQueryVectorGroundingSource` may implement the same bounded selection and citation contract after separate Captain approval, identity and retention decisions, schema conformance tests, cost/quota review, and a rollback path. No cloud data store is created here and no document is sent to an external grounding service.

## Separate media adapters

Video understanding, VFX analysis, speech/audio generation, image generation, and music generation are follow-up adapters, not hidden capabilities of this workflow. Each needs its own input limits, storage and retention policy, provider and model configuration, cost and quota budget, copyright and training-data posture, safety policy, provenance, rights review, and approval boundary. A grounded script citation must never be treated as authorization to generate, publish, license, or distribute media.
