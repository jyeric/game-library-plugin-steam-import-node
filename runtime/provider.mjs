import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { handleAction } from "../src/jsonrpc/handleAction.mjs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const actions = new Map(manifest.actions.map((action) => [action.id, action]));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;

function send(frame) {
  const line = JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n";
  if (Buffer.byteLength(line) > 1048576) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "Steam result exceeds the 1 MiB frame limit; select fewer libraries." } }) + "\n");
  } else process.stdout.write(line);
}

// Initialization and action.invoke share one process. Results are direct domain data.
for await (const line of lines) {
  let request;
  try {
    if (Buffer.byteLength(line) >= 1048576) throw new Error("Frame exceeds limit");
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Invalid JSON-RPC frame" } });
    continue;
  }
  const id = request?.id ?? null;
  const params = request?.params ?? {};
  if (request?.jsonrpc !== "2.0" || !(typeof id === "string" || Number.isSafeInteger(id)) || "result" in request || "error" in request) {
    send({ id, error: { code: -32600, message: "Invalid JSON-RPC request" } });
  } else if (request.method === "plugin.initialize") {
    if (initialized || params.protocolVersion !== 1 || params.pluginId !== manifest.id) {
      send({ id, error: { code: -32602, message: "Invalid plugin initialization" } });
    } else {
      initialized = true;
      send({ id, result: { protocolVersion: 1, pluginId: manifest.id, actions: [...actions.keys()] } });
    }
  } else if (request.method === "action.invoke") {
    if (!initialized || !actions.has(params.action) || typeof params.invocationId !== "string" || !params.invocationId || typeof params.operationKey !== "string" || !params.operationKey) {
      send({ id, error: { code: -32602, message: "Invalid plugin invocation" } });
      continue;
    }
    const input = params.input ?? {};
    const selected = input.input?.["selected-libraries"]?.paths;
    if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.some((path) => typeof path !== "string" || !path.trim()))) {
      send({ id, error: { code: -32602, message: "Selected Steam library paths must be nonempty strings" } });
      continue;
    }
    const response = await handleAction(id, {
      actionId: params.action === "discover" ? "read-candidates" : params.action,
      payload: selected ? { ...input, libraries: selected } : input,
    });
    send(response.error ? { id, error: response.error } : { id, result: response.result.payload });
  } else {
    send({ id, error: { code: -32601, message: "Unsupported method; plugin requires json-rpc/1" } });
  }
}
