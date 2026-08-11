# Gemini Agents

Gemini Agents is a public, web-first MVP for turning a user's problem statement into a coordinated media and entertainment workflow.

## Product concept

A user types one plain-language instruction into a browser.

Gemini interprets the request and Google Cloud Agent Builder coordinates specialized agents that plan, use approved partner capabilities, check one another's work, and return a concise result.

The first partner direction under consideration is IBM through an approved MCP or tool integration.

The partner set provided by the hackathon includes IBM, Grafana, Parallel, ClickHouse, and Replit.

The exact workflow, partner choice, agent roles, and technical boundaries remain subject to market research and implementation design.

## Proposed MVP shape

- Simple user-facing instruction composer.
- Gemini as the reasoning layer.
- Google Cloud Agent Builder as the orchestration layer.
- Specialized agents with narrow role instructions.
- Approved partner tools used only through explicit, bounded capabilities.
- A concise user result with deeper execution evidence reserved for a future developer view.

## Research and implementation work

- Market research will compare multi-agent patterns for media and entertainment workflows and evaluate the listed partner capabilities.
- Technical design will define agent roles, tool boundaries, orchestration, state, approvals, observability, and failure recovery.
- The PRD will be updated after those findings are reviewed.

## Current status

This repository is in MVP discovery and design.

No real external action, production credential, or partner integration is enabled yet.

## Safety direction

User instructions must not directly grant unrestricted tool access.

Agent actions will use explicit tool allowlists, bounded inputs, durable activity records, and human approval for security-sensitive or irreversible actions.
