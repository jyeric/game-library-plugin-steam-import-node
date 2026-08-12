const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Creates a fetch-compatible adapter backed by the client's permission-checked
 * http.fetchAllowed host API.
 */
export function createHostFetch(hostCall) {
  if (typeof hostCall !== "function") {
    throw new TypeError("hostCall must be a function");
  }

  return async function hostFetch(url, options = {}) {
    const payload = {
      url: String(url),
      method: options.method ?? "GET",
      headers: requestHeaders(options.headers),
      redirect: options.redirect ?? "follow",
      responseMode: "text",
      includeSetCookie: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
    const result = await hostCall("http.fetchAllowed", payload);
    return responseFromHost(result);
  };
}

function requestHeaders(input) {
  const output = {};
  new Headers(input ?? {}).forEach((value, name) => {
    output[name] = value;
  });
  return output;
}

function responseFromHost(result) {
  const status = Number(result?.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("http.fetchAllowed returned an invalid HTTP status.");
  }
  const headers = new Headers();
  for (const [name, values] of Object.entries(result?.headers ?? {})) {
    for (const value of Array.isArray(values) ? values : [values]) {
      headers.append(name, String(value));
    }
  }
  if (result?.contentType && !headers.has("content-type")) {
    headers.set("content-type", String(result.contentType));
  }
  return new Response(result?.body ?? "", { status, headers });
}
