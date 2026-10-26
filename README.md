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
| `NHCX_ENV` | `sandbox` | Selects the API host set: `sandbox`, `staging`, `production`. Unknown values fall back to sandbox so a typo never sends traffic to a production host. |
| `PAYER_ID` | `1518` | Your payer code (used as `receivercode` in API calls) |
| `SENDER_CODE` | — | Default provider/sender code for testing |
| `MEMBER_ID` | — | Default patient ABHA/PMJAY member ID for testing |
| `REAL_ABHA` | — | Default real ABHA number for `nhcx_update_abha_number` |
| `DUMMY_ABHA` | — | Default dummy ABHA number for `nhcx_update_abha_number` |
| `PAYMENT_UTR` | `SAYAN12345` | Default UTR / transaction reference for `nhcx_update_payment` |
| `PAYER_PORTAL_UID` | `USER4007` | Payer-portal identity header (`uid`) for payment update |
| `PAYER_PORTAL_UNAME` | `Shubham` | Payer-portal identity header (`uname`) for payment update |
| `PAYER_PORTAL_UROLE` | `System` | Payer-portal identity header (`urole`) for payment update |
| `PAYER_PORTAL_USTATE` | `112` | Payer-portal identity header (`ustate`) for payment update |
| `PAYER_PORTAL_SOURCE` | `internal` | Payer-portal identity header (`source`) for payment update |
| `PAYER_PORTAL_HID` | `0` | Payer-portal identity header (`hid`) for payment update |
| `PAYER_PORTAL_CID` | `0` | Payer-portal identity header (`cid`) for payment update |
| `NHCX_TIMEOUT` | `30000` | API request timeout in milliseconds |
| `NHCX_RETRIES` | `0` | Auto-retries on transient errors (5xx, network) |
| `DEBUG` | `false` | Set to `true` for debug logging to stderr |

### Optional — URL Overrides

`NHCX_ENV` picks the host set; these override individual base URLs and always win over it.
Use them when NHA moves an endpoint or you point at a gateway instance of your own.

| Variable | Overrides |
|----------|-----------|
| `NHCX_USER_ROLE_URL` | `get/user-role` base URL |
| `NHCX_PROCESS_CASE_URL` | `process/case` base URL |
| `NHCX_UPDATE_ABHA_URL` | `update/abhanumber` base URL |
| `NHCX_PAYMENT_DETAILS_URL` | `get/payment/details` base URL (payment step 1) |
| `NHCX_PAYMENT_UPDATE_URL` | `payment/update` base URL (payment step 2) |

Run with `DEBUG=true` to log the hosts actually in use at startup and in
`nhcx_validate_config` (field `config.hostSet`).

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

### `nhcx_get_payment_details`

