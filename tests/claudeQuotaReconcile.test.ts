import { afterEach, expect, test } from 'bun:test';
import {
  createResetGrantOperations,
  resetGrantMessage,
} from '../src/features/quota/providers/claude/resetGrantOperations';
import { parseAnthropicResetGrantStatus } from '../src/services/api/claudeResetGrants';
import { apiClient } from '../src/services/api/client';
import { reconcileClaudeQuota } from '../src/services/api/claudeQuotaReconcile';

const servers: ReturnType<typeof Bun.serve>[] = [];
const organization = crypto.randomUUID();
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true));
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

const synced = {
  status: 'ok',
  auth_index: 'index',
  outcome: 'reconciled',
  observed_at: '2026-11-25T00:00:00Z',
  models: ['claude-test'],
  persistence: 'ok',
  remaining_quota_blocks: 0,
};

/** Only the external management/provider HTTP boundary is synthetic. Real clients and journal run. */
function fixture() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let grants = 1;
  let claim = 'reset';
  let syncResponse = async () => Response.json(synced);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-only');
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === '/v8/management/routing/quota/reconcile') {
        expect(body).toEqual({ auth_index: 'index' });
        return syncResponse();
      }
      expect(path).toBe('/v8/management/requests/api-call');
      expect(body.authIndex).toBe('index');
      const providerBody =
        body.method === 'POST'
          ? ((grants = 0), { result: claim })
          : String(body.url).endsWith('/profile')
            ? { organization: { uuid: organization } }
            : {
                cedar_ember: {
                  eligible: true,
                  at_limit: true,
                  grants: grants
                    ? [{ id: 'grant', resets_total: 1, resets_left: 1, usable_now: true }]
                    : [],
                },
              };
      return Response.json({ status_code: 200, body: providerBody, header: {} });
    },
  });
  servers.push(server);
  apiClient.setConfig({ apiBase: server.url.origin, managementKey: 'synthetic-only' });
  return {
    calls,
    operations: createResetGrantOperations(),
    claimCount: () => calls.filter((call) => call.body.method === 'POST').length,
    syncCount: () => calls.filter((call) => call.path.endsWith('/quota/reconcile')).length,
    respond: (body: unknown, status = 200) => {
      syncResponse = async () => Response.json(body, { status });
    },
    syncResponse: (response: () => Promise<Response>) => {
      syncResponse = response;
    },
    noGrants: () => {
      grants = 0;
    },
    alreadyUsed: () => {
      claim = 'already_used';
    },
    switchConnection: () =>
      apiClient.setConfig({ apiBase: server.url.origin, managementKey: 'replacement-only' }),
    timeout: (timeout: number) =>
      apiClient.setConfig({ apiBase: server.url.origin, managementKey: 'synthetic-only', timeout }),
  };
}

test('a redeemed grant reconciles the stale local quota block before reporting recovery', async () => {
  let quotaBlocked = true;
  let providerLimited = true;
  const calls: string[] = [];
  const operations = createResetGrantOperations({
    revision: () => 1,
    now: () => 100,
    requestId: () => 'request-1',
    readStatus: async () =>
      parseAnthropicResetGrantStatus({
        eligible: true,
        at_limit: true,
        grants: [{ id: 'grant', resets_total: 1, resets_left: 1, usable_now: true }],
      })!,
    readOrganization: async () => organization,
    claim: async () => {
      calls.push('redeem');
      providerLimited = false;
      return 'reset' as const;
    },
    reconcile: async () => {
      calls.push('sync');
      expect(operations.inspect('account')?.code).toBe('reset');
      quotaBlocked = providerLimited;
      return {
        outcome: 'reconciled' as const,
        persistence: 'ok' as const,
        remainingQuotaBlocks: 0,
        observedAt: '2026-11-25T00:00:00Z',
      };
    },
  });
  expect(quotaBlocked).toBe(true);
  await operations.run('account', 'index', 'grant');
  expect(calls).toEqual(['redeem', 'sync']);
  expect(quotaBlocked).toBe(false);
});

