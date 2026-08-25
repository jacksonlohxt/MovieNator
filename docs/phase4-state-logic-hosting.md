# MovieInator Phase 4 state and logic hosting

Phase 4 adds a local, provider-neutral foundation for resumable workflow state, allowlisted tools, bounded function calling, and a future agent-host seam. It is an application contract, not a managed runtime deployment.

## Operating boundary

The local MVP is credential-free, network-free, read-only, and no-side-effect by default:

- `FileStore` is the canonical local state authority. It atomically persists runs, append-only events, branches, checkpoints, leases, retry metadata, cancellation intent, and terminal outcomes under `.data/`.
- `MockEngine` is a fixed application workflow. A worker lease prevents duplicate execution, and `createApp()` resumes active runs after a process restart. Completed evidence and checkpoints are reused when safe. A repeated delivery of a terminal run is a no-op.
- `ToolRegistry` accepts only validated `tool-manifest@1` entries. A manifest names its input and output schemas, semantic operations, local endpoint, permissions, workspace scope, timeout, budget, provenance, redaction mode, and `side_effects: false`. Unknown tools, endpoints, credentials, operations, permissions, and scopes fail closed.
- `LocalMcpDatabase` is an MCP-style in-process seam. It exposes only the five semantic read operations used by the readiness workflow. It has no arbitrary SQL, URLs, credentials, private rows, mutation operations, or provider discovery.
- `BoundedFunctionOrchestrator` treats model output as a `tool-call-proposal@1`, never as authority. Deterministic validation runs before every call and enforces call count, timeout, total budget, permissions, scope, redaction, idempotent call identity, and no-side-effect mode. A proposal cannot select a provider or endpoint.
- Public projections contain state summaries, checkpoint hashes, branch status, safe tool readiness, evidence IDs, and recovery actions. They do not contain hidden reasoning, raw provider payloads, credentials, private source rows, or unrestricted tool catalogs.

The compatibility exports are gathered in `src/logic-host.js`:

```js
import { createDefaultToolRegistry, BoundedFunctionOrchestrator } from "./src/logic-host.js";

const registry = createDefaultToolRegistry();
const host = new BoundedFunctionOrchestrator({ registry });
```

Useful local views are `GET /v1/tools/readiness`, `GET /v1/logic/state`, `GET /v1/runs/{run_id}/state`, and `GET /v1/runs/{run_id}/checkpoints`. The normal run projection also includes safe workflow state, branch summaries, and checkpoint summaries.

## Recovery contract

A run has an immutable request and idempotency hash. Its workflow state records:

- run state and phase;
- named branch IDs and branch attempts;
- checkpoint ID, sequence, input hash, output hash, and safe status;
- worker lease and heartbeat metadata;
- bounded retry attempt and maximum;
- cancellation requested and confirmed timestamps;
- one terminal outcome with reason code, safe message, result hash, and recoverability.

Cancellation is intent first and terminal confirmation second. A late operation checks cancellation before publication and cannot overwrite a canceled run. Retry creates a linked child run and leaves the original unchanged. Lease expiry is recovered on the next host startup. No silent provider fallback is performed.

## Future managed Agent Platform host

The current managed-agent adapter uses Node `@google/genai` and the Interactions API; it does not add a Python sidecar. A later host may implement `AGENT_HOST_CONTRACT` from `src/agent-runtime-boundary.js` using the same managed Agent Platform worker. The host must be an execution adapter only:

1. receive one bounded role invocation;
2. receive only the application-owned contract and allowlisted tool manifests;
3. return a typed tool proposal, not a decision, state transition, provider selection, or side effect;
4. let the application orchestrator validate and execute every proposal;
5. write checkpoints, leases, retries, cancellation, evidence, policy decisions, and terminal outcomes through an application-owned state API;
6. return only the application safe projection.

The provider must not become the source of truth for run state, authorization, policy, tool catalog, tenant scope, credentials, retention, or recovery. A managed runtime may supply scheduling, model invocation, logs, and worker isolation, but those capabilities remain behind the same boundary. The application must be able to replay or resume from its own persisted checkpoint records without a provider session.

The later host rollout gate is: contract tests for proposal validation, duplicate delivery, lease loss, cancellation, timeout, budget exhaustion, unknown tool, permission denial, unsafe input and output, and provider unavailability; then a separate operator decision for credentials, endpoint, data scope, retention, and deployment. This task does not install, authenticate, or deploy either host.

## Operator checklist

```sh
npm test
npm run check
npm start
curl -s http://127.0.0.1:4173/v1/tools/readiness
curl -s http://127.0.0.1:4173/v1/logic/state
```

The only default tool is the local deterministic fixture. A readiness state of `ready` means the local manifest is valid, not that a partner system or managed runtime is connected.
