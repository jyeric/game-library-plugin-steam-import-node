export function response(id, hostApi, payload) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      hostApi,
      payload,
    },
  };
}

export function errorResponse(id, message, data) {
  const error = {
    code: -32000,
    message,
  };
  if (data && typeof data === "object") {
    error.data = data;
  }
  return {
    jsonrpc: "2.0",
    id,
    error,
  };
}
