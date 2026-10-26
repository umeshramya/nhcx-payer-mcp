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
- `NHCX_ENV` — `sandbox` (default), `staging`, or `production`; selects the host set from `HOSTS`. Unknown values fall back to sandbox.
- `PAYER_ID` / `SENDER_CODE` / `MEMBER_ID` / `REAL_ABHA` / `DUMMY_ABHA` — default test values, overridable per tool call
- `PAYMENT_UTR` / `PAYER_PORTAL_UID` / `PAYER_PORTAL_UNAME` / `PAYER_PORTAL_UROLE` / `PAYER_PORTAL_USTATE` / `PAYER_PORTAL_SOURCE` / `PAYER_PORTAL_HID` / `PAYER_PORTAL_CID` — PMJAY payment-flow defaults (UTR + payer-portal identity headers)
- `NHCX_TIMEOUT` / `NHCX_RETRIES` — API resilience
- `DEBUG=true` — stderr debug logging
- Individual URL overrides (win over `NHCX_ENV`): `NHCX_USER_ROLE_URL`, `NHCX_PROCESS_CASE_URL`, `NHCX_UPDATE_ABHA_URL`, `NHCX_PAYMENT_DETAILS_URL`, `NHCX_PAYMENT_UPDATE_URL`

**Auth flow** — ABDM gateway V3 `client_credentials` grant. Token is cached in memory for 15 minutes. `X-CM-ID` header tied to `NHCX_ENV`. Auto-refresh before every API call (no manual login needed).

**API layering** — NHA base URLs (switched by `NHCX_ENV`):
- User-role: `apisbx.abdm.gov.in` (sandbox)
- Process-case: `apisbeta.nha.gov.in` (sandbox)
- ABHA update: `apisbx.abdm.gov.in` (participant service, sandbox)
- Payment details: `apisbx.abdm.gov.in` (payer service, sandbox) — Bearer auth, via `nhcxApi()`
- Payment update: `apisbeta.nha.gov.in/pmjay/payer/paypayment/v1` — **no Bearer**; authenticated by payer-portal identity headers, via `payerPortalApi()`
Per-endpoint overrides via env vars take precedence over `NHCX_ENV`.

The `nhcxApi()` helper wraps `fetch` with Bearer auth, timeout (AbortController), configurable retries on 5xx/network errors, and structured error handling (checks `res.ok` before JSON parse, includes HTTP status in errors). `payerPortalApi()` mirrors it for the payment-update endpoint but sends the `uid`/`uname`/`urole`/`hid`/`pid`/`cid`/`ustate`/`source` identity headers instead of a bearer token.

**MCP tools** — 8 tools:
- `nhcx_validate_config` — validate env vars, test auth, check API URL reachability
- `nhcx_login` — authenticate and cache a session token (convenience/connectivity check)
- `nhcx_get_user_role` — get current payer role + allowed actions for a case (calls sandbox user-role API, enhanced with WORKFLOW lookup)
- `nhcx_process_case` — act on a case; usecase auto-derived from action, action validated against WORKFLOW before API call, enriched result with computed fields + raw API response
- `nhcx_workflow` — return the full workflow array with `{ step, usecase, role, actions }` per step
- `nhcx_update_abha_number` — map a real ABHA number to a dummy ABHA number for cyclic-procedure claim testing (participant service)
- `nhcx_get_payment_details` — PMJAY payment step 1/2 (`step: "1/2"`): fetch `caseid`/`amount`/`transactiondate`/`paymentrequestid` for a registration (payer service, Bearer). The registration may be prefixed; `registrationNumber()` strips `PMJAY/...` and the result echoes both forms.
- `nhcx_update_payment` — PMJAY payment step 2/2 (`step: "2/2"`): post UTR + status for a case to the NHA payer portal (identity headers, no Bearer). Echoes `inputs` (including `transactionDateSent`) so the caller can see which step-1 values were used; `payerDate()` converts ISO to `DD/MM/YYYY`.

**Payer value normalisation** — `registrationNumber(value)` and `payerDate(value)` are pure helpers at the top of `server.js`; both payment tools and `nhcx_process_case` go through them, so the prefix-strip rule lives in one place. Payer 4xx bodies (`HTTP 400: {"error":{"code":...}}`) are parsed by `parsePayerError()` and turned into actionable messages by `payerErrorMessage()` / `PAYER_HINTS` (`PAYR-1401`, `ERR-PYR-PAY-004`); the parsed `code`/`status`/`rawResponse` are still returned in the error envelope.

**Workflow model** — Single `WORKFLOW` array (source of truth, replaces old `ROLE_ACTIONS` + `WORKFLOW`). 7 steps: 1 PREAUTH + 6 CLAIM. Steps 3 (Medical Audit Committee) and 6 (Claim Review Committee) have distinct `usecase` values. Action names match the NHCX document casing exactly: `Approve`, `Reject`, `Query`, `Forward`, `Pending`, `cpdApprove`, `cpdReject`, `iQuery`.

**Response format** — Consistent JSON envelope across all tools: `{ ok: boolean, result?: any, error?: { message: string, ...extra } }`, where payment-tool errors add `code`, `status` and `rawResponse`. Process_case result includes computed fields (caseId, action, usecase, role, correlationId) alongside raw API response.

**Input schemas** — Built dynamically at startup. Schema `default` values reflect configured env vars so the MCP host shows accurate defaults.

**Dependencies** — Only `@modelcontextprotocol/sdk` v1. Uses `StdioServerTransport` (stdin/stdout — designed to be run by an MCP host, not as an HTTP server). Node >= 18 required.

**Tests** — `tests/server.test.js` using `node:test` (zero extra deps). Covers WORKFLOW structure, action validation, usecase derivation, response envelope format, API error handling with mocked `fetch`, the two-step PMJAY payment flow (endpoints, body mapping, payer-portal headers), and the payer helpers (`registrationNumber`, `payerDate`, `parsePayerError`, `payerErrorMessage`). 49 tests.

**npm distribution** — Package `nhcx-payer-mcp` with `bin` entry (`nhcx-payer-mcp` → `server.js`). `files` limited to `server.js`. No build step, no transpilation.
