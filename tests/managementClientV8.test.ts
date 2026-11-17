import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('v8 management transport', () => {
  test('uses the v8 prefix, bearer authentication and bare JSON scalar writes', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway/v8/management',
      managementKey: 'fixture-only',
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{"status":"ok"}', { status: 200 })
    );
    try {
      await apiClient.put('/config/observability/logs/debug', false);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(url).toBe('https://proxy.invalid/gateway/v8/management/config/observability/logs/debug');
      expect(init.method).toBe('PUT');
      expect(headers.get('Authorization')).toBe('Bearer fixture-only');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init.body).toBe('false');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('retains backend version and plugin support events', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'x-cpa-version': 'v8.0.3', 'x-cpa-support-plugin': 'true' },
        })
    );
    try {
      await apiClient.get('/config');
    } finally {
      fetchSpy.mockRestore();
    }
    expect(events.map((event) => event.type)).toEqual([
      'server-version-update',
      'server-plugin-support-update',
    ]);
    expect((events[0] as CustomEvent).detail.version).toBe('v8.0.3');
    expect((events[1] as CustomEvent).detail.supportsPlugin).toBe(true);
  });
});
