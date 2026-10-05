import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createQuotaAutoRefreshScheduler,
  getQuotaAutoRefreshSignature,
  getQuotaRefreshSecondsRemaining,
} from '@/features/quota/hooks/useQuotaAutoRefresh';
import { QUOTA_AUTO_REFRESH_INTERVAL_MS } from '@/features/quota/constants';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { AuthFileItem } from '@/types';

const entry = (name: string, authIndex: string): QuotaFileEntry => ({
  type: 'codex',
  file: { name, provider: 'codex', authIndex } as AuthFileItem,
});

describe('quota auto-refresh scheduler', () => {
  test('refreshes immediately, then on the configured interval while visible', () => {
    let hidden = false;
    let timer: (() => void) | null = null;
    let visibilityListener: (() => void) | null = null;
    let cleared = false;
    let nextRefreshAt: number | null = null;
    let calls = 0;

    const dispose = createQuotaAutoRefreshScheduler(
      () => {
        calls += 1;
      },
      {
        isHidden: () => hidden,
        now: () => 1_000,
        onNextRefreshAt: (timestamp) => {
          nextRefreshAt = timestamp;
        },
        setInterval: (callback, delay) => {
          expect(delay).toBe(QUOTA_AUTO_REFRESH_INTERVAL_MS);
          timer = callback;
          return 'quota-timer';
        },
        clearInterval: (id) => {
          expect(id).toBe('quota-timer');
          cleared = true;
        },
        subscribeVisibility: (listener) => {
          visibilityListener = listener;
          return () => {
            visibilityListener = null;
          };
        },
      }
    );

    expect(calls).toBe(1);
    expect(nextRefreshAt).toBe(1_000 + QUOTA_AUTO_REFRESH_INTERVAL_MS);
    timer?.();
    expect(calls).toBe(2);
    expect(nextRefreshAt).toBe(1_000 + QUOTA_AUTO_REFRESH_INTERVAL_MS);

    hidden = true;
    timer?.();
    expect(calls).toBe(2);

    hidden = false;
    visibilityListener?.();
    expect(calls).toBe(3);

    dispose();
    expect(cleared).toBe(true);
    timer?.();
    visibilityListener?.();
    expect(calls).toBe(3);
  });

  test('keeps the same target signature when sorting changes', () => {
    const first = [entry('a.json', '1'), entry('b.json', '2')];
    const reordered = [first[1], first[0]];
    const changedIdentity = [entry('c.json', '3'), entry('b.json', '2')];

    expect(getQuotaAutoRefreshSignature(first)).toBe(getQuotaAutoRefreshSignature(reordered));
    expect(getQuotaAutoRefreshSignature(first)).not.toBe(
      getQuotaAutoRefreshSignature(changedIdentity)
    );
  });
});

describe('quota auto-refresh countdown', () => {
  test('rounds up remaining seconds and clamps expired deadlines', () => {
    expect(getQuotaRefreshSecondsRemaining(61_000, 1_000)).toBe(60);
    expect(getQuotaRefreshSecondsRemaining(61_000, 2_001)).toBe(59);
    expect(getQuotaRefreshSecondsRemaining(1_000, 2_000)).toBe(0);
    expect(getQuotaRefreshSecondsRemaining(null, 2_000)).toBeNull();
  });
});

describe('quota auto-refresh translations', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
    test(`${locale} explains the automatic cadence`, () => {
      const messages = JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')) as {
        quota_management?: { auto_refresh?: string; auto_refresh_next?: string };
      };
      expect(messages.quota_management?.auto_refresh).toBeTruthy();
      expect(messages.quota_management?.auto_refresh_next).toBeTruthy();
    });
  }
});
