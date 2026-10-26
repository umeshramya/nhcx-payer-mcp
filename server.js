#!/usr/bin/env node
/**
 * NHCX Payer MCP Server
 *
 * MCP server that simulates NHCX payer-side actions for testing provider
 * submissions. After a provider submits a preauth/claim to NHCX, use this
 * to act as the mock payer — approve, reject, query, or forward cases
 * through the full payer workflow.
 *
 * Distributed as an npm package for external integrators.
 * All integrator-specific values are configured via environment variables.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Configuration (env vars only — no hardcoded secrets)
// ---------------------------------------------------------------------------

const config = {
  clientId: process.env.NDHM_CLIENT_ID,
  clientSecret: process.env.NDHM_CLIENT_SECRET,
  authUrl: process.env.NDHM_URL || "https://dev.abdm.gov.in",
  env: process.env.NHCX_ENV || "sandbox",
  payerId: process.env.PAYER_ID || "1518",
  senderCode: process.env.SENDER_CODE || "",
  memberId: process.env.MEMBER_ID || "",
  realAbha: process.env.REAL_ABHA || "",
  dummyAbha: process.env.DUMMY_ABHA || "",
  paymentUtr: process.env.PAYMENT_UTR || "SAYAN12345",
  portalUid: process.env.PAYER_PORTAL_UID || "USER4007",
  portalUname: process.env.PAYER_PORTAL_UNAME || "Shubham",
  portalUrole: process.env.PAYER_PORTAL_UROLE || "System",
  portalUstate: process.env.PAYER_PORTAL_USTATE || "112",
  portalSource: process.env.PAYER_PORTAL_SOURCE || "internal",
  portalHid: process.env.PAYER_PORTAL_HID || "0",
  portalCid: process.env.PAYER_PORTAL_CID || "0",
  timeout: parseInt(process.env.NHCX_TIMEOUT, 10) || 30000,
  retries: parseInt(process.env.NHCX_RETRIES, 10) || 0,
  debug: process.env.DEBUG === "true",
};

function debug(...args) {
  if (config.debug) console.error("[nhcx]", ...args);
}

// ---------------------------------------------------------------------------
// API endpoints — NHCX_ENV selects the host set, per-endpoint env vars override
// ---------------------------------------------------------------------------

const HOSTS = {
  sandbox: {
    userRole: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1",
    processCase: "https://apisbeta.nha.gov.in/pmjay/hcx/nhcxpayerservice/wrapper",
    updateAbha: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice",
    paymentDetails: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1",
    paymentUpdate: "https://apisbeta.nha.gov.in/pmjay/payer/paypayment/v1",
    cmId: "sbx",
  },
  // "staging" and "production" use the same shape, with hosts supplied by NHA.
  // Unknown NHCX_ENV values fall back to sandbox so a typo never silently
  // sends traffic to a production host.
};

function getUrls() {
  const base = HOSTS[config.env] || HOSTS.sandbox;
  return {
    userRole: process.env.NHCX_USER_ROLE_URL || base.userRole,
    processCase: process.env.NHCX_PROCESS_CASE_URL || base.processCase,
    updateAbha: process.env.NHCX_UPDATE_ABHA_URL || base.updateAbha,
    paymentDetails: process.env.NHCX_PAYMENT_DETAILS_URL || base.paymentDetails,
    paymentUpdate: process.env.NHCX_PAYMENT_UPDATE_URL || base.paymentUpdate,
    cmId: base.cmId,
  };
}

// ---------------------------------------------------------------------------
// Payer value normalisation
// ---------------------------------------------------------------------------

/**
 * Payer APIs key on the bare registration number:
 * "PMJAY/HP/S/2024/R2/2026102610000155" -> "2026102610000155".
 * Anything without a slash is returned unchanged.
 */
function registrationNumber(value) {
  const v = String(value ?? "").trim();
  return v.includes("/") ? v.split("/").pop() : v;
}

