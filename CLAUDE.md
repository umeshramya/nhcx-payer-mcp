# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MCP server that simulates NHCX (National Health Claims Exchange) payer-side actions. Used to test provider submissions — approve, reject, query, or forward preauth and claim cases through the full payer workflow. Designed for distribution to external integrators as an npm package.

## Commands

```
npm start                  # Start the MCP server via stdio
node server.js             # Same (ESM module)
npm test                   # Run unit tests (node:test, zero deps)
```

## Architecture

Single file: `server.js`. Everything lives in one self-contained ESM module (`"type": "module"`). Zero build step.

**Configuration** — All integrator-specific values are env vars only (no hardcoded secrets, no config files):
- `NDHM_CLIENT_ID` / `NDHM_CLIENT_SECRET` — required ABDM gateway credentials
- `NDHM_URL` — auth URL (default `https://dev.abdm.gov.in`)
- `NHCX_ENV` — `sandbox` (default), `staging`, or `production`; selects API base URLs
- `PAYER_ID` / `SENDER_CODE` / `MEMBER_ID` — default test values, overridable per tool call
- `NHCX_TIMEOUT` / `NHCX_RETRIES` — API resilience
- `DEBUG=true` — stderr debug logging
- Individual URL overrides: `NHCX_USER_ROLE_URL`, `NHCX_PROCESS_CASE_URL`

**Auth flow** — ABDM gateway V3 `client_credentials` grant. Token is cached in memory for 15 minutes. `X-CM-ID` header tied to `NHCX_ENV`. Auto-refresh before every API call (no manual login needed).

**API layering** — Two NHA base URLs (switched by `NHCX_ENV`):
- User-role: `apisbx.abdm.gov.in` (sandbox)
- Process-case: `apisbeta.nha.gov.in` (sandbox)
Per-endpoint overrides via env vars take precedence over `NHCX_ENV`.

The `nhcxApi()` helper wraps `fetch` with Bearer auth, timeout (AbortController), configurable retries on 5xx/network errors, and structured error handling (checks `res.ok` before JSON parse, includes HTTP status in errors).

**MCP tools** — 5 tools:
- `nhcx_validate_config` — validate env vars, test auth, check API URL reachability
- `nhcx_login` — authenticate and cache a session token (convenience/connectivity check)
- `nhcx_get_user_role` — get current payer role + allowed actions for a case (calls sandbox user-role API, enhanced with WORKFLOW lookup)
- `nhcx_process_case` — act on a case; usecase auto-derived from action, action validated against WORKFLOW before API call, enriched result with computed fields + raw API response
- `nhcx_workflow` — return the full workflow array with `{ step, usecase, role, actions }` per step

**Workflow model** — Single `WORKFLOW` array (source of truth, replaces old `ROLE_ACTIONS` + `WORKFLOW`). 7 steps: 1 PREAUTH + 6 CLAIM. Steps 3 (Medical Audit Committee) and 6 (Claim Review Committee) have distinct `usecase` values. Action names match the NHCX document casing exactly: `Approve`, `Reject`, `Query`, `Forward`, `Pending`, `cpdApprove`, `cpdReject`, `iQuery`.

**Response format** — Consistent JSON envelope across all tools: `{ ok: boolean, result?: any, error?: { message: string } }`. Process_case result includes computed fields (caseId, action, usecase, role, correlationId) alongside raw API response.

**Input schemas** — Built dynamically at startup. Schema `default` values reflect configured env vars so the MCP host shows accurate defaults.

**Dependencies** — Only `@modelcontextprotocol/sdk` v1. Uses `StdioServerTransport` (stdin/stdout — designed to be run by an MCP host, not as an HTTP server). Node >= 18 required.

**Tests** — `tests/server.test.js` using `node:test` (zero extra deps). Covers WORKFLOW structure, action validation, usecase derivation, response envelope format, and API error handling with mocked `fetch`. 26 tests.

**npm distribution** — Package `nhcx-payer-mcp` with `bin` entry (`nhcx-payer-mcp` → `server.js`). `files` limited to `server.js`. No build step, no transpilation.
