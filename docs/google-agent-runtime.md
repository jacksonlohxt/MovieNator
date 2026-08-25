# MovieInator Google Agent Platform runtime scaffold

**Status:** infrastructure preparation only. No hosted deployment, live packet tool, model call, IBM integration, or contest compliance claim is enabled.

## Current Google Cloud checkpoint

**Evidence status:** The following Google Cloud state was reported by the operator from Cloud Shell screenshots. It is recorded without secrets and is not independently verified infrastructure proof.

**Completed operator setup:**

- The current product name is **MovieInator**. Lowercase `movieinator` remains the machine-safe identifier for product-owned keys.
- Google Cloud project ID `gemini-agents-505711` is selected; billing and budget are configured; required APIs are enabled.
- Local ADC authentication is complete.
- Runtime service account `movieinator-runtime` was created with `roles/aiplatform.user`.
- The operator reports that managed agent resource `projects/208910370294/locations/global/agents/movieinator-producer-intake` was created in `global` with no tools and no network allowlist.

**Repository preparation already landed:** The Node `@google/genai` 2.18.0 managed-interactions scaffold, read-only MovieInator producer-agent boundary, readiness and provenance evidence, and Cloud Run placeholders are present. This is preparation, not proof of live Google connectivity.

**Next boundary and open work:** The managed agent must receive a secure, server-owned, read-only MovieInator packet tool before it can produce a packet-grounded result. The fixed allowlisted operation is `producer_packet.read / inspect_packet`; no dynamic tool, arbitrary network access, or unreviewed MCP connection is permitted. Agent creation alone does not complete the MVP. There is no Cloud Run deployment, no live MovieInator packet tool or MCP connection, no end-to-end hosted request, no IBM runtime integration, IBM Bob evidence is still pending, and there is no contest-compliance claim.

## Automated versus operator-only execution boundary

The canonical checklist is in [`docs/prd.md`](prd.md). This guide mirrors the same split. Routine code PRs may be reviewed and merged under the standing MVP posture when checks pass, but paid, public, destructive, security-sensitive, and irreversible actions remain operator-controlled.

### Project-owned and autonomous - no cloud mutation

- Run local tests, schema validation, `npm run check`, and `npm run check:docs`.
- Run deterministic mock and synthetic browser/API E2E, including the producer packet fixture.
- Implement the read-only Producer Intake Decision Packet plus its schemas, citations, provenance, readiness, and safe failure behavior.
- Prepare the safe read-only packet-tool/MCP bridge seam with mocks and contract evidence, without live connection or new partner semantics.
- Prepare Cloud Run manifests and preflight/smoke checks that inspect configuration only and make no cloud mutation.

### Operator-only - explicit authorization required

- Change billing, budgets, project/API/account setup, ADC or identity login, IAM/service accounts, or managed-agent creation/update.
- Decide hosting, retention, deletion, residency, privacy, and public/private access, then deploy Cloud Run or another managed runtime.
- Make real Google calls; provide partner credentials; select the exact IBM or other partner runtime/API/MCP surface; or decide its terms and scopes.
- Log into IBM Bob and capture evidence; approve VAPT scope, findings, exceptions, or sign-off.
- Publish a license, public repository/video, Devpost submission, or other contest artifact.
- Resolve unresolved product, safety, security, legal, or privacy decisions.

**Checkpoint:** The operator reports the Google project, billing/budget/API/ADC setup, runtime identity, and managed-agent creation complete, but these are not independently verified. The repository scaffold and documentation checkpoint are landed. Live packet-tool connection, Cloud Run deployment, hosted request, IBM runtime/Bob evidence, contest artifacts, and VAPT findings remain open. No credential, token, private email address, fabricated live evidence, or MVP-live-connected claim is added here.

## Final runtime decision

MovieInator is already a Node web application and Cloud Run is its existing deployment shape. The smallest maintainable adapter is therefore a Node-only `@google/genai` seam, not a Python sidecar:

```text
Browser/API -> MovieInator Node server on Cloud Run -> @google/genai -> one operator-selected managed Agent Platform agent -> Interactions API
```

The Node server remains the browser and API surface, state authority, policy authority, provider-neutral boundary, and safe projection owner. The adapter is implemented in [`src/producer-agent-boundary.js`](../src/producer-agent-boundary.js) and is disabled by default. It preserves the existing server-owned Gemini REST seam for the Script Brief and Audience Data Readiness compatibility paths; Interactions API is a separate, future managed-agent adapter and does not replace that REST path.

A Python ADK sidecar is not required by the acceptance criteria or the official package mapping once the Node SDK path is available. Removing it avoids a second runtime, second container, second readiness surface, and an unnecessary cross-language state boundary.

## Product-owned agent boundary

The boundary is one narrow local HTTP contract:

```text
POST /v1/agent/producer-intake
{"schema_version":"producer-intake-agent@1","packet_id":"packet_..."}
```