/** Payment update needs DD/MM/YYYY; convert ISO (YYYY-MM-DD), pass anything else through. */
function payerDate(value) {
  const v = String(value ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

// ---------------------------------------------------------------------------
// Workflow definition (single source of truth)
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

// ---------------------------------------------------------------------------
// Auth (V3 client_credentials grant, token cached for 15 min)
// ---------------------------------------------------------------------------

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      "NDHM_CLIENT_ID and NDHM_CLIENT_SECRET must be set. " +
        "Get sandbox credentials from NHA or set via environment variables."
    );
  }

  const { cmId } = getUrls();
  const url = `${config.authUrl}/api/hiecm/gateway/v3/sessions`;

  debug("Fetching access token from", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "REQUEST-ID": randomUUID(),
      "TIMESTAMP": new Date().toISOString(),
      "X-CM-ID": cmId,
    },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      grantType: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.accessToken) {
    throw new Error(`Auth failed — no accessToken in response: ${JSON.stringify(data)}`);
  }

  cachedToken = data.accessToken;
  tokenExpiry = Date.now() + 15 * 60 * 1000;
  debug("Token cached, expires in 15 min");
  return cachedToken;
}

// ---------------------------------------------------------------------------
// API helper (timeout, retries, structured errors)
// ---------------------------------------------------------------------------

