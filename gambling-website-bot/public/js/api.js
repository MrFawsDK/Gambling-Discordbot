export class ApiError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  // The server only accepts JSON on POSTs (that's part of the CSRF protection), so a POST
  // without data, like cashing out, still sends an empty JSON object.
  if (method !== 'GET' && body === undefined) body = {};
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Not JSON: handled below as an internal error.
  }
  if (!response.ok) throw new ApiError(data?.error ?? 'internal', data?.params ?? {});
  // Every endpoint answers with JSON. No body (e.g. a request cut off by a reload) is an error, not null.
  if (data === null) throw new ApiError('network');
  return data;
}