test.each([
  ['unsupported', { error: 'not found' }, 404, 'reset_pending'],
  ['upstream failure', { error: 'usage read failed' }, 502, 'reset_pending'],
  ['stale observation', { status: 'stale', runtime_applied: false }, 409, 'reset_pending'],
  ['blocked', { ...synced, outcome: 'blocked', remaining_quota_blocks: 1 }, 200, 'reset_pending'],
  ['partly cleared', { ...synced, remaining_quota_blocks: 1 }, 200, 'reset_pending'],
  [
    'partial persistence',
    { ...synced, status: 'partial', runtime_applied: true, persistence: 'failed' },
    503,
    'reset_persistence',
  ],
] as const)(
  'redemption then %s retries sync without an additional redemption POST',
  async (_name, response, statusCode, message) => {
    const h = fixture();
    h.respond(response, statusCode);
    const answer = await h.operations.run('account', 'index', 'grant');
    expect(answer).toEqual({ code: 'reset', unresolved: false, syncPending: true });
    expect(h.operations.inspect('account')?.code).toBe('reset');
    expect(
      resetGrantMessage(h.operations.inspect('account'), h.operations.inspectSync('account'))
    ).toBe(message);
    expect(h.claimCount()).toBe(1);
    h.respond(synced);
    // Even an accidental call to the spending entry point must retry only reconciliation.
    expect(await h.operations.run('account', 'index', 'different-grant')).toEqual({
      code: 'reset',
      unresolved: false,
      syncPending: false,
    });
    expect(h.claimCount()).toBe(1);
    expect(h.syncCount()).toBe(2);
    expect(
      resetGrantMessage(h.operations.inspect('account'), h.operations.inspectSync('account'))
    ).toBe('reset_synced');
  }
);

test('already_used is not proof of a new redemption or routing recovery', async () => {
  const h = fixture();
  h.alreadyUsed();
  h.respond({ ...synced, outcome: 'blocked', remaining_quota_blocks: 1 });
  expect(await h.operations.run('account', 'index', 'grant')).toEqual({
    code: 'already_used',
    unresolved: false,
    syncPending: true,
  });
  expect(
    resetGrantMessage(h.operations.inspect('account'), h.operations.inspectSync('account'))
  ).toBe('already_used_pending');
  h.respond(synced);
  await h.operations.reconcile('account', 'index');
  expect(
    resetGrantMessage(h.operations.inspect('account'), h.operations.inspectSync('account'))
  ).toBe('already_used_synced');
  expect(h.claimCount()).toBe(1);
});

test('a reconciliation timeout preserves redemption and retries only the non-spending request', async () => {
  const h = fixture();
  const delayed = Promise.withResolvers<Response>();
  h.syncResponse(() => delayed.promise);
  h.timeout(100);
  expect(await h.operations.run('account', 'index', 'grant')).toEqual({
    code: 'reset',
    unresolved: false,
    syncPending: true,
  });
  delayed.resolve(Response.json(synced));
  h.respond(synced);
  h.timeout(10000);
  expect(await h.operations.reconcile('account', 'index')).toMatchObject({ pending: false });
  expect(h.claimCount()).toBe(1);
  expect(h.syncCount()).toBe(2);
});

test('sync-only recovery after reload or an external reset needs no available grant', async () => {
  const h = fixture();
  h.noGrants();
  expect(await h.operations.reconcile('account', 'index')).toMatchObject({ pending: false });
  expect(h.claimCount()).toBe(0);
  expect(h.calls.map((call) => call.path)).toEqual(['/v8/management/routing/quota/reconcile']);
  expect(resetGrantMessage(undefined, h.operations.inspectSync('account'))).toBe('sync_synced');
});

test('sync responses from an old connection cannot update a replacement session', async () => {
  const h = fixture();
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  h.syncResponse(() => {
    entered.resolve();
    return answer.promise;
  });
  const pending = h.operations.reconcile('account', 'index');
  await entered.promise;
  h.switchConnection();
  expect(h.operations.inspectSync('account')).toBeUndefined();
  answer.resolve(Response.json(synced));
  await expect(pending).rejects.toThrow('session');
  expect(h.operations.inspectSync('account')).toBeUndefined();
  expect(h.claimCount()).toBe(0);
});

test('malformed success and partial responses never prove synchronization', async () => {
  const h = fixture();
  for (const [body, statusCode] of [
    [{ ...synced, auth_index: 'replacement' }, 200],
    [{ ...synced, observed_at: 'bad' }, 200],
    [{ ...synced, remaining_quota_blocks: -1 }, 200],
    [{ ...synced, persistence: 'failed' }, 200],
    [{ ...synced, status: 'partial', persistence: 'failed', runtime_applied: true }, 200],
    [synced, 503],
    [{ ...synced, status: 'partial', persistence: 'failed', runtime_applied: false }, 503],
    [{ error: 'unavailable' }, 503],
  ] as const) {
    h.respond(body, statusCode);
    await expect(reconcileClaudeQuota('index')).rejects.toThrow();
  }
  expect(h.claimCount()).toBe(0);
});
