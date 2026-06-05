import { readFileSync } from "node:fs";
import { handleAction } from "../src/jsonrpc/handleAction.mjs";
import { errorResponse } from "../src/jsonrpc/responses.mjs";

function main() {
  const input = readFileSync(0, "utf8").trim();
  const request = JSON.parse(input);
  return handleAction(request.id, request.params);
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify(errorResponse(null, message))}\n`);
}

