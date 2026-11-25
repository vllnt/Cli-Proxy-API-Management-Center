import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

export interface ClaudeQuotaReconciliation {
  outcome: 'reconciled' | 'unchanged' | 'blocked';
  observedAt: string;
  persistence: 'ok' | 'failed';
  remainingQuotaBlocks: number;
}

function parseResult(
  value: unknown,
  authIndex: string,
  partial: boolean
): ClaudeQuotaReconciliation {
  if (
    !isRecord(value) ||
    value.auth_index !== authIndex ||
    (value.outcome !== 'reconciled' &&
      value.outcome !== 'unchanged' &&
      value.outcome !== 'blocked') ||
    typeof value.observed_at !== 'string' ||
    Number.isNaN(Date.parse(value.observed_at)) ||
    !Array.isArray(value.models) ||
    !value.models.every((model) => typeof model === 'string') ||
    !Number.isInteger(value.remaining_quota_blocks) ||
    Number(value.remaining_quota_blocks) < 0 ||
    !(
      (!partial && value.status === 'ok' && value.persistence === 'ok') ||
      (partial &&
        value.status === 'partial' &&
        value.runtime_applied === true &&
        value.persistence === 'failed')
    )
  ) {
    throw new Error('Invalid quota reconciliation response');
  }
  return {
    outcome: value.outcome,
    observedAt: value.observed_at,
    persistence: value.persistence === 'failed' ? 'failed' : 'ok',
    remainingQuotaBlocks: Number(value.remaining_quota_blocks),
  };
}

/** A fixed, non-spending management operation; provider evidence stays on the backend. */
export async function reconcileClaudeQuota(authIndex: string): Promise<ClaudeQuotaReconciliation> {
  let response: unknown;
  let partial = false;
  try {
    response = await apiClient.post('/routing/quota/reconcile', { auth_index: authIndex });
  } catch (error) {
    if (!isRecord(error) || error.status !== 503) throw error;
    response = error.data;
    partial = true;
  }
  return parseResult(response, authIndex, partial);
}
