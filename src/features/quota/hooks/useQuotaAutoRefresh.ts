import { useEffect, useMemo, useRef, useState } from 'react';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_AUTO_REFRESH_INTERVAL_MS } from '../constants';

export interface LoadQuotaOptions {
  /** Keep already rendered quota content visible during a background refresh. */
  preserveExisting?: boolean;
}

export type LoadQuota = (targets: QuotaFileEntry[], options?: LoadQuotaOptions) => Promise<void>;

export interface QuotaAutoRefreshSchedulerOptions {
  intervalMs?: number;
  isHidden?: () => boolean;
  now?: () => number;
  onNextRefreshAt?: (timestamp: number) => void;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (id: unknown) => void;
  subscribeVisibility?: (listener: () => void) => () => void;
}

const defaultIsHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const defaultSetInterval = (callback: () => void, delay: number) =>
  window.setInterval(callback, delay);

const defaultClearInterval = (id: unknown) => window.clearInterval(id as number);

const defaultSubscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

/** Build a stable identity for the current visible cards, independent of sort order. */
export const getQuotaAutoRefreshSignature = (targets: QuotaFileEntry[]): string =>
  JSON.stringify(targets.map(({ type, file }) => `${type}:${getQuotaCacheKey(file)}`).sort());

export const getQuotaRefreshSecondsRemaining = (
  nextRefreshAt: number | null,
  now: number
): number | null =>
  nextRefreshAt === null ? null : Math.max(0, Math.ceil((nextRefreshAt - now) / 1000));

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
    now = Date.now,
    onNextRefreshAt,
    setInterval: schedule = defaultSetInterval,
    clearInterval: clear = defaultClearInterval,
    subscribeVisibility = defaultSubscribeVisibility,
  } = options;
  let active = true;

  const run = () => {
    if (!active || isHidden()) return;
    onNextRefreshAt?.(now() + intervalMs);
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
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());

  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  useEffect(() => {
    loadQuotaRef.current = loadQuota;
  }, [loadQuota]);

  useEffect(() => {
    if (disabled || !targetSignature) {
      setNextRefreshAt(null);
      return;
    }

    const countdownTimer = window.setInterval(() => {
      setCountdownNow(Date.now());
    }, 1000);
    const dispose = createQuotaAutoRefreshScheduler(
      () => {
        void loadQuotaRef.current(targetsRef.current, { preserveExisting: true });
      },
      { onNextRefreshAt: setNextRefreshAt }
    );

    return () => {
      window.clearInterval(countdownTimer);
      dispose();
    };
  }, [disabled, targetSignature]);

  return {
    secondsUntilRefresh: disabled
      ? null
      : getQuotaRefreshSecondsRemaining(nextRefreshAt, countdownNow),
  };
}
