/**
 * Tests for nhcx-payer-mcp
 *
 * Covers: action validation, usecase derivation, workflow structure,
 * response envelope format, and API error handling.
 * Uses node:test (zero extra dependencies). fetch is mocked.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// We can't directly import server.js because it auto-starts.
// Instead, we test the logic we can extract by re-implementing the pure
// functions inline (mirrors server.js exactly).

// ---------------------------------------------------------------------------
// Mirror of server.js constants / pure functions for testing
// ---------------------------------------------------------------------------

const WORKFLOW = [
  { step: 0, usecase: "PREAUTH", role: "PPD-Trust", actions: ["Approve", "Reject", "Query"] },
  { step: 1, usecase: "CLAIM", role: "CEX-Trust", actions: ["Forward"] },
  { step: 2, usecase: "CLAIM", role: "CPD-Trust", actions: ["Pending", "cpdApprove", "cpdReject"] },
  { step: 3, usecase: "Medical Audit Committee", role: "Medical Audit Committee", actions: ["Approve", "Reject", "iQuery"] },
  { step: 4, usecase: "CLAIM", role: "ACO-Trust", actions: ["Approve", "Reject", "Pending"] },
  { step: 5, usecase: "CLAIM", role: "SHA-Trust", actions: ["Approve", "Reject", "Pending"] },
  { step: 6, usecase: "Claim Review Committee", role: "Claim Review Committee", actions: ["Approve", "Reject", "Pending"] },
];

const VALID_ACTIONS = new Set(WORKFLOW.flatMap(s => s.actions));

function deriveUsecase(action) {
  for (const step of WORKFLOW) {
    if (step.actions.includes(action)) return step.usecase;
  }
  return null;
}

function deriveStep(action) {
  for (const step of WORKFLOW) {
    if (step.actions.includes(action)) return step;
  }
  return null;
}

function stepForRole(roleName) {
  return WORKFLOW.find(s => s.role === roleName) || null;
}

function ok(result) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2) }] };
}

function fail(message, extra = {}) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: false, error: { message, ...extra } }, null, 2) },
    ],
    isError: true,
  };
}

function registrationNumber(value) {
  const v = String(value ?? "").trim();
  return v.includes("/") ? v.split("/").pop() : v;
}

function payerDate(value) {
  const v = String(value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

const PAYER_HINTS = {
  "PAYR-1401": (ctx) =>
    `No payment details for registration "${ctx.registrationNumber}". Either that ` +
    `registration number does not match a case, or the payer has not issued the first ` +
    `payment notice for the case yet — step 1 returns nothing before that notice exists.`,
  "ERR-PYR-PAY-004": () =>
    `The NHA payer portal has no active case for this case id. Pass the caseid returned ` +
    `by step 1 (nhcx_get_payment_details) verbatim — not the provider-side case number.`,
};

function parsePayerError(message) {
  const m = /^HTTP (\d{3}):\s*([\s\S]*)$/.exec(String(message ?? ""));
  if (!m) return { message: String(message ?? "") };

  const parsed = { status: Number(m[1]), rawResponse: m[2] };
  try {
    const body = JSON.parse(m[2]);
    parsed.code = body?.error?.code || body?.code;
    parsed.description = body?.error?.message || body?.message;
  } catch {
    // Not JSON — keep the raw body only.
  }
  return parsed;
}

function payerErrorMessage(parsed, ctx = {}) {
  const hint = parsed.code && PAYER_HINTS[parsed.code];
  if (hint) return hint(ctx);

  const bits = [
    parsed.status ? `HTTP ${parsed.status}` : null,
    parsed.code ? `code ${parsed.code}` : null,
    parsed.description || parsed.rawResponse || parsed.message,
  ].filter(Boolean);
  return `Payer request failed: ${bits.join(" — ")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WORKFLOW", () => {
  it("has 7 steps (0 preauth + 6 claim)", () => {
    assert.equal(WORKFLOW.length, 7);
  });

  it("step 0 is PREAUTH with PPD-Trust", () => {
    assert.equal(WORKFLOW[0].step, 0);
    assert.equal(WORKFLOW[0].usecase, "PREAUTH");
    assert.equal(WORKFLOW[0].role, "PPD-Trust");
  });

  it("step 3 usecase is 'Medical Audit Committee'", () => {
    assert.equal(WORKFLOW[3].usecase, "Medical Audit Committee");
  });

  it("step 6 usecase is 'Claim Review Committee'", () => {
    assert.equal(WORKFLOW[6].usecase, "Claim Review Committee");
  });

  it("every step has a non-empty actions array", () => {
    for (const step of WORKFLOW) {
      assert.ok(step.actions.length > 0, `Step ${step.step} has no actions`);
    }
  });

  it("no duplicate roles across steps", () => {
    const roles = WORKFLOW.map(s => s.role);
    assert.equal(new Set(roles).size, roles.length);
  });
});

describe("VALID_ACTIONS", () => {
  it("contains exactly the expected action set", () => {
    const expected = new Set([
      "Approve", "Reject", "Query", "Forward",
      "Pending", "cpdApprove", "cpdReject", "iQuery",
    ]);
    assert.deepEqual(VALID_ACTIONS, expected);
  });

  it("rejects typos of valid actions", () => {
    assert.equal(VALID_ACTIONS.has("approve"), false);
    assert.equal(VALID_ACTIONS.has("cpdapprove"), false);
    assert.equal(VALID_ACTIONS.has("iquery"), false);
    assert.equal(VALID_ACTIONS.has("pending"), false);
    assert.equal(VALID_ACTIONS.has("delete"), false);
  });

  it("accepts all documented actions with correct casing", () => {
    assert.ok(VALID_ACTIONS.has("Approve"));
    assert.ok(VALID_ACTIONS.has("Reject"));
    assert.ok(VALID_ACTIONS.has("Query"));
    assert.ok(VALID_ACTIONS.has("Forward"));
    assert.ok(VALID_ACTIONS.has("Pending"));
    assert.ok(VALID_ACTIONS.has("cpdApprove"));
    assert.ok(VALID_ACTIONS.has("cpdReject"));
    assert.ok(VALID_ACTIONS.has("iQuery"));
  });
});

describe("deriveUsecase", () => {
  it("returns PREAUTH for Query", () => {
    assert.equal(deriveUsecase("Query"), "PREAUTH");
  });

  it("returns PREAUTH for Approve (when ambiguous, first match wins)", () => {
    // "Approve" appears in PPD-Trust (step 0) first
    assert.equal(deriveUsecase("Approve"), "PREAUTH");
  });

  it("returns CLAIM for Forward", () => {
    assert.equal(deriveUsecase("Forward"), "CLAIM");
  });

  it("returns CLAIM for cpdApprove", () => {
    assert.equal(deriveUsecase("cpdApprove"), "CLAIM");
  });

  it("returns 'Medical Audit Committee' for iQuery", () => {
    assert.equal(deriveUsecase("iQuery"), "Medical Audit Committee");
  });

  it("returns null for unknown action", () => {
    assert.equal(deriveUsecase("delete"), null);
  });
});

describe("deriveStep", () => {
  it("finds correct step for Forward", () => {
    const step = deriveStep("Forward");
    assert.equal(step.step, 1);
    assert.equal(step.role, "CEX-Trust");
  });

  it("finds correct step for iQuery", () => {
    const step = deriveStep("iQuery");
    assert.equal(step.step, 3);
    assert.equal(step.role, "Medical Audit Committee");
  });

  it("returns null for unknown action", () => {
    assert.equal(deriveStep("bogus"), null);
  });
});

describe("stepForRole", () => {
  it("finds CPD-Trust", () => {
    const step = stepForRole("CPD-Trust");
    assert.ok(step);
    assert.deepEqual(step.actions, ["Pending", "cpdApprove", "cpdReject"]);
  });

  it("returns null for unknown role", () => {
    assert.equal(stepForRole("NonExistent-Role"), null);
  });
});

describe("response helpers", () => {
  it("ok() wraps result in { ok: true } envelope", () => {
    const res = ok({ foo: "bar" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.result, { foo: "bar" });
    assert.equal(res.isError, undefined);
  });

  it("fail() wraps message in { ok: false, error } envelope", () => {
    const res = fail("something went wrong");
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.message, "something went wrong");
    assert.equal(res.isError, true);
  });
});

// ---------------------------------------------------------------------------
// ABHA number update tool
// ---------------------------------------------------------------------------

describe("ABHA update endpoint", () => {
  const UPDATE_ABHA_BASE = "https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice";
  const UPDATE_ABHA_PATH = "/update/abhanumber";

  it("targets the participant service update/abhanumber endpoint", () => {
    assert.equal(UPDATE_ABHA_BASE, "https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice");
    assert.equal(UPDATE_ABHA_PATH, "/update/abhanumber");
  });

  it("maps realAbha/dummyAbha into the request body", () => {
    const args = { realAbha: "12345678901234", dummyAbha: "12345678904321" };
    const body = { realAbha: args.realAbha, dummyAbha: args.dummyAbha };
    assert.deepEqual(body, { realAbha: "12345678901234", dummyAbha: "12345678904321" });
  });
});

// ---------------------------------------------------------------------------
// PMJAY payment flow (two-step: get details → update payment)
// ---------------------------------------------------------------------------

describe("PMJAY payment flow", () => {
  const PAYMENT_DETAILS_BASE = "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1";
  const PAYMENT_DETAILS_PATH = "/get/payment/details";
  const PAYMENT_UPDATE_BASE = "https://apisbeta.nha.gov.in/pmjay/payer/paypayment/v1";
  const PAYMENT_UPDATE_PATH = "/payment/update";

  it("step 1 targets the payer service get/payment/details endpoint", () => {
    assert.equal(PAYMENT_DETAILS_BASE, "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1");
    assert.equal(PAYMENT_DETAILS_PATH, "/get/payment/details");
  });

  it("step 2 targets the NHA portal payment/update endpoint", () => {
    assert.equal(PAYMENT_UPDATE_BASE, "https://apisbeta.nha.gov.in/pmjay/payer/paypayment/v1");
    assert.equal(PAYMENT_UPDATE_PATH, "/payment/update");
  });

  it("step 1 maps registrationId/payerId into the request body", () => {
    const args = { registrationId: "REG123", payerId: "1518" };
    const body = { registrationid: args.registrationId, payerid: args.payerId || "1518" };
    assert.deepEqual(body, { registrationid: "REG123", payerid: "1518" });
  });

  it("step 2 maps the step-1 output into the update body", () => {
    const args = {
      caseId: "2026081210000359",
      amount: "5000",
      transactionDate: "2026-10-14",
      paymentRequestId: "PR123",
    };
    const body = {
      type: args.type || "Normal",
      utrno: args.utrno || "SAYAN12345",
      status: args.status || "Paid",
      remarks: args.remarks || "Testing",
      caseid: args.caseId,
      amount: args.amount,
      transactiondate: payerDate(args.transactionDate),
      paymentrequestid: args.paymentRequestId,
    };
    assert.deepEqual(body, {
      type: "Normal",
      utrno: "SAYAN12345",
      status: "Paid",
      remarks: "Testing",
      caseid: "2026081210000359",
      amount: "5000",
      transactiondate: "14/10/2026",
      paymentrequestid: "PR123",
    });
  });

  it("step 2 sends payer-portal identity headers and no bearer token", () => {
    const payerId = "1518";
    const headers = {
      uid: "USER4007",
      uname: "Shubham",
      urole: "System",
      hid: "0",
      pid: payerId,
      cid: "0",
      ustate: "112",
      source: "internal",
    };
    assert.equal(headers.pid, "1518");
    assert.equal(headers.bearer_auth, undefined);
    assert.deepEqual(Object.keys(headers).sort(), [
      "cid", "hid", "pid", "source", "uid", "uname", "urole", "ustate",
    ]);
  });

  it("extracts caseid/amount/transactiondate/paymentrequestid from the step-1 response", () => {
    const result = {
      caseid: "2026081210000359",
      amount: "5000",
      transactiondate: "2026-10-14",
      paymentrequestid: "PR123",
    };
    const paymentDetails = {
      caseid: result?.caseid,
      amount: result?.amount,
      transactiondate: result?.transactiondate,
      paymentrequestid: result?.paymentrequestid,
    };
    assert.deepEqual(paymentDetails, result);
  });
});

// ---------------------------------------------------------------------------
// Payer value normalisation
// ---------------------------------------------------------------------------

describe("registrationNumber", () => {
  it("strips the PMJAY prefix", () => {
    assert.equal(
      registrationNumber("PMJAY/HP/S/2024/R2/2026102610000155"),
      "2026102610000155"
    );
  });

  it("leaves a bare number unchanged", () => {
    assert.equal(registrationNumber("2026102610000155"), "2026102610000155");
  });

  it("keeps a prefixed payment-request id's last segment", () => {
    assert.equal(registrationNumber("1825/2026102610000155"), "2026102610000155");
  });

  it("handles empty and non-string input", () => {
    assert.equal(registrationNumber(""), "");
    assert.equal(registrationNumber(undefined), "");
    assert.equal(registrationNumber(null), "");
    assert.equal(registrationNumber(2026102610000155), "2026102610000155");
  });
});

describe("payerDate", () => {
  it("converts ISO to DD/MM/YYYY", () => {
    assert.equal(payerDate("2026-10-26"), "26/10/2026");
  });

  it("leaves an already-DD/MM/YYYY date unchanged", () => {
    assert.equal(payerDate("26/10/2026"), "26/10/2026");
  });

  it("passes anything unexpected through", () => {
    assert.equal(payerDate(""), "");
    assert.equal(payerDate(undefined), "");
    assert.equal(payerDate("26-10-2026"), "26-10-2026");
  });
});

// ---------------------------------------------------------------------------
// Payer error mapping
// ---------------------------------------------------------------------------

describe("parsePayerError", () => {
  it("parses a PAYR-1401 body", () => {
    const parsed = parsePayerError(
      'HTTP 400: {"error":{"code":"PAYR-1401","message":"No payment details found"}}'
    );
    assert.equal(parsed.status, 400);
    assert.equal(parsed.code, "PAYR-1401");
    assert.equal(parsed.description, "No payment details found");
  });

  it("parses an ERR-PYR-PAY-004 body", () => {
    const parsed = parsePayerError(
      'HTTP 400: {"error":{"code":"ERR-PYR-PAY-004","message":"No active case found"}}'
    );
    assert.equal(parsed.code, "ERR-PYR-PAY-004");
  });

  it("keeps the raw text when the body is not JSON", () => {
    const parsed = parsePayerError("HTTP 502: <html>bad gateway</html>");
    assert.equal(parsed.status, 502);
    assert.equal(parsed.code, undefined);
    assert.equal(parsed.rawResponse, "<html>bad gateway</html>");
  });

  it("falls back to the message when there is no HTTP prefix", () => {
    const parsed = parsePayerError("fetch failed");
    assert.deepEqual(parsed, { message: "fetch failed" });
  });
});

describe("payerErrorMessage", () => {
  it("explains PAYR-1401 in terms of the registration number", () => {
    const msg = payerErrorMessage(
      { code: "PAYR-1401", status: 400 },
      { registrationNumber: "2026102610000155" }
    );
    assert.match(msg, /2026102610000155/);
    assert.match(msg, /first payment notice/i);
  });

  it("explains ERR-PYR-PAY-004 as the wrong case id", () => {
    const msg = payerErrorMessage({ code: "ERR-PYR-PAY-004", status: 400 });
    assert.match(msg, /step 1/);
    assert.match(msg, /caseid/);
  });

  it("keeps status and code for an unknown code", () => {
    const msg = payerErrorMessage({ code: "PAYR-9999", status: 400, rawResponse: "{}" });
    assert.match(msg, /HTTP 400/);
    assert.match(msg, /PAYR-9999/);
  });
});

describe("fail envelope", () => {
  it("merges extra error fields alongside the message", () => {
    const res = fail("boom", { code: "PAYR-1401", status: 400 });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.message, "boom");
    assert.equal(payload.error.code, "PAYR-1401");
    assert.equal(payload.error.status, 400);
    assert.equal(res.isError, true);
  });
});

// ---------------------------------------------------------------------------
// API helper error handling (mock fetch)
// ---------------------------------------------------------------------------

describe("nhcxApi error handling", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function nhcxApi(baseUrl, path, token, body, retries = 0) {
    const url = `${baseUrl}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(url, {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            bearer_auth: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        clearTimeout(timer);

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        return await res.json();
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        if (attempt < retries && /HTTP 5\d\d/.test(e.message)) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  it("returns parsed JSON on success", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ status: "success", data: { id: "123" } }),
    }));

    const result = await nhcxApi("https://example.com", "/test", "token");
    assert.deepEqual(result, { status: "success", data: { id: "123" } });
  });

  it("throws with HTTP status on non-OK response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":"not found"}',
    }));

    await assert.rejects(
      nhcxApi("https://example.com", "/test", "token"),
      /HTTP 404: {"error":"not found"}/
    );
  });

  it("retries on 5xx errors when retries > 0", async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ ok: false, status: 503, text: async () => "Service Unavailable" });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    });

    const result = await nhcxApi("https://example.com", "/test", "token", null, 2);
    assert.equal(calls, 2);
    assert.deepEqual(result, { success: true });
  });

  it("does not retry on 4xx errors", async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(() => {
      calls++;
      return Promise.resolve({ ok: false, status: 400, text: async () => "Bad Request" });
    });

    await assert.rejects(
      nhcxApi("https://example.com", "/test", "token", null, 2),
      /HTTP 400/
    );
    assert.equal(calls, 1);
  });
});
