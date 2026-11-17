/**
 * Minimal fetch transport shared by the Management API client and the few plain
 * requests that must not go through it (model listing, legacy backend probe).
 *
 * It keeps the error contract callers already depend on:
 * - non-2xx responses reject with `Request failed with status code N`
 *   (`ERR_BAD_REQUEST` for 4xx, `ERR_BAD_RESPONSE` for 5xx)
 * - transport failures reject with `ERR_NETWORK`, timeouts with `ECONNABORTED`,
 *   aborts with `ERR_CANCELED`
 * - the parsed error body is kept on `data`
 */

export type HttpResponseType = 'json' | 'text' | 'blob';

export interface HttpRequestConfig {
  /** Query parameters. `null`/`undefined` entries are skipped, arrays use `key[]`. */
  params?: object;
  headers?: Record<string, string>;
  /** Request body: FormData/Blob/binary as-is, strings as text, anything else as JSON. */
  data?: unknown;
  /** `json` (default) parses JSON and falls back to the raw text. */
  responseType?: HttpResponseType;
  /** Milliseconds; 0 or undefined disables the timeout. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export class HttpError extends Error {
  code?: string;
  status?: number;
  data?: unknown;

  constructor(message: string, code?: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const HTTP_ERROR_CODES = ['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'];

const isRawBody = (data: unknown): data is BodyInit =>
  data instanceof FormData ||
  data instanceof Blob ||
  data instanceof URLSearchParams ||
  data instanceof ArrayBuffer ||
  ArrayBuffer.isView(data);

const isJsonText = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const withParams = (url: string, params?: object): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(`${key}[]`, String(item)));
    else search.append(key, String(value));
  }
  const query = search.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

const buildBody = (data: unknown, headers: Headers): BodyInit | undefined => {
  if (data === undefined) return undefined;
  if (data instanceof FormData) {
    // The browser must add the multipart boundary itself.
    headers.delete('Content-Type');
    return data;
  }
  if (isRawBody(data)) return data;

  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const isJson = (headers.get('Content-Type') ?? '').includes('application/json');
  if (typeof data === 'string') {
    // A string sent as JSON is passed through when it already is JSON, otherwise quoted.
    if (!isJson) return data;
    return isJsonText(data) ? data.trim() : JSON.stringify(data);
  }
  return JSON.stringify(data);
};

const readBody = async (response: Response, responseType: HttpResponseType): Promise<unknown> => {
  if (responseType === 'blob') return response.blob();
  const text = await response.text();
  if (responseType === 'text' || !text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// AbortSignal.any needs Safari 17.4 / Firefox 124, above the panel's existing browser floor,
// so caller and timeout signals are combined by hand.
const anySignal = (signals: AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
};

export async function httpRequest<T = unknown>(
  method: string,
  url: string,
  config: HttpRequestConfig = {}
): Promise<HttpResponse<T>> {
  const { params, data, responseType = 'json', timeout, signal } = config;
  const headers = new Headers({ Accept: 'application/json, text/plain, */*' });
  Object.entries(config.headers ?? {}).forEach(([name, value]) => headers.set(name, value));

  const timeoutSignal = timeout && timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  const signals = [signal, timeoutSignal].filter((item): item is AbortSignal => Boolean(item));
  const combined = signals.length > 1 ? anySignal(signals) : signals[0];

  try {
    const response = await globalThis.fetch(withParams(url, params), {
      method,
      headers,
      body: buildBody(data, headers),
      signal: combined,
    });
    const body = await readBody(response, responseType);
    // A caller that gave up on this request must not see its late response, success or error.
    if (signal?.aborted) throw new HttpError('canceled', 'ERR_CANCELED');
    if (!response.ok) {
      throw new HttpError(
        `Request failed with status code ${response.status}`,
        HTTP_ERROR_CODES[Math.floor(response.status / 100) - 4],
        response.status,
        body
      );
    }
    return {
      data: body as T,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal?.aborted) throw new HttpError('canceled', 'ERR_CANCELED');
    if (timeoutSignal?.aborted) {
      throw new HttpError(`timeout of ${timeout}ms exceeded`, 'ECONNABORTED');
    }
    throw new HttpError('Network Error', 'ERR_NETWORK');
  }
}
