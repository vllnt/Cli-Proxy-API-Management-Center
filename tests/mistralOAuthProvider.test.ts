import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import {
  AUTH_FILE_ICONS,
  getAuthFileIcon,
  OAUTH_PROVIDER_PRESETS,
  QUOTA_PROVIDER_TYPES,
  supportsAuthFileManualRefresh,
  supportsAuthFileWebsockets,
} from '@/features/authFiles/constants';
import { providerLabel } from '@/features/dashboard/utils';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import { OAuthPage } from '@/pages/OAuthPage';
import { apiClient } from '@/services/api/client';
import { oauthApi, type BuiltInOAuthProvider } from '@/services/api/oauth';
import { classifyModels } from '@/utils/models';
import {
  isManagementOAuthProviderKey,
  normalizeManagementOAuthProviderKey,
  normalizeOAuthProviderKey,
} from '@/utils/providerKeys';
import { TYPE_COLORS } from '@/utils/quota';
import en from '@/i18n/locales/en.json';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru'] as const;

const readLocale = (locale: string) =>
  JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));

describe('Mistral device OAuth API contract', () => {
  test('is a valid management OAuth provider key', () => {
    expect(isManagementOAuthProviderKey('mistral')).toBe(true);
    expect(normalizeManagementOAuthProviderKey(' Mistral ')).toBe('mistral');
    expect(normalizeOAuthProviderKey(' Mistral ')).toBe('mistral');
  });

  test('starts the server-polled flow without is_webui and keeps a user_code-less response', async () => {
    const provider: BuiltInOAuthProvider = 'mistral';
    const response = {
      status: 'ok',
      url: 'https://console.mistral.ai/fixture/sign-in',
      state: 'mistral-1',
      flow: 'device',
      expires_in: 600,
    };
    const signal = new AbortController().signal;
    const get = spyOn(apiClient, 'get').mockResolvedValue(response);
    try {
      expect(await oauthApi.startAuth(provider, signal)).toEqual(response);
      expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
        params: { provider: 'mistral' },
        signal,
      });
      await oauthApi.startAuth('Mistral');
      expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', { params: { provider: 'mistral' } });
      for (const call of get.mock.calls) {
        expect((call[1] as { params: Record<string, unknown> }).params).not.toHaveProperty(
          'is_webui'
        );
      }
    } finally {
      get.mockRestore();
    }
  });

  test('polls and cancels through the shared session endpoints', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue({ status: 'wait' });
    const del = spyOn(apiClient, 'delete').mockResolvedValue({ status: 'ok', cancelled: true });
    try {
      await oauthApi.getAuthStatus('mistral-1');
      expect(get).toHaveBeenLastCalledWith('/oauth/status', { params: { state: 'mistral-1' } });
      await oauthApi.cancelSession('mistral-1');
      expect(del).toHaveBeenLastCalledWith('/oauth/session', { params: { state: 'mistral-1' } });
    } finally {
      get.mockRestore();
      del.mockRestore();
    }
  });
});

