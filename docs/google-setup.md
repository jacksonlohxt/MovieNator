# Google model setup - operator-only, not enabled

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
GOOGLE_ENDPOINT=<CAPTAIN_SELECTED_ENDPOINT_HOST>
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

## Request boundary

The first request is the standard server-derived `generateContent` REST method:

```text
POST https://<region>-aiplatform.googleapis.com/<api-version>/projects/<project-id>/locations/<region>/publishers/google/models/<model-id>:generateContent
```

The v1 adapter sends bounded contents, a fixed system instruction, and bounded generation settings. It deliberately omits `tools` and `toolConfig`. A fake transport and injected token provider cover the adapter tests, so validation never requires Google ADC, a project, a network credential, or a live endpoint.

Google output is proposal-only. Deterministic code owns asset resolution, provider selection, EvidenceBundle construction, policy status, evidence authority, safe projection, persistence, publishing, export, mutation, approval, purchase, deployment, and every other side effect.
