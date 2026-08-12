import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ACCOUNT_PROVIDER_ID, handleAction } from "../src/jsonrpc/handleAction.mjs";
import { createHostFetch } from "../src/jsonrpc/hostFetch.mjs";
import { errorResponse } from "../src/jsonrpc/responses.mjs";
import { markSteamLoginRequired } from "../src/steam/session.mjs";

function log(message) {
  const logPath = process.env.STEAM_IMPORT_PLUGIN_LOG;
  if (!logPath) {
    return;
  }
  try {
    appendFileSync(logPath, `[provider.mjs] ${message}\n`, "utf8");
  } catch {
    // Logging must never corrupt the JSON-RPC stdout contract.
  }
}

let requestId = null;
let hostCallSequence = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();

async function main() {
  log(`node_version=${process.version}`);
  log(`cwd=${process.cwd()}`);
  const input = await readRuntimeLine();
  log(`stdin_bytes=${Buffer.byteLength(input, "utf8")}`);
  const request = JSON.parse(input);
  requestId = request.id ?? null;
  log(`request_id=${request.id ?? ""}`);
  log(`method=${request.method ?? ""}`);
  log(`action_id=${request.params?.actionId ?? ""}`);
  const output = await executeAction(request);
  log(`response_kind=${output.result ? "result" : "error"}`);
  log(`host_api=${output.result?.hostApi ?? ""}`);
  log(`error_message=${output.error?.message ?? ""}`);
  return output;
}

async function executeAction(request) {
  const originalPayload = request.params?.payload ?? {};
  const context = { fetchImpl: createHostFetch(hostCall) };
  const output = await handleAction(request.id, request.params, context);
  if (output.result?.hostApi !== "tools.requestReviewedCommand") {
    return output;
  }
  let hostPayload;
  try {
    hostPayload = await hostCall(output.result.hostApi, output.result.payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markSteamLoginRequired();
    return errorResponse(request.id, message, {
      messageKey: "error.providerLoginRequired",
      messageParams: { providerId: ACCOUNT_PROVIDER_ID },
    });
  }
  return handleAction(request.id, {
    ...request.params,
    payload: {
      ...originalPayload,
      originalPayload,
      runtimeHostResult: {
        step: 1,
        hostApi: output.result.hostApi,
        payload: hostPayload,
      },
    },
  }, context);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`fatal_error=${message}`);
  if (error instanceof Error && error.stack) {
    log(`fatal_stack=${error.stack.replace(/\r?\n/g, " | ")}`);
  }
  process.stdout.write(`${JSON.stringify(errorResponse(requestId, message))}\n`);
}

async function hostCall(apiId, payload) {
  const id = `host-${++hostCallSequence}`;
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "host.call",
    params: { apiId, payload },
  })}\n`);
  const response = JSON.parse(await readRuntimeLine());
  if (response.id !== id) {
    throw new Error(`host response id did not match ${id}.`);
  }
  if (response.error) {
    throw new Error(response.error.message ?? `${apiId} failed.`);
  }
  return response.result?.payload;
}

async function readRuntimeLine() {
  const next = await lines.next();
  if (next.done || !String(next.value).trim()) {
    throw new Error("runtime stdin closed before a JSON-RPC message was received.");
  }
  return String(next.value).trim();
}
