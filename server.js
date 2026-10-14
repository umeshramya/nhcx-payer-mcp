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
// Hardcoded API endpoints
// ---------------------------------------------------------------------------

function getUrls() {
  return {
    userRole: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1",
    processCase: "https://apisbeta.nha.gov.in/pmjay/hcx/nhcxpayerservice/wrapper",
    updateAbha: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice",
    paymentDetails: "https://apisbx.abdm.gov.in/pmjay/sbxhcx/nhcxpayerservice/v1",
    paymentUpdate: "https://apisbeta.nha.gov.in/pmjay/payer/paypayment/v1",
    cmId: "sbx",
  };
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

function fail(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message } }, null, 2) }],
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
        "Step 1 of 2 of the PMJAY payment flow. Fetch the payment details for a " +
        "registration from the ABDM/NHCX payer service — returns the caseid, amount, " +
        "transactiondate and paymentrequestid that the payment-update step needs. " +
        "Call this first, then pass its output to nhcx_update_payment.",
      inputSchema: {
        type: "object",
        properties: {
          registrationId: {
            type: "string",
            description: "PMJAY registration ID (registrationid) to fetch payment details for",
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
        "Step 2 of 2 of the PMJAY payment flow. Post the payment update (UTR/status) for a " +
        "case to the NHA payer portal. Authenticated by portal identity headers, not a " +
        "bearer token. Use the values returned by nhcx_get_payment_details.",
      inputSchema: {
        type: "object",
        properties: {
          caseId: { type: "string", description: "Case ID (caseid) from step 1" },
          amount: {
            description: "Payment amount from step 1 (number or string)",
          },
          transactionDate: {
            type: "string",
            description: "Transaction date from step 1 (as returned)",
          },
          paymentRequestId: {
            type: "string",
            description: "Payment request ID (paymentrequestid) from step 1",
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

  // Strip prefix like "PMJAY/HP/S/2024/R2/" — process/case only accepts numeric ID
  const numericCaseId = args.caseId.includes("/") ? args.caseId.split("/").pop() : args.caseId;

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

async function handleGetPaymentDetails(args) {
  const token = await getAccessToken();
  const urls = getUrls();

  const body = {
    registrationid: args.registrationId,
    payerid: args.payerId || config.payerId,
  };

  const result = await nhcxApi(urls.paymentDetails, "/get/payment/details", token, body);

  return ok({
    registrationId: args.registrationId,
    payerId: body.payerid,
    paymentDetails: {
      caseid: result?.caseid,
      amount: result?.amount,
      transactiondate: result?.transactiondate,
      paymentrequestid: result?.paymentrequestid,
    },
    nextStep:
      "Pass caseid, amount, transactiondate and paymentrequestid to nhcx_update_payment.",
    rawResponse: result,
  });
}

async function handleUpdatePayment(args) {
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
    transactiondate: args.transactionDate,
    paymentrequestid: args.paymentRequestId,
  };

  const result = await payerPortalApi(urls.paymentUpdate, "/payment/update", headers, body);

  return ok({
    caseId: args.caseId,
    utrno: body.utrno,
    status: body.status,
    protocolStatus: result?.result?.protocol_status,
    rawResponse: result,
  });
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const tools = buildTools();

const server = new Server(
  { name: "nhcx-payer-mcp", version: "1.7.0" },
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
    return fail(e.message);
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

debug(`Starting nhcx-payer-mcp (env: ${config.env}, timeout: ${config.timeout}ms, retries: ${config.retries})`);

const transport = new StdioServerTransport();
await server.connect(transport);