Its sole allowlisted call is `producer_packet.read / inspect_packet`. In default `local_mock` mode, the Node application reads one existing packet and returns the existing safe packet projection without network, credentials, model calls, or mutations. In future `managed_interactions` mode, the adapter sends only a bounded packet reference and fixed instruction to one server-configured managed agent through the Interactions API. The managed agent must have the read-only packet tool preconfigured; the adapter sends no dynamic tools, MCP URLs, arbitrary URLs, raw source, or credentials.

The agent cannot create or alter packets, publish, book, approve, spend, browse arbitrary URLs, expose secrets, or mutate production records. Node owns packet persistence, citations, policy, retention, and all side-effect decisions.

## Package and API choice

The official Agentic Cinema rules list `google-adk`, `google-genai`, `google-generativeai`, and `google-cloud-aiplatform` as accepted Google Cloud packages. For this Node application, the JavaScript mapping is the official npm package:

```text
@google/genai==2.18.0
```

`@google/genai` is the Google Gen AI SDK for JavaScript and is imported by the adapter. The package version is pinned in `package.json` and `package-lock.json` for reproducibility; see the [official npm package](https://www.npmjs.com/package/@google/genai). No OpenAI, Anthropic, LangChain, or other AI or agent framework is used.

The official Google Cloud managed-agents guide shows the JavaScript shape:

```js
import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({ vertexai: true, project: "PROJECT_ID", location: "global" });
const stream = await client.interactions.create({
  agent: "AGENT_ID",
  input: "...",
  stream: true,
  background: false,
  store: false,
});
```

The scaffold follows that client and `client.interactions.create` shape. It uses the documented `v1beta1` Interactions API metadata and `global` location requirement. It consumes only bounded event count, service status, interaction ID hash, and timestamp. Raw provider events are never returned or persisted.

References:

- [Agentic Cinema overview](https://agentic-cinema.devpost.com/) - frames the build around Gemini Enterprise Agent Platform and says to build on Google Cloud using Gemini Enterprise Agent Platform.
- [Official resources](https://agentic-cinema.devpost.com/resources) - describes Agent Builder, Agent Engine, and native ADK resources.
- [Official rules](https://agentic-cinema.devpost.com/rules) - lists accepted Google Cloud packages and requires runtime use for a future contest submission.
- [Google managed agents: Interact with agents](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents/interact-with-agents) - documents the JavaScript `@google/genai` client and `client.interactions.create` Interactions API shape.
- [IBM track resources](https://agentic-cinema.devpost.com/details/ibm-resources) - is intentionally not selected or represented here. No IBM product, Bob, Confluent integration, or IBM runtime proof is added.

## Readiness and truthfulness

`GET /v1/agent/readiness` and `/readyz` expose `configured`, `checked`, `passed`, `failed`, `stale`, `not_run`, package identity, agent and flow identity, tool identity, and safe model/project/region placeholders.

- `local_mock` reports a local no-network boundary check as passed. This is not Google model or hosted-agent readiness.
- `managed_interactions` is accepted only with `RUNTIME_MODE=deployed_identity`, `DEPLOYMENT_TARGET=cloud_run`, complete server-owned Google configuration, an operator-selected `AGENT_RUNTIME_AGENT_ID`, `GOOGLE_LOCATION=global`, and an actual passed `GeminiReadiness` check.
- An environment flag alone cannot select managed mode. Missing or incomplete configuration, failed readiness, or stale readiness fails closed before an Interactions API call.
- Tests inject the readiness object, transport, and SDK-shaped client. They make no cloud call. Default `npm test`, `npm run check`, and deployment smoke remain credential-free and network-free.

Safe provenance records only:

- accepted Google package name and exact version;
- product-owned agent and flow identity;
- model, project, and region placeholders, never secrets;
- allowlisted tool call name and operation;
- request and result hashes; and
- an observed timestamp.

It does not store tokens, raw private source, hidden reasoning, or raw provider payloads. The local packet result remains the existing safe application projection; managed interaction evidence contains metadata and hashes rather than provider content.

## Local and container invocation

The default local path remains the existing Node app:

```sh
npm ci
npm test
npm run check
npm start
curl -s http://127.0.0.1:4173/healthz
curl -s http://127.0.0.1:4173/readyz
curl -s http://127.0.0.1:4173/v1/agent/readiness
```

The read-only boundary can be exercised after a packet exists:

```sh
curl -s -X POST http://127.0.0.1:4173/v1/agent/producer-intake \
  -H 'content-type: application/json' \
  -d '{"schema_version":"producer-intake-agent@1","packet_id":"packet_..."}'
```

The existing `Dockerfile` remains the Cloud Run-shaped Node container and defaults to mock mode. No second container is needed. A future operator may deploy that Node image to Cloud Run with the server-owned `@google/genai` adapter enabled after selecting a project, identity, agent ID, quota, retention, and policy. This repository creates no Cloud Run or Agent Platform resource, enables no API, chooses no project or hosted agent, adds no credential, and does not claim a hosted URL or live contest compliance.
