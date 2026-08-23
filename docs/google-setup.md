# Movie-Inator Google model setup - operator-only, not enabled

This document describes the credential-gated foundation for a future internal Google model run. It does not select a project, billing account, region, model, identity, retention policy, source policy, or public enablement. The application and tests do not run the commands below.

## Required Captain/operator choices

Fill these placeholders only in a server deployment configuration approved by the operator:

- Project ID: `<CAPTAIN_SELECTED_PROJECT_ID>`
- Billing account: `<CAPTAIN_SELECTED_BILLING_ACCOUNT>`
- API: `aiplatform.googleapis.com`
- Region and endpoint: `<CAPTAIN_SELECTED_REGION>` / `<CAPTAIN_SELECTED_ENDPOINT_HOST>`
- Exact model ID: `<CAPTAIN_SELECTED_MODEL_ID>`
- REST API or SDK version: `<CAPTAIN_SELECTED_API_VERSION>`
- Authentication and workload identity: `<CAPTAIN_SELECTED_AUTH_MODE>`
- Retention, residency, source policy, quota, and public enablement: `<CAPTAIN_SELECTED_POLICY>`

The project ID, location, endpoint, publisher, model ID, generation limits, and authentication mode are server configuration. Browser requests and model output cannot set them.

## Server configuration shape

The default remains deterministic mock mode:

```sh
MODEL_BACKEND=fake
GOOGLE_GEMINI_ENABLED=false
GOOGLE_PROJECT_ID=<CAPTAIN_SELECTED_PROJECT_ID>
GOOGLE_LOCATION=<CAPTAIN_SELECTED_REGION>
GOOGLE_MODEL_ID=<CAPTAIN_SELECTED_MODEL_ID>
GOOGLE_PUBLISHER=google
GOOGLE_ENDPOINT=<CAPTAIN_SELECTED_ENDPOINT_HOST> # for global, use https://aiplatform.googleapis.com
GOOGLE_REST_API_VERSION=<CAPTAIN_SELECTED_API_VERSION>
GOOGLE_SDK_VERSION=<CAPTAIN_SELECTED_SDK_VERSION>
GOOGLE_AUTH_MODE=<CAPTAIN_SELECTED_AUTH_MODE>
GOOGLE_GEMINI_READINESS=not_run
```

Only an approved server deployment may set `MODEL_BACKEND=google_rest`, `GOOGLE_GEMINI_ENABLED=true`, and move readiness to `passed`. Incomplete configuration is `not_set`; an enabled configuration that has not passed an operator check is `not_run`. Other safe states are `disabled`, `failed`, and `unknown`. A non-passed state makes zero Google requests and keeps `FakeModel` plus `MockProvider` active.

## Operator actions - commands are examples only

After the Captain chooses the project and billing account, an authorized operator may inspect the environment:

```sh
export PROJECT_ID='<CAPTAIN_SELECTED_PROJECT_ID>'
export LOCATION='<CAPTAIN_SELECTED_REGION>'
export MODEL_ID='<CAPTAIN_SELECTED_MODEL_ID>'

gcloud projects describe "$PROJECT_ID"
gcloud billing projects describe "$PROJECT_ID"
gcloud services list --enabled --project="$PROJECT_ID"
```

If approved, an authorized operator may enable the API. This is a cloud mutation and is **not run by the application or tests**:

```sh
gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID"
```

For a local ADC workflow, an authorized operator may use the documented commands below. These commands are **operator actions only** and are not run by tests or the application:

```sh
gcloud init
gcloud components update
gcloud auth application-default login
```

Use an attached workload identity or approved workload federation in production. Do not create, store, commit, log, or send service-account JSON keys. Never put an ADC token or bearer token in browser state, an SSE event, an error, a trace, a fixture, or a report.

## Exact live-run checklist

A live Google result is not proven by a complete configuration or a `passed` readiness value. An authorized operator must complete and retain this sequence:

1. Record the Captain-approved project, billing account, API, region, endpoint host, exact model ID, API or SDK version, authentication mode, source retention/residency policy, quota, budget, and public enablement decision.
2. Inspect the project, billing state, enabled services, model availability, identity, quota, and policy with read-only commands before any cloud mutation.
3. If approved, enable `aiplatform.googleapis.com` and apply least-privilege IAM. These are operator mutations and are not run by the application or tests.
4. For local testing, use an ignored `.env.local` with `DEPLOYMENT_TARGET=local`, `RUNTIME_MODE=adc_local`, `MODEL_BACKEND=google_rest`, `GOOGLE_GEMINI_ENABLED=true`, `GOOGLE_GEMINI_READINESS=passed`, the selected project/location/model/API version, and `GOOGLE_AUTH_MODE=adc`. For Cloud Run, use the placeholder manifest only after replacing every operator placeholder and use an attached identity or approved workload federation.
5. Establish identity safely with local ADC on an authorized operator machine or workload identity in the deployment. Never create, store, commit, log, or transmit a service-account JSON key.
6. Run `npm run start:google` locally or the operator-selected deployment, then require `/readyz` to return HTTP 200 with Google state `passed`. Readiness alone does not prove a model request.
7. Upload a non-sensitive synthetic screenplay fixture and create one Script Brief. Verify the v2 result, all required sections, citation locations, bounds, safe projections, and redacted audit outcome.
8. Preserve a redacted operator record showing that the request reached the selected Google endpoint and returned an accepted model response. Fake transport tests, a readiness response, or a model configuration do not count as live-call evidence.
9. Exercise an unavailable, malformed, unsafe, or over-budget response and confirm deterministic fallback or safe recovery is labelled and does not switch providers silently.
10. If any step is incomplete, keep the deployment in Demo mode or fail closed and do not describe the product as live Google-backed.

No live Google call, selected cloud project, hosted URL, or public Google enablement is proven by this repository.

## Request boundary

The first request is the standard server-derived `generateContent` REST method:

```text
POST https://<region>-aiplatform.googleapis.com/<api-version>/projects/<project-id>/locations/<region>/publishers/google/models/<model-id>:generateContent
```

For the `global` location, the service origin is `https://aiplatform.googleapis.com` rather than `https://global-aiplatform.googleapis.com`. The server can use ADC automatically when `GOOGLE_AUTH_MODE=adc`; the credential client is created only for an approved, passed Google run. The v1 adapter sends bounded contents, a fixed system instruction, and bounded generation settings. It deliberately omits `tools` and `toolConfig`. A fake transport and injected token provider cover the adapter tests, so validation never requires Google ADC, a project, a network credential, or a live endpoint.

Google output is proposal-only. Deterministic code owns asset resolution, provider selection, EvidenceBundle construction, policy status, evidence authority, safe projection, persistence, publishing, export, mutation, approval, purchase, deployment, and every other side effect.
