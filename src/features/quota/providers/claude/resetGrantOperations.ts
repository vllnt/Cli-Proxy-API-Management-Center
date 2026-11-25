import { apiClient } from '@/services/api/client';
import {
  reconcileClaudeQuota,
  type ClaudeQuotaReconciliation,
} from '@/services/api/claudeQuotaReconcile';
import {
  anthropicResetGrantBlocker,
  claimClaudeResetGrant,
  readClaudeOrganization,
  readClaudeResetGrants,
  type AnthropicResetSettledCode,
} from '@/services/api/claudeResetGrants';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;
type Operation = {
  grantId: string;
  organization: string;
  requestId: string;
  createdAt: number;
  code?: AnthropicResetSettledCode;
};
interface Reconciliation {
  pending: boolean;
  result?: ClaudeQuotaReconciliation;
}

/** Redemption and routing recovery are separate claims, including already-used answers. */
export function resetGrantMessage(operation?: Operation, sync?: Reconciliation): string {
  if (operation && !operation.code) return 'unknown';
  const prefix =
    operation?.code === 'reset'
      ? 'reset'
      : operation?.code === 'already_used'
        ? 'already_used'
        : 'sync';
  if (sync) {
    return `${prefix}_${sync.result?.persistence === 'failed' ? 'persistence' : sync.pending ? 'pending' : 'synced'}`;
  }
  return operation?.code ?? '';
}
const defaultDependencies = {
  revision: () => apiClient.getConnectionRevision(),
  readStatus: readClaudeResetGrants,
  readOrganization: readClaudeOrganization,
  claim: claimClaudeResetGrant,
  reconcile: reconcileClaudeQuota,
  now: () => Date.now(),
  requestId: () => crypto.randomUUID() as string,
};

/** Tab-memory journal: survives dialog/card unmounts, never crosses connections.
 * No automatic retry. Expired ambiguous operations stay blocked until session end.
 * This is not a cross-tab or durable backend spending ledger.
 */
export function createResetGrantOperations(deps = defaultDependencies) {
  let revision = deps.revision();
  const operations = new Map<string, Operation>();
  const reconciliations = new Map<string, Reconciliation>();
  const busy = new Set<string>();
  const syncSession = () => {
    if (revision !== deps.revision()) {
      revision = deps.revision();
      operations.clear();
      reconciliations.clear();
      busy.clear();
    }
    return revision;
  };
  const reconcile = async (key: string, authIndex: string, session: number) => {
    const state: Reconciliation = { pending: true };
    reconciliations.set(key, state);
    try {
      const result = await deps.reconcile(authIndex);
      if (deps.revision() !== session) throw new Error('session');
      state.result = result;
      state.pending =
        result.persistence !== 'ok' ||
        result.outcome === 'blocked' ||
        result.remainingQuotaBlocks > 0;
    } catch {
      /** A failed read never undoes known redemption or permits another spending retry. */
      if (deps.revision() !== session) throw new Error('session');
    }
    return state;
  };
  return {
    inspect(key: string) {
      syncSession();
      return operations.get(key);
    },
    inspectSync(key: string) {
      syncSession();
      return reconciliations.get(key);
    },
    async reconcile(key: string, authIndex: string) {
      const session = syncSession();
      if (busy.has(key)) throw new Error('busy');
      busy.add(key);
      try {
        return await reconcile(key, authIndex, session);
      } finally {
        if (deps.revision() === session) busy.delete(key);
      }
    },
    async run(key: string, authIndex: string, grantId: string) {
      const session = syncSession();
      const assertSession = () => {
        if (deps.revision() !== session) throw new Error('session');
      };
      if (busy.has(key)) throw new Error('busy');
      busy.add(key);
      try {
        let operation = operations.get(key);
        if (
          (operation?.code === 'reset' || operation?.code === 'already_used') &&
          reconciliations.get(key)?.pending
        ) {
          const sync = await reconcile(key, authIndex, session);
          return { code: operation.code, unresolved: false, syncPending: sync.pending };
        }
        if (operation?.code) operation = undefined;
        if (
          operation &&
          (operation.grantId !== grantId || deps.now() - operation.createdAt >= RETRY_WINDOW_MS)
        )
          throw new Error('expired');
        const wasRetry = Boolean(operation);
        const organization = await deps.readOrganization(authIndex);
        assertSession();
        if (operation && operation.organization !== organization) throw new Error('identity');
        if (!operation) {
          const status = await deps.readStatus(authIndex);
          assertSession();
          const grant = status.grants.find((item) => item.id === grantId);
          const now = deps.now();
          if (
            anthropicResetGrantBlocker(status, grantId) ||
            !grant ||
            (grant.startsAt && Date.parse(grant.startsAt) > now) ||
            (grant.endsAt && Date.parse(grant.endsAt) <= now) ||
            (status.cooldownUntil && Date.parse(status.cooldownUntil) > now)
          ) {
            throw new Error('blocked');
          }
          operation = { grantId, organization, requestId: deps.requestId(), createdAt: now };
          operations.set(key, operation);
          reconciliations.delete(key);
        }
        // Re-check immediately before dispatch; never send against a replacement connection.
        assertSession();
        if (wasRetry && deps.now() - operation.createdAt >= RETRY_WINDOW_MS) {
          throw new Error('expired');
        }
        const code = await deps.claim(authIndex, organization, grantId, operation.requestId);
        assertSession();
        // A refusal on a retry cannot prove that the earlier ambiguous POST did not spend.
        if (!wasRetry || code === 'reset' || code === 'already_used') operation.code = code;
        if (operation.code === 'reset' || operation.code === 'already_used') {
          const sync = await reconcile(key, authIndex, session);
          return { code, unresolved: false, syncPending: sync.pending };
        }
        return { code, unresolved: !operation.code };
      } finally {
        if (deps.revision() === session) busy.delete(key);
      }
    },
  };
}

export const resetGrantOperations = createResetGrantOperations();
