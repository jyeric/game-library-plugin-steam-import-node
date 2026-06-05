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

export function errorResponse(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message,
    },
  };
}

