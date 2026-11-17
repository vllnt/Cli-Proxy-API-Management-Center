import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import { httpRequest } from '../src/services/api/http';
import type { ApiError } from '../src/types';

type FetchCall = [string, RequestInit];

const restores: Array<{ mockRestore(): void }> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

const mockFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const spy = spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    impl(String(input), init ?? {})
  );
  restores.push(spy);
  return spy;
};

// A request that never answers on its own but, like real fetch, rejects once aborted.
const hangUntilAborted = (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

afterEach(() => {
  restores.splice(0).forEach((spy) => spy.mockRestore());
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('fetch transport request building', () => {
  test('serializes JSON bodies, scalar writes and sends no body or type on reads', async () => {
    const spy = mockFetch(async () => new Response('{}'));
    await httpRequest('POST', '/a', { data: { name: 'x' } });
    await httpRequest('PUT', '/b', { data: false });
    await httpRequest('PUT', '/c', { data: null });
    await httpRequest('GET', '/d');
    const calls = spy.mock.calls as FetchCall[];

    expect(calls[0][1].body).toBe('{"name":"x"}');
    expect(new Headers(calls[0][1].headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(calls[0][1].headers).get('Accept')).toBe('application/json, text/plain, */*');
    expect(calls[1][1].body).toBe('false');
    expect(calls[2][1].body).toBe('null');
    expect(calls[3][1].body).toBeUndefined();
    expect(new Headers(calls[3][1].headers).has('Content-Type')).toBe(false);
  });

  test('sends strings as-is for non-JSON types and keeps valid JSON text unquoted', async () => {
    const spy = mockFetch(async () => new Response(''));
    await httpRequest('PUT', '/yaml', {
      data: 'a: 1\n',
      headers: { 'Content-Type': 'application/yaml' },
    });
    await httpRequest('PUT', '/json-text', { data: ' {"a":1} ' });
    await httpRequest('PUT', '/plain-text', { data: 'not json' });
    const calls = spy.mock.calls as FetchCall[];

    expect(calls[0][1].body).toBe('a: 1\n');
    expect(new Headers(calls[0][1].headers).get('Content-Type')).toBe('application/yaml');
    expect(calls[1][1].body).toBe('{"a":1}');
    expect(calls[2][1].body).toBe('"not json"');
  });

  test('leaves the multipart boundary to the browser for FormData', async () => {
    const spy = mockFetch(async () => new Response('{}'));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.json');
    await httpRequest('POST', '/upload', {
      data: form,
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const [, init] = (spy.mock.calls as FetchCall[])[0];

    expect(init.body).toBe(form);
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  test('appends query params, skipping empty values and expanding arrays', async () => {
    const spy = mockFetch(async () => new Response('{}'));
    await httpRequest('GET', '/q', { params: { a: 1, b: true, c: undefined, d: null, e: 'x y' } });
    await httpRequest('GET', '/q?name=n', { params: { all: true } });
    await httpRequest('GET', '/q', { params: { ids: [1, 2] } });
    await httpRequest('GET', '/q', { params: {} });
    const urls = (spy.mock.calls as FetchCall[]).map(([url]) => url);

    expect(urls).toEqual([
      '/q?a=1&b=true&e=x+y',
      '/q?name=n&all=true',
      `/q?${encodeURIComponent('ids[]')}=1&${encodeURIComponent('ids[]')}=2`,
      '/q',
    ]);
  });
});

describe('fetch transport responses', () => {
  test('parses JSON, falls back to text and keeps empty bodies empty', async () => {
    mockFetch(async (url) =>
      new Response(
        { '/json': '{"ok":true}', '/text': '<html>nope</html>', '/empty': '' }[url] ?? '',
        { status: url === '/empty' ? 204 : 200 }
      )
    );

    expect((await httpRequest('GET', '/json')).data).toEqual({ ok: true });
    expect((await httpRequest('GET', '/text')).data).toBe('<html>nope</html>');
    expect((await httpRequest('GET', '/empty')).data).toBe('');
    expect((await httpRequest('GET', '/json', { responseType: 'text' })).data).toBe('{"ok":true}');
  });

  test('returns Blob bodies for downloads', async () => {
    mockFetch(async () => new Response('log line'));
    const { data, status } = await httpRequest<Blob>('GET', '/dl', { responseType: 'blob' });

    expect(status).toBe(200);
    expect(data).toBeInstanceOf(Blob);
    expect(await data.text()).toBe('log line');
  });

  test('rejects non-2xx with the status message, error code and parsed body', async () => {
    mockFetch(async (url) =>
      url === '/server'
        ? new Response('boom', { status: 502 })
        : new Response('{"error":"missing"}', { status: 404 })
    );

    await expect(httpRequest('GET', '/client')).rejects.toMatchObject({
      message: 'Request failed with status code 404',
      code: 'ERR_BAD_REQUEST',
      status: 404,
      data: { error: 'missing' },
    });
    await expect(httpRequest('GET', '/server')).rejects.toMatchObject({
      message: 'Request failed with status code 502',
      code: 'ERR_BAD_RESPONSE',
      status: 502,
      data: 'boom',
    });
  });
});

describe('fetch transport failures', () => {
  test('reports transport failures as ERR_NETWORK', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(httpRequest('GET', '/x')).rejects.toMatchObject({
      message: 'Network Error',
      code: 'ERR_NETWORK',
      status: undefined,
    });
  });

  test('reports timeouts as ECONNABORTED', async () => {
    mockFetch(hangUntilAborted);

    await expect(httpRequest('GET', '/slow', { timeout: 10 })).rejects.toMatchObject({
      message: 'timeout of 10ms exceeded',
      code: 'ECONNABORTED',
    });
  });

  test('reports aborts as ERR_CANCELED and honours an already aborted signal', async () => {
    mockFetch(hangUntilAborted);
    const controller = new AbortController();
    const pending = httpRequest('GET', '/x', { signal: controller.signal, timeout: 60_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: 'canceled', code: 'ERR_CANCELED' });

    await expect(
      httpRequest('GET', '/x', { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  });

  test('applies no timeout unless one is requested', async () => {
    const timeout = spyOn(AbortSignal, 'timeout');
    restores.push(timeout);
    mockFetch(async () => new Response('{}'));
    await httpRequest('GET', '/x');
    await httpRequest('GET', '/x', { timeout: 0 });

    expect(timeout).not.toHaveBeenCalled();
  });
});

describe('management client over fetch', () => {
  const captureEvents = () => {
    const events: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: (event: Event) => events.push(event.type) },
    });
    return events;
  };

  test('normalizes failures to ApiError and emits unauthorized for 401', async () => {
    const events = captureEvents();
    mockFetch(
      async () =>
        new Response('{"error":"unauthorized","message":"Key rejected"}', {
          status: 401,
          headers: { 'X-CPA-Version': 'ignored-on-errors' },
        })
    );

    const error = (await apiClient.get('/config').catch((err: ApiError) => err)) as ApiError;
    expect(error).toMatchObject({
      name: 'ApiError',
      message: 'Key rejected',
      status: 401,
      code: 'ERR_BAD_REQUEST',
      apiCode: 'unauthorized',
      data: { error: 'unauthorized', message: 'Key rejected' },
      details: { error: 'unauthorized', message: 'Key rejected' },
    });
    expect(events).toEqual(['unauthorized']);
  });

  test('keeps the generic status message when the body has no detail', async () => {
    captureEvents();
    mockFetch(async () => new Response('', { status: 503 }));

    await expect(apiClient.get('/config')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Request failed with status code 503',
      status: 503,
      code: 'ERR_BAD_RESPONSE',
    });
  });

  test('maps transport failures without a status and without a logout event', async () => {
    const events = captureEvents();
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(apiClient.get('/config')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Network Error',
      code: 'ERR_NETWORK',
      status: undefined,
    });
    expect(events).toEqual([]);
  });

  test('joins the base URL, keeps absolute URLs and always sends the stored key', async () => {
    const spy = mockFetch(async () => new Response('{}'));
    apiClient.setConfig({ apiBase: 'https://proxy.invalid/v8/management/', managementKey: 'k' });
    captureEvents();
    await apiClient.get('/config', { headers: { authorization: 'Bearer other' } });
    await apiClient.get('https://other.invalid/x');
    const calls = spy.mock.calls as FetchCall[];

    expect(calls[0][0]).toBe('https://proxy.invalid/v8/management/config');
    expect(new Headers(calls[0][1].headers).get('Authorization')).toBe('Bearer k');
    expect(calls[1][0]).toBe('https://other.invalid/x');
  });

  test('uses the configured default timeout and lets requests override it', async () => {
    captureEvents();
    mockFetch(async () => new Response('{}'));
    const timeout = spyOn(AbortSignal, 'timeout');
    restores.push(timeout);

    apiClient.setConfig({ apiBase: '', managementKey: '', timeout: 1234 });
    await apiClient.get('/a');
    await apiClient.get('/b', { timeout: 99 });
    await apiClient.get('/c', { timeout: 0 });

    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([1234, 99]);
  });

  test('sends multipart uploads and DELETE bodies', async () => {
    captureEvents();
    const spy = mockFetch(async () => new Response('{}'));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.json');
    await apiClient.postForm('/credentials', form);
    await apiClient.delete('/credentials', { data: { names: ['a'] }, params: { all: true } });
    const calls = spy.mock.calls as FetchCall[];

    expect(calls[0][1]).toMatchObject({ method: 'POST', body: form });
    expect(new Headers(calls[0][1].headers).has('Content-Type')).toBe(false);
    expect(calls[1][0]).toBe('/credentials?all=true');
    expect(calls[1][1]).toMatchObject({ method: 'DELETE', body: '{"names":["a"]}' });
  });
});
