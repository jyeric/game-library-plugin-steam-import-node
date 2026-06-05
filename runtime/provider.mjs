import { appendFileSync, readFileSync } from "node:fs";
import { handleAction } from "../src/jsonrpc/handleAction.mjs";
import { errorResponse } from "../src/jsonrpc/responses.mjs";

function log(message) {
  const logPath = process.env.STEAM_IMPORT_PLUGIN_LOG;
  if (!logPath) {
    return;
  }
  appendFileSync(logPath, `[provider.mjs] ${message}\n`, "utf8");
}

function main() {
  log(`node_version=${process.version}`);
  log(`cwd=${process.cwd()}`);
  const input = readFileSync(0, "utf8").trim();
  log(`stdin_bytes=${Buffer.byteLength(input, "utf8")}`);
  const request = JSON.parse(input);
  log(`request_id=${request.id ?? ""}`);
  log(`method=${request.method ?? ""}`);
  log(`action_id=${request.params?.actionId ?? ""}`);
  const output = handleAction(request.id, request.params);
  log(`response_kind=${output.result ? "result" : "error"}`);
  log(`host_api=${output.result?.hostApi ?? ""}`);
  log(`error_message=${output.error?.message ?? ""}`);
  return output;
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`fatal_error=${message}`);
  if (error instanceof Error && error.stack) {
    log(`fatal_stack=${error.stack.replace(/\r?\n/g, " | ")}`);
  }
  process.stdout.write(`${JSON.stringify(errorResponse(null, message))}\n`);
}
