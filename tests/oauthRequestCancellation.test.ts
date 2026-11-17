import { describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { createOAuthAttempts } from '@/pages/oauthAttempts';

// Use the real client with a deferred transport response.
// Abandoned requests must not emit old server metadata or log out a new session.
describe('OAuth transport cancellation', () => {
  for (const status of [200, 401]) {
    test(`suppresses stale response side effects (${status})`, async () => {
      const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const events: string[] = [];
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { dispatchEvent: (event: Event) => events.push(event.type) },
      });
      let dispatched!: () => void;
      const started = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      let deliver!: () => void;
      // Like a response already in flight: it ignores the abort signal and arrives late.
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            deliver = () =>
              resolve(
                new Response('{"status":"ok"}', {
                  status,
                  headers: { 'X-CPA-Version': 'old-server', 'X-CPA-Support-Plugin': 'true' },
                })
              );
            dispatched();
          })
      );
      const attempts = createOAuthAttempts({ setTimeout: () => 0, clearTimeout: () => {} });
      const attempt = attempts.begin('devin');
      try {
        const request = apiClient.get('/oauth/status', { signal: attempt.signal });
        await started;
        attempts.invalidateAll();
        const current = attempts.begin('devin');
        deliver();
        await expect(request).rejects.toHaveProperty('code', 'ERR_CANCELED');
        expect(events).toEqual([]);
        expect(current.signal.aborted).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        attempts.invalidateAll();
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    });
  }
});