async function nhcxApi(baseUrl, path, token, body = null) {
  const url = `${baseUrl}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    try {
      const opts = {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          bearer_auth: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      };
      if (body) opts.body = JSON.stringify(body);

      debug(`${body ? "POST" : "GET"} ${url}${body ? " " + JSON.stringify(body) : ""}`);

      const res = await fetch(url, opts);
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastError = e;

      if (attempt < config.retries && shouldRetry(e)) {
        debug(`Retry ${attempt + 1}/${config.retries} after: ${e.message}`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

function shouldRetry(e) {
  // Retry on timeouts and 5xx, not on 4xx
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (e.cause?.name === "AbortError" || e.cause?.name === "TimeoutError") return true;
  return /HTTP 5\d\d/.test(e.message);
}

// ---------------------------------------------------------------------------
// Payer-portal API helper
//
// The payment-update endpoint sits on the NHA payer portal, not the ABDM
// gateway: it is authenticated by the portal identity headers (uid/uname/
// urole/pid/cid/ustate/source), NOT by a bearer token. Same timeout/retry
// semantics as nhcxApi.
// ---------------------------------------------------------------------------

async function payerPortalApi(baseUrl, path, headers, body) {
  const url = `${baseUrl}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    try {
      const opts = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      };

      debug(`POST ${url} ${JSON.stringify(body)}`);

      const res = await fetch(url, opts);
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastError = e;

      if (attempt < config.retries && shouldRetry(e)) {
        debug(`Retry ${attempt + 1}/${config.retries} after: ${e.message}`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool schemas (built dynamically at startup for env-driven defaults)
// ---------------------------------------------------------------------------

function buildTools() {
  return [
    {
      name: "nhcx_validate_config",
      description:
        "Validate all environment variables and test connectivity to NHCX APIs. " +
        "Run this first to confirm your setup is correct.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "nhcx_login",
      description:
        "Authenticate with the ABDM gateway V3 and cache a session token (15 min). " +
        "Useful as a connectivity check — all other tools auto-authenticate.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "nhcx_get_user_role",
      description:
        "Get the current payer role for a case and the allowed actions for that role. " +
        "Always call this before processing a case.",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string", description: "Case number / ID" },
          payerId: {
            type: "string",
            description: "Payer ID",
            ...(config.payerId ? { default: config.payerId } : {}),
          },
        },
        required: ["caseId"],
      },
    },
    {
      name: "nhcx_process_case",
      description:
        "Act as a payer and perform an action on a case: Approve, Reject, Query, Forward, " +
        "Pending, cpdApprove, cpdReject, iQuery. The usecase is derived automatically from " +
        "the action. The caseId, action, senderCode, memberId, and correlationId are required.",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string", description: "Case number" },
          action: {
            type: "string",
            description: `Action: ${[...VALID_ACTIONS].join(", ")}`,
          },
          receiverCode: {
            type: "string",
            description: "Payer code",
            ...(config.payerId ? { default: config.payerId } : {}),
          },
          senderCode: {
            type: "string",
            description: "Provider/sender code",
            ...(config.senderCode ? { default: config.senderCode } : {}),
          },
          memberId: {
            type: "string",
            description: "Patient ABHA/PMJAY member ID",
            ...(config.memberId ? { default: config.memberId } : {}),
          },
          remarks: {
            type: "string",
            description: "Remarks / reason for action",
            default: "ok",
          },
          correlationId: {
            type: "string",
            description: "Correlation ID from the original submission (required — never guess this)",
          },
        },
        required: ["caseId", "action", "senderCode", "memberId", "correlationId"],
      },
    },
    {
      name: "nhcx_workflow",
      description:
        "Show the full payer workflow: steps, usecase per step, roles, and allowed actions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "nhcx_update_abha_number",
      description:
        "Map a real ABHA number to a dummy ABHA number for cyclic-procedure claim testing. " +
        "Replaces the real ABHA captured during biometric authentication with the dummy ABHA " +
        "used in the claim, so claim validation can locate the dummy beneficiary's biometric " +
        "records. Intended for lower/test environments only.",
      inputSchema: {
        type: "object",
        properties: {
          realAbha: {
            type: "string",
            description: "Real ABHA number captured during biometric authentication",
            ...(config.realAbha ? { default: config.realAbha } : {}),
          },
          dummyAbha: {
            type: "string",
            description: "Dummy ABHA number used in the claim request",
            ...(config.dummyAbha ? { default: config.dummyAbha } : {}),
          },
        },
        required: ["realAbha", "dummyAbha"],
      },
    },
    {
      name: "nhcx_get_payment_details",
      description:
        "Step 1 of 2 of the PMJAY payment flow. Reads the payment the payer has created " +
        "for a registration and returns the caseid, amount, transactiondate and " +
        "paymentrequestid that step 2 (nhcx_update_payment) needs, unchanged. " +
        "The registration may be given as the full case number " +
        "(PMJAY/HP/S/2024/R2/2026102610000155) or the bare number — the prefix is " +
        "stripped automatically for this call. Note that the returned caseid comes back " +
        "in the full prefixed form and must be passed to step 2 verbatim. This returns " +
        "PAYR-1401 until the payer has issued the first payment notice for the case.",
      inputSchema: {
        type: "object",
        properties: {
          registrationId: {
            type: "string",
            description:
              "Case number to read payment details for — full (PMJAY/HP/S/2024/R2/…) or " +
              "bare. The PMJAY/… prefix is stripped before the call.",
          },
          payerId: {
            type: "string",
            description: "Payer ID",
            ...(config.payerId ? { default: config.payerId } : {}),
          },
        },
        required: ["registrationId"],
      },
    },
    {
      name: "nhcx_update_payment",
      description:
        "Step 2 of 2 of the PMJAY payment flow. Posts the payment update (UTR/status) for " +
        "the case to the NHA payer portal, closing the loop opened by step 1 " +
        "(nhcx_get_payment_details). Pass that step's caseid, amount, transactiondate and " +
        "paymentrequestid unchanged. Authenticated by payer-portal identity headers, not " +
        "a bearer token. Returns ERR-PYR-PAY-004 if the case id is not one the portal " +
        "knows — always pass step 1's caseid as-is rather than reconstructing it.",
      inputSchema: {
        type: "object",
        properties: {
          caseId: {
            type: "string",
            description:
              "caseid returned by step 1, verbatim — usually the full PMJAY/... form; " +
              "do not strip or reformat it",
          },
          amount: {
            description: "amount returned by step 1 (number or string)",
          },
          transactionDate: {
            type: "string",
            description:
              "transactiondate returned by step 1 (DD/MM/YYYY). ISO YYYY-MM-DD is also " +
              "accepted and converted.",
          },
          paymentRequestId: {
            type: "string",
            description: "paymentrequestid returned by step 1",
          },
          type: { type: "string", description: "Payment type", default: "Normal" },
          utrno: {
            type: "string",
            description: "UTR / transaction reference number",
            default: config.paymentUtr,
          },
          status: { type: "string", description: "Payment status", default: "Paid" },
          remarks: { type: "string", description: "Remarks", default: "Testing" },
          payerId: {
            type: "string",
            description: "Payer ID (sent as the pid header)",
            ...(config.payerId ? { default: config.payerId } : {}),
          },
        },
        required: ["caseId", "amount", "transactionDate", "paymentRequestId"],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleValidateConfig() {
  const issues = [];

  if (!config.clientId) issues.push("NDHM_CLIENT_ID is not set");
  if (!config.clientSecret) issues.push("NDHM_CLIENT_SECRET is not set");

  const urls = getUrls();
  const envReport = {
    NDHM_CLIENT_ID: config.clientId ? "set" : "MISSING",
    NDHM_CLIENT_SECRET: config.clientSecret ? "set" : "MISSING",
    NDHM_URL: config.authUrl,
    NHCX_ENV: config.env,
    hostSet: HOSTS[config.env]
      ? config.env
      : `sandbox (no host set defined for "${config.env}")`,
    PAYER_ID: config.payerId,
    SENDER_CODE: config.senderCode || "(not set)",
    MEMBER_ID: config.memberId || "(not set)",
    REAL_ABHA: config.realAbha || "(not set)",
    DUMMY_ABHA: config.dummyAbha || "(not set)",
    PAYMENT_UTR: config.paymentUtr,
    PAYER_PORTAL_UID: config.portalUid,
    PAYER_PORTAL_UNAME: config.portalUname,
    PAYER_PORTAL_UROLE: config.portalUrole,
    PAYER_PORTAL_USTATE: config.portalUstate,
    PAYER_PORTAL_SOURCE: config.portalSource,
    PAYER_PORTAL_HID: config.portalHid,
    PAYER_PORTAL_CID: config.portalCid,
    NHCX_TIMEOUT: `${config.timeout}ms`,
    NHCX_RETRIES: config.retries,
    DEBUG: config.debug,
    urls: {
      userRole: urls.userRole,
      processCase: urls.processCase,
      updateAbha: urls.updateAbha,
      paymentDetails: urls.paymentDetails,
      paymentUpdate: urls.paymentUpdate,
      cmId: urls.cmId,
    },
  };

  let authResult = null;
  let userRoleReachable = false;
  let processCaseReachable = false;
  let updateAbhaReachable = false;
  let paymentDetailsReachable = false;
  let paymentUpdateReachable = false;

  if (issues.length === 0) {
    try {
      const token = await getAccessToken();
      authResult = `OK (token: ${token.substring(0, 20)}...)`;
    } catch (e) {
      authResult = `FAILED: ${e.message}`;
      issues.push(`Auth failed: ${e.message}`);
    }

    // Test API URL reachability
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      await fetch(urls.userRole, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);
      userRoleReachable = true;
    } catch {
      // HEAD may return 405; try a quick GET instead
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const r = await fetch(urls.userRole, { signal: controller.signal });
        clearTimeout(timer);
        userRoleReachable = true;
      } catch {
        userRoleReachable = false;
        issues.push(`User-role URL unreachable: ${urls.userRole}`);
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(urls.processCase, { signal: controller.signal });
      clearTimeout(timer);
      processCaseReachable = true;
    } catch {
      processCaseReachable = false;
      issues.push(`Process-case URL unreachable: ${urls.processCase}`);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      await fetch(urls.updateAbha, { signal: controller.signal });
      clearTimeout(timer);
      updateAbhaReachable = true;
    } catch {
      updateAbhaReachable = false;
      issues.push(`ABHA-update URL unreachable: ${urls.updateAbha}`);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(urls.paymentDetails, { signal: controller.signal });
      clearTimeout(timer);
      paymentDetailsReachable = true;
    } catch {
      paymentDetailsReachable = false;
      issues.push(`Payment-details URL unreachable: ${urls.paymentDetails}`);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      await fetch(urls.paymentUpdate, { signal: controller.signal });
      clearTimeout(timer);
      paymentUpdateReachable = true;
    } catch {
      paymentUpdateReachable = false;
      issues.push(`Payment-update URL unreachable: ${urls.paymentUpdate}`);
    }
  }

  return ok({
    valid: issues.length === 0,
    issues,
    config: envReport,
    connectivity: {
      auth: authResult,
      userRoleUrl: userRoleReachable ? "reachable" : "UNREACHABLE",
      processCaseUrl: processCaseReachable ? "reachable" : "UNREACHABLE",
      updateAbhaUrl: updateAbhaReachable ? "reachable" : "UNREACHABLE",
      paymentDetailsUrl: paymentDetailsReachable ? "reachable" : "UNREACHABLE",
      paymentUpdateUrl: paymentUpdateReachable ? "reachable" : "UNREACHABLE",
    },
  });
}

async function handleLogin() {
  const token = await getAccessToken();
  return ok({
    clientId: config.clientId,
    tokenPrefix: token.substring(0, 40) + "...",
    cachedFor: "15 minutes",
  });
}

async function handleGetUserRole(args) {
  const token = await getAccessToken();
  const urls = getUrls();
  const body = {
    caseid: args.caseId,
    payerid: args.payerId || config.payerId,
  };

  const result = await nhcxApi(urls.userRole, "/get/user-role", token, body);

  // Enhance with allowed actions for the role
  let roleName = null;
  let allowedActions = [];
  if (result && result.currentuserrole) {
    roleName = result.currentuserrole;
    const step = stepForRole(roleName);
    if (step) allowedActions = step.actions;
  }

  return ok({
    caseId: args.caseId,
    role: roleName || "unknown",
    allowedActions,
    rawResponse: result,
  });
}

async function handleProcessCase(args) {
  // Validate action exists
  if (!VALID_ACTIONS.has(args.action)) {
    return fail(
      `Unknown action "${args.action}". Valid actions: ${[...VALID_ACTIONS].sort().join(", ")}`
    );
  }

  const token = await getAccessToken();
  const urls = getUrls();

  // process/case only accepts the numeric ID, not "PMJAY/HP/S/2024/R2/..."
  const numericCaseId = registrationNumber(args.caseId);

  // Derive usecase from the CURRENT role, not just the action. "Approve"/"Reject"
  // appear in multiple steps (PREAUTH, MAC, ACO, SHA, Claim Review), so an
  // action-only first-match wrongly maps them to PREAUTH. The current role is
  // authoritative for where the case sits in the workflow.
  let step = null;
  try {
    const roleBody = {
      caseid: args.caseId,
      payerid: args.receiverCode || config.payerId,
    };
    const roleResult = await nhcxApi(urls.userRole, "/get/user-role", token, roleBody);
    const roleName = roleResult?.currentuserrole;
    if (roleName) {
      step = stepForRole(roleName);
      if (step && !step.actions.includes(args.action)) {
        return fail(
          `Action "${args.action}" is not allowed for current role "${roleName}". ` +
          `Allowed: ${step.actions.join(", ")}`
        );
      }
    }
  } catch (e) {
    debug("Could not resolve current role, falling back to action-derived usecase:", e.message);
  }

  if (!step) step = deriveStep(args.action);
  const usecase = step ? step.usecase : "CLAIM";
  const correlationId = args.correlationId;

  const body = {
    casenumber: numericCaseId,
    action: args.action,
    receivercode: args.receiverCode || config.payerId,
    usecase,
    correlationid: correlationId,
    sendercode: args.senderCode,
    memberid: args.memberId,
    remarks: args.remarks || "ok",
  };

  const result = await nhcxApi(urls.processCase, "/process/case", token, body);

  return ok({
    caseId: args.caseId,
    action: args.action,
    usecase,
    role: step ? step.role : null,
    correlationId,
    rawResponse: result,
  });
}

function handleWorkflow() {
  return ok({ workflow: WORKFLOW });
}

async function handleUpdateAbhaNumber(args) {
  const token = await getAccessToken();
  const urls = getUrls();

  const realAbha = args.realAbha || config.realAbha;
  const dummyAbha = args.dummyAbha || config.dummyAbha;

  const body = {
    realAbha,
    dummyAbha,
  };

  const result = await nhcxApi(urls.updateAbha, "/update/abhanumber", token, body);

  return ok({
    realAbha,
    dummyAbha,
    rawResponse: result,
  });
}

// ---------------------------------------------------------------------------
// Payer error hints — the raw bodies are "HTTP 400: {"error":{"code":...}}"
// ---------------------------------------------------------------------------

const PAYER_HINTS = {
  "PAYR-1401": (ctx) =>
    `No payment details for registration "${ctx.registrationNumber}". Either that ` +
    `registration number does not match a case, or the payer has not issued the first ` +
    `payment notice for the case yet — step 1 returns nothing before that notice exists.`,
  "ERR-PYR-PAY-004": () =>
    `The NHA payer portal has no active case for this case id. Pass the caseid returned ` +
    `by step 1 (nhcx_get_payment_details) exactly as it came back — it is usually the ` +
    `full PMJAY/... case number and must not be reformatted or stripped.`,
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

/** Runs a payment handler and rethrows with a readable message + the parsed error. */
async function withPayerErrors(ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    const parsed = e.payerError || parsePayerError(e.message);
    // Only reshape HTTP failures from the payer; auth/config errors pass through as-is.
    if (!parsed.status && !parsed.code) throw e;
    const error = new Error(payerErrorMessage(parsed, ctx));
    error.payerError = parsed;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// PMJAY payment flow — step 1 of 2
// ---------------------------------------------------------------------------

async function handleGetPaymentDetails(args) {
  const registration = registrationNumber(args.registrationId);

  return withPayerErrors({ registrationNumber: registration }, async () => {
    const token = await getAccessToken();
    const urls = getUrls();

    const body = {
      registrationid: registration,
      payerid: args.payerId || config.payerId,
    };

    const result = await nhcxApi(urls.paymentDetails, "/get/payment/details", token, body);

    const paymentDetails = {
      caseid: result?.caseid ?? null,
      amount: result?.amount ?? null,
      transactiondate: result?.transactiondate ?? null,
      paymentrequestid: result?.paymentrequestid ?? null,
    };

    return ok({
      step: "1/2",
      registrationId: args.registrationId,
      registrationNumber: registration,
      payerId: body.payerid,
      paymentDetails,
      ...(paymentDetails.caseid
        ? {
            nextStep:
              "Call nhcx_update_payment with these values from paymentDetails: " +
              `caseId="${paymentDetails.caseid}", amount=${paymentDetails.amount}, ` +
              `transactionDate="${paymentDetails.transactiondate}", ` +
              `paymentRequestId="${paymentDetails.paymentrequestid}".`,
          }
        : {
            warning:
              "Payer returned no payment details — the first payment notice for this " +
              "case has probably not been issued yet. Step 1 has nothing to return until " +
              "it has.",
          }),
      rawResponse: result,
    });
  });
}

// ---------------------------------------------------------------------------
// PMJAY payment flow — step 2 of 2
// ---------------------------------------------------------------------------

async function handleUpdatePayment(args) {
  const missing = ["caseId", "amount", "transactionDate", "paymentRequestId"].filter(
    (key) => args[key] === undefined || args[key] === null || String(args[key]).trim() === ""
  );
  if (missing.length) {
    return fail(
      `Step 2 of 2 needs the values returned by step 1 (nhcx_get_payment_details). ` +
        `Missing: ${missing.join(", ")}.`
    );
  }

  const transactionDateSent = payerDate(args.transactionDate);

  return withPayerErrors({}, async () => {
    const urls = getUrls();
    const payerId = args.payerId || config.payerId;

    const headers = {
      uid: config.portalUid,
      uname: config.portalUname,
      urole: config.portalUrole,
      hid: config.portalHid,
      pid: payerId,
      cid: config.portalCid,
      ustate: config.portalUstate,
      source: config.portalSource,
    };

    const body = {
      type: args.type || "Normal",
      utrno: args.utrno || config.paymentUtr,
      status: args.status || "Paid",
      remarks: args.remarks || "Testing",
      caseid: args.caseId,
      amount: args.amount,
      transactiondate: transactionDateSent,
      paymentrequestid: args.paymentRequestId,
    };

    const result = await payerPortalApi(urls.paymentUpdate, "/payment/update", headers, body);

    return ok({
      step: "2/2",
      inputs: {
        caseId: body.caseid,
        amount: body.amount,
        transactionDate: args.transactionDate,
        transactionDateSent,
        paymentRequestId: body.paymentrequestid,
        type: body.type,
        utrno: body.utrno,
        status: body.status,
        remarks: body.remarks,
      },
      protocolStatus: result?.result?.protocol_status,
      rawResponse: result,
    });
  });
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const tools = buildTools();

const server = new Server(
  { name: "nhcx-payer-mcp", version: "1.8.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "nhcx_validate_config":
        return await handleValidateConfig();
      case "nhcx_login":
        return await handleLogin();
      case "nhcx_get_user_role":
        return await handleGetUserRole(args);
      case "nhcx_process_case":
        return await handleProcessCase(args);
      case "nhcx_workflow":
        return handleWorkflow();
      case "nhcx_update_abha_number":
        return await handleUpdateAbhaNumber(args);
      case "nhcx_get_payment_details":
        return await handleGetPaymentDetails(args);
      case "nhcx_update_payment":
        return await handleUpdatePayment(args);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    debug("Error:", e.message);
    return fail(e.message, e.payerError || {});
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

debug(`Starting nhcx-payer-mcp (env: ${config.env}, timeout: ${config.timeout}ms, retries: ${config.retries})`);
if (!HOSTS[config.env]) {
  debug(`No host set for NHCX_ENV="${config.env}" — using sandbox hosts (override with NHCX_*_URL)`);
}
debug("Endpoints:", getUrls());

const transport = new StdioServerTransport();
await server.connect(transport);
