import { useEffect, useMemo, useRef } from 'react';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_AUTO_REFRESH_INTERVAL_MS } from '../constants';

export type LoadQuota = (targets: QuotaFileEntry[]) => Promise<void>;

export interface QuotaAutoRefreshSchedulerOptions {
  intervalMs?: number;
  isHidden?: () => boolean;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (id: unknown) => void;
  subscribeVisibility?: (listener: () => void) => () => void;
}

const defaultIsHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const defaultSetInterval = (callback: () => void, delay: number) =>
  window.setInterval(callback, delay);

const defaultClearInterval = (id: unknown) =>
  window.clearInterval(id as number);

const defaultSubscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

/** Build a stable identity for the current visible cards, independent of sort order. */
export const getQuotaAutoRefreshSignature = (targets: QuotaFileEntry[]): string =>
  JSON.stringify(
    targets
      .map(({ type, file }) => `${type}:${getQuotaCacheKey(file)}`)
      .sort()
  );

/**
 * Run one refresh immediately, then on a single interval while the page is visible.
 * The returned disposer is safe to call more than once and makes late timer events inert.
 */
export function createQuotaAutoRefreshScheduler(
  refresh: () => void,
  options: QuotaAutoRefreshSchedulerOptions = {}
): () => void {
  const {
    intervalMs = QUOTA_AUTO_REFRESH_INTERVAL_MS,
    isHidden = defaultIsHidden,
    setInterval: schedule = defaultSetInterval,
    clearInterval: clear = defaultClearInterval,
    subscribeVisibility = defaultSubscribeVisibility,
  } = options;
  let active = true;

  const run = () => {
    if (!active || isHidden()) return;
    refresh();
  };

  run();
  const timerId = schedule(run, intervalMs);
  const unsubscribeVisibility = subscribeVisibility(() => {
    if (!isHidden()) run();
  });

  return () => {
    if (!active) return;
    active = false;
    clear(timerId);
    unsubscribeVisibility();
  };
}

export function useQuotaAutoRefresh(
  targets: QuotaFileEntry[],
  disabled: boolean,
  loadQuota: LoadQuota
) {
  const targetsRef = useRef(targets);
  const loadQuotaRef = useRef(loadQuota);
  const targetSignature = useMemo(() => getQuotaAutoRefreshSignature(targets), [targets]);

  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  useEffect(() => {
    loadQuotaRef.current = loadQuota;
  }, [loadQuota]);

  useEffect(() => {
    if (disabled || !targetSignature) return;

    return createQuotaAutoRefreshScheduler(() => {
      void loadQuotaRef.current(targetsRef.current);
    });
  }, [disabled, targetSignature]);
}