describe('Mistral login card', () => {
  const renderPage = () => {
    const i18n = createInstance();
    return i18n
      .init({ lng: 'en', resources: { en: { translation: en } } })
      .then(() =>
        renderToStaticMarkup(
          createElement(
            I18nextProvider,
            { i18n },
            createElement(MemoryRouter, null, createElement(OAuthPage))
          )
        )
      );
  };

  test('appears in the provider card list with its hint and no raw i18n keys', async () => {
    const markup = await renderPage();
    expect(markup).toContain('Mistral OAuth');
    expect(markup).toContain('Log in with Mistral');
    expect(markup).toContain('admin.mistral.ai');
    expect(markup).not.toContain('auth_login.mistral_');
    // No link has been issued yet, so neither a device code nor a callback form is shown.
    expect(markup).not.toContain('Device code:');
  });

  test('is not callback-supported and cancels through the shared handler', () => {
    const source = readFileSync('src/pages/OAuthPage.tsx', 'utf8');
    expect(source).toContain("id: 'mistral'");
    const callbackProviders = source.match(
      /const CALLBACK_SUPPORTED = new Set<string>\(([^;]+)\);/
    );
    expect(callbackProviders?.[1]).not.toContain("'mistral'");
    const cancellable = source.match(/const CANCELLABLE_PROVIDERS = new Set<string>\(([^;]+)\);/);
    expect(cancellable?.[1]).toContain("'mistral'");
    expect(cancellable?.[1]).toContain("'devin'");
    // Cancel texts resolve per provider instead of being hard-coded to Devin.
    expect(source).not.toMatch(/t\('auth_login\.devin_oauth_cancel/);
    expect(source).not.toContain("t('auth_login.devin_oauth_retry_hint')");
  });
});

describe('Mistral credential presentation', () => {
  test('is an OAuth preset with an icon, label and badge colours but no quota or websockets', () => {
    expect(OAUTH_PROVIDER_PRESETS).toContain('mistral');
    expect(AUTH_FILE_ICONS.mistral).toBeTruthy();
    expect(getAuthFileIcon('mistral', 'dark')).toBe(PROVIDER_LOGOS.mistral.src);
    expect(getAuthFileIcon('Mistral', 'light')).toBe(PROVIDER_LOGOS.mistral.src);
    expect(providerLabel('mistral', 'Unknown')).toBe('Mistral');
    expect(TYPE_COLORS.mistral?.light.bg).toBeTruthy();
    expect(TYPE_COLORS.mistral?.dark?.bg).toBeTruthy();
    expect([...QUOTA_PROVIDER_TYPES]).not.toContain('mistral');
    expect(supportsAuthFileManualRefresh('mistral')).toBe(false);
    expect(supportsAuthFileWebsockets('mistral')).toBe(false);
  });

  test('ships a bundled SVG icon', () => {
    const svg = readFileSync('src/assets/icons/mistral.svg', 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('<title>Mistral</title>');
  });

  test('groups Mistral model families without changing Devin or GPT precedence', () => {
    const groups = classifyModels([
      { name: 'mistral-large-latest' },
      { name: 'codestral-latest' },
      { name: 'open-mixtral-8x7b' },
      { name: 'devstral-small-latest' },
      { name: 'devin/mistral-large-latest' },
      { name: 'gpt-5' },
    ]);
    expect(groups.find((group) => group.id === 'mistral')?.items).toHaveLength(4);
    expect(groups.find((group) => group.id === 'devin')?.items).toHaveLength(1);
    expect(groups.find((group) => group.id === 'gpt')?.items).toHaveLength(1);
  });
});

describe('Mistral translations', () => {
  test('provide every card, cancel and filter string in all four locales', () => {
    const suffixes = Object.keys(en.auth_login)
      .filter((key) => key.startsWith('mistral_'))
      .map((key) => key.slice('mistral_'.length));
    // title, button, hint, url label, open/copy link, 5 statuses/errors, 4 cancel strings.
    expect(suffixes.length).toBeGreaterThanOrEqual(15);
    for (const suffix of [
      'oauth_title',
      'oauth_button',
      'oauth_hint',
      'oauth_url_label',
      'open_link',
      'copy_link',
      'oauth_status_waiting',
      'oauth_status_success',
      'oauth_status_error',
      'oauth_start_error',
      'oauth_polling_error',
      'oauth_cancel',
      'oauth_cancelled',
      'oauth_cancel_error',
      'oauth_retry_hint',
    ]) {
      expect(suffixes).toContain(suffix);
    }
    for (const locale of LOCALES) {
      const translations = readLocale(locale);
      for (const suffix of suffixes) {
        expect(translations.auth_login[`mistral_${suffix}`]?.trim()).toBeTruthy();
      }
      expect(translations.auth_login.mistral_oauth_hint).toContain('admin.mistral.ai');
      expect(translations.auth_files.filter_mistral).toBe('Mistral');
    }
  });
});