Step 1 of 2 of the PMJAY payment flow. Reads the payment the payer has created for a registration and returns the four values step 2 needs. See [PMJAY payment flow](#pmjay-payment-flow-two-steps).

```
Input:  registrationId (required) — case number, full
                                    ("PMJAY/HP/S/2024/R2/2026102610000155") or bare
                                    ("2026102610000155"); the prefix is stripped for you
        payerId (optional, default from env)
Output: { ok, result: { step: "1/2", registrationId, registrationNumber, payerId,
                        paymentDetails: { caseid, amount, transactiondate,
                                          paymentrequestid },
                        nextStep | warning, rawResponse } }
```

### `nhcx_update_payment`

Step 2 of 2 of the PMJAY payment flow. Posts the payment update (UTR / status) for the case to the NHA payer portal, closing the loop opened by step 1. This endpoint is authenticated by payer-portal identity headers (`uid`, `uname`, `urole`, `pid`, `cid`, `ustate`, `source`), **not** a bearer token.

```
Input:  caseId (required) — caseid from step 1, verbatim
        amount (required) — amount from step 1
        transactionDate (required) — transactiondate from step 1
                                    (DD/MM/YYYY; ISO YYYY-MM-DD is converted)
        paymentRequestId (required) — paymentrequestid from step 1
        type (optional, default "Normal")
        utrno (optional, default from PAYMENT_UTR)
        status (optional, default "Paid")
        remarks (optional, default "Testing")
        payerId (optional, default from env; sent as the pid header)
Output: { ok, result: { step: "2/2", inputs, protocolStatus, rawResponse } }
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

## PMJAY payment flow (two steps)

Paying a claim is two calls on purpose: **step 1 reads** the payment record the payer has
created for the registration, and **step 2 posts** the settlement back to the payer portal.
Step 2 needs values that only exist after step 1, so they cannot be merged — and having them
separate tells you exactly which call produced which value when something fails.

```
nhcx_get_payment_details  →  caseid, amount, transactiondate, paymentrequestid
                                        ↓  (pass verbatim)
                             nhcx_update_payment
```

### Step 1 — `nhcx_get_payment_details`

Give it the case number in either form:

```
registrationId: "PMJAY/HP/S/2024/R2/2026102610000155"   # what the provider shows
registrationId: "2026102610000155"                      # what the payer API wants
```

The payer API keys on the **bare** registration number. The last `/`-separated segment is
what gets sent, so the full case number works as-is. The response echoes both
(`registrationId` as you sent it, `registrationNumber` as it was sent on).

Careful: the `caseid` that comes back is **not** that bare number — the payer returns the
full `PMJAY/...` case number, and step 2 wants it exactly as returned.

Under the hood:

```
POST {NHCX_PAYMENT_DETAILS_URL}/get/payment/details      Authorization: Bearer <token>
{ "registrationid": "2026102610000155", "payerid": "1518" }
```

Response:

```json
{ "caseid": "PMJAY/HP/S/2024/R2/2026102610000155",
  "amount": 3240,
  "transactiondate": "26/10/2026",
  "paymentrequestid": "1825/2026102610000155/N" }
```

Which the tool wraps as:

```json
{ "ok": true,
  "result": {
    "step": "1/2",
    "registrationId": "PMJAY/HP/S/2024/R2/2026102610000155",
    "registrationNumber": "2026102610000155",
    "paymentDetails": {
      "caseid": "PMJAY/HP/S/2024/R2/2026102610000155",
      "amount": 3240,
      "transactiondate": "26/10/2026",
      "paymentrequestid": "1825/2026102610000155/N"
    },
    "nextStep": "Call nhcx_update_payment with these values from paymentDetails: ..."
  } }
```

> **No data until the first payment notice exists.** Step 1 answers `PAYR-1401` (or an
> empty `paymentDetails` with a `warning`) until the payer has issued the first payment
> notice for the case. That is expected, not a misconfiguration — retry after the notice
> arrives.

### Step 2 — `nhcx_update_payment`

Copy the four values straight out of step 1 — no reformatting:

| Input | Comes from step 1 |
|-------|-------------------|
| `caseId` | `paymentDetails.caseid` (usually the full `PMJAY/...` form — pass as-is) |
| `amount` | `paymentDetails.amount` |
| `transactionDate` | `paymentDetails.transactiondate` (`DD/MM/YYYY`) |
| `paymentRequestId` | `paymentDetails.paymentrequestid` |

`transactionDate` also accepts ISO (`2026-10-26`) and converts it to `DD/MM/YYYY`. The
result echoes what was sent (`inputs.transactionDateSent`) so you can confirm the
conversion.

Under the hood this is a different host and a different auth scheme — payer-portal identity
headers, no bearer token:

```
POST {NHCX_PAYMENT_UPDATE_URL}/payment/update
uid: USER4007   uname: Shubham   urole: System   hid: 0
pid: 1518       cid: 0           ustate: 112     source: internal

{ "type": "Normal", "utrno": "SAYAN12345", "status": "Paid", "remarks": "Testing",
  "caseid": "PMJAY/HP/S/2024/R2/2026102610000155", "amount": 3240,
  "transactiondate": "26/10/2026",
  "paymentrequestid": "1825/2026102610000155/N" }
```

Success returns the payer's protocol status:

```json
{ "ok": true, "result": { "step": "2/2", "inputs": { … }, "protocolStatus": "request.queued" } }
```

`request.queued` means the portal accepted the update. The payer then emits the payment
notices (workflow codes 30 / 31 / 33) back to the provider.

### Full example

```
nhcx_get_user_role(caseId: "PMJAY/HP/S/2024/R2/2026102610000155")
→ role: ACO-Trust, allowed: Approve / Reject / Pending

nhcx_process_case(caseId: "PMJAY/HP/S/2024/R2/2026102610000155", action: "Approve", …)
→ ok

nhcx_get_payment_details(registrationId: "PMJAY/HP/S/2024/R2/2026102610000155")
→ amount 3240, transactiondate "26/10/2026", paymentrequestid "1825/2026102610000155/N"

nhcx_update_payment(caseId: "PMJAY/HP/S/2024/R2/2026102610000155",   # caseid from step 1
                    amount: 3240,
                    transactionDate: "26/10/2026",
                    paymentRequestId: "1825/2026102610000155/N")
→ protocolStatus: "request.queued"
```

## Troubleshooting

**"NDHM_CLIENT_ID and NDHM_CLIENT_SECRET must be set"**
Set both env vars. For sandbox testing, get credentials from NHA.

**"Unknown action"**
Action names are case-sensitive. Use exact casing: `Approve`, `Reject`, `Query`, `Forward`, `Pending`, `cpdApprove`, `cpdReject`, `iQuery`.

**"HTTP 401" or auth errors**
Your credentials are wrong or expired. Run `nhcx_validate_config` to check.

**Tool hangs**
Check `NHCX_TIMEOUT` — default is 30s. Set `DEBUG=true` for request logging.

**`PAYR-1401` — no payment details**
The payer has no payment records for that registration. Two causes: the registration
number does not match a case (pass the full case number — the prefix is stripped for you),
or the payer has not issued the first payment notice for the case yet. Step 1 returns
nothing before that notice exists, so retry after the notice arrives.

**`ERR-PYR-PAY-004` — no active case**
Step 2 was given a case id the payer portal does not recognise. Pass step 1's `caseid`
(`paymentDetails.caseid`) exactly as it came back. It is usually the full `PMJAY/...` case
number — stripping it to the bare registration number is what triggers this error.

**Payment update rejected on the date**
`transactiondate` must be `DD/MM/YYYY` as returned by step 1. ISO (`YYYY-MM-DD`) is
converted automatically; any other format is passed through and rejected by the portal.

**Sandbox URLs changed**
Override with `NHCX_USER_ROLE_URL`, `NHCX_PROCESS_CASE_URL`, `NHCX_UPDATE_ABHA_URL`,
`NHCX_PAYMENT_DETAILS_URL` or `NHCX_PAYMENT_UPDATE_URL`.

## License

MIT
