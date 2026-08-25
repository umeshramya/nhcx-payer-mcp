# nhcx-payer-mcp

MCP server to simulate NHCX payer-side actions. After a provider (e.g., Nice HMS) submits a preauth or claim to NHCX, use this tool to act as the mock payer — approve, reject, query, or forward cases through the full payer workflow.

Designed for external integrators testing their NHCX provider integration. No more dependency on NHA teams for payer-side workflow actions.

## Quickstart

```bash
# 1. Set your credentials (required)
export NDHM_CLIENT_ID=SBX_000XXX
export NDHM_CLIENT_SECRET=your-sandbox-secret

# 2. Configure your test defaults (optional but recommended)
export PAYER_ID=1518
export SENDER_CODE=1000000001
export MEMBER_ID=your-test-patient-id
export REAL_ABHA=12345678901234
export DUMMY_ABHA=12345678904321

# 3. Run via npx (no install needed)
#    @latest guarantees you get the newest published version (npx caches by version)
npx nhcx-payer-mcp@latest

# Or install globally
npm install -g nhcx-payer-mcp
nhcx-payer-mcp
```

## MCP Host Configuration

Add to your MCP host (Claude Desktop, VS Code, etc.):

```json
{
  "mcpServers": {
    "nhcx-payer": {
      "command": "npx",
      "args": ["-y", "nhcx-payer-mcp@latest"],
      "env": {
        "NDHM_CLIENT_ID": "SBX_000XXX",
        "NDHM_CLIENT_SECRET": "your-sandbox-secret",
        "PAYER_ID": "1518",
        "SENDER_CODE": "1000000001",
        "MEMBER_ID": "your-test-patient-id",
        "REAL_ABHA": "12345678901234",
        "DUMMY_ABHA": "12345678904321"
      }
    }
  }
}
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `NDHM_CLIENT_ID` | ABDM gateway client ID (sandbox: `SBX_000XXX`) |
| `NDHM_CLIENT_SECRET` | ABDM gateway client secret |

### Optional — Defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `NDHM_URL` | `https://dev.abdm.gov.in` | ABDM gateway auth URL |
| `NHCX_ENV` | `sandbox` | Environment: `sandbox`, `staging`, `production` |
| `PAYER_ID` | `1518` | Your payer code (used as `receivercode` in API calls) |
| `SENDER_CODE` | — | Default provider/sender code for testing |
| `MEMBER_ID` | — | Default patient ABHA/PMJAY member ID for testing |
| `REAL_ABHA` | — | Default real ABHA number for `nhcx_update_abha_number` |
| `DUMMY_ABHA` | — | Default dummy ABHA number for `nhcx_update_abha_number` |
| `NHCX_TIMEOUT` | `30000` | API request timeout in milliseconds |
| `NHCX_RETRIES` | `0` | Auto-retries on transient errors (5xx, network) |
| `DEBUG` | `false` | Set to `true` for debug logging to stderr |

### Optional — URL Overrides

Override individual API base URLs (takes precedence over `NHCX_ENV`):

| Variable | Description |
|----------|-------------|
| `NHCX_USER_ROLE_URL` | Base URL for get/user-role endpoint |
| `NHCX_PROCESS_CASE_URL` | Base URL for process/case endpoint |

## Tools

### `nhcx_validate_config`

Validate your setup. Checks all env vars, tests authentication, and verifies API URL reachability. Run this first.

```
Input:  (none)
Output: { ok, result: { valid, issues[], config, connectivity } }
```

### `nhcx_login`

Authenticate with ABDM gateway V3 and cache a token (15 min). All tools auto-authenticate — this is a convenience for connectivity checks.

```
Input:  (none)
Output: { ok, result: { clientId, tokenPrefix, cachedFor } }
```

### `nhcx_get_user_role`

Get the current payer role and allowed actions for a case. Always call this before processing.

```
Input:  caseId (required), payerId (optional, default from env)
Output: { ok, result: { caseId, role, allowedActions[], rawResponse } }
```

### `nhcx_process_case`

Execute a payer action on a case. The usecase is derived automatically from the action. Valid actions are validated before the API call.

```
Input:  caseId (required) — numeric ID or full prefixed format
                             (e.g. "2026081210000359" or "PMJAY/HP/S/2024/R2/2026081210000359")
                             Prefix is auto-stripped for process/case API compatibility.
        action (required) — Approve, Reject, Query, Forward, Pending,
                             cpdApprove, cpdReject, iQuery
        senderCode (required) — provider/sender code
        memberId (required) — patient ABHA/PMJAY ID
        receiverCode (optional, default from env)
        remarks (optional, default "ok")
        correlationId (required) — from original submission, never auto-generated
Output: { ok, result: { caseId, action, usecase, role, correlationId, rawResponse } }
```

### `nhcx_workflow`

Show the full payer workflow with steps, usecase per step, roles, and allowed actions.

```
Input:  (none)
Output: { ok, result: { workflow: [...] } }
```

### `nhcx_update_abha_number`

Map a real ABHA number to a dummy ABHA number for cyclic-procedure claim testing. Replaces the real ABHA captured during biometric authentication with the dummy ABHA used in the claim, so claim validation can locate the dummy beneficiary's biometric records. For lower/test environments only.

```
Input:  realAbha (required) — real ABHA number captured during biometric auth
        dummyAbha (required) — dummy ABHA number used in the claim request
        (both default from REAL_ABHA / DUMMY_ABHA env vars)
Output: { ok, result: { realAbha, dummyAbha, rawResponse } }
```

## Payer Workflow

| Step | Usecase | Role | Actions |
|------|---------|------|---------|
| 0 | PREAUTH | PPD-Trust | Approve, Reject, Query |
| 1 | CLAIM | CEX-Trust | Forward |
| 2 | CLAIM | CPD-Trust | Pending, cpdApprove, cpdReject |
| 3 | Medical Audit Committee | Medical Audit Committee | Approve, Reject, iQuery |
| 4 | CLAIM | ACO-Trust | Approve, Reject, Pending |
| 5 | CLAIM | SHA-Trust | Approve, Reject, Pending |
| 6 | Claim Review Committee | Claim Review Committee | Approve, Reject, Pending |

## Testing Workflow Example

1. Validate config: `nhcx_validate_config`
2. Check role: `nhcx_get_user_role(caseId: "2026072210000472")`
3. Process case: `nhcx_process_case(caseId: "...", action: "Approve", senderCode: "...", memberId: "...")`

For CLAIM workflow, repeat steps 2-3 through all 6 steps in sequence.

## Troubleshooting

**"NDHM_CLIENT_ID and NDHM_CLIENT_SECRET must be set"**
Set both env vars. For sandbox testing, get credentials from NHA.

**"Unknown action"**
Action names are case-sensitive. Use exact casing: `Approve`, `Reject`, `Query`, `Forward`, `Pending`, `cpdApprove`, `cpdReject`, `iQuery`.

**"HTTP 401" or auth errors**
Your credentials are wrong or expired. Run `nhcx_validate_config` to check.

**Tool hangs**
Check `NHCX_TIMEOUT` — default is 30s. Set `DEBUG=true` for request logging.

**Sandbox URLs changed**
Override with `NHCX_USER_ROLE_URL` and `NHCX_PROCESS_CASE_URL` env vars.

## License

MIT
