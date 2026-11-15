import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { useAuthStore } from '@/stores';
import { DEFAULT_VISUAL_VALUES, type ApiKeyBudgetsDraft } from '@/types/visualConfig';
import { saveApiKeyName } from '@/features/config/apiKeyNames';
import { ApiKeyBudgetsEditor } from '@/features/config/components/blocks/ApiKeyBudgetsEditor';
import { SectionConnectivity } from '@/features/config/components/sections/SectionConnectivity';
import { maskApiKey } from '@/utils/format';

const KEY_A = 'sk-fixture-abcdef0123456789';
const KEY_B = 'sk-fixture-zyxwvu9876543210';
const translations = i18n.cloneInstance({ lng: 'en' });
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: translations }, element));
const escapeText = (value: string) =>
  renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);

const budgets: ApiKeyBudgetsDraft = {
  enabled: true,
  mode: 'observe',
  timezone: 'UTC',
  weights: { input: '', output: '', cacheWrite: '', cacheRead: '0.1' },
  entries: [
    {
      id: 'budget:agents',
      label: 'agents',
      key: KEY_B,
      saved: true,
      rules: [
        {
          id: 'budget:agents#0',
          models: 'claude-fable-*',
          window: 'week',
          limit: '1000',
          mode: '',
        },
      ],
    },
  ],
  labels: { agents: KEY_B },
  allowlistLabels: ['agents'],
};
const values = {
  ...DEFAULT_VISUAL_VALUES,
  apiKeysText: `${KEY_A}\n${KEY_B}`,
  apiKeyBudgets: budgets,
};
const props = { values, disabled: false, onChange: () => {} };

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  // Server rendering reads the store's initial snapshot, so names are saved under that base.
  saveApiKeyName(useAuthStore.getInitialState().apiBase, KEY_B, 'Build agents');
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('API key budgets editor markup', () => {
  test('never renders a full API key value, only masked keys and local names', () => {
    const markup = render(createElement(SectionConnectivity, props));
    expect(markup).toContain('cfg-field-apiKeyBudgets');
    // The key card is existing UI; check the budgets block on its own as well.
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: budgets,
        apiKeysText: values.apiKeysText,
        onChange: () => {},
      })
    );
    for (const key of [KEY_A, KEY_B]) {
      expect(block).not.toContain(key);
      expect(block).not.toContain(escapeText(key));
    }
    expect(block).toContain(escapeText(`Build agents · ${maskApiKey(KEY_B)}`));
  });

  test('keeps full keys out of the DOM even for a stale key and an invalid pick', () => {
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: {
          ...budgets,
          entries: [{ ...budgets.entries[0], key: KEY_A, saved: false, label: 'new' }],
          labels: {},
        },
        // KEY_A is no longer listed, so the validator reports it by its masked form.
        apiKeysText: KEY_B,
        onChange: () => {},
      })
    );
    expect(block).not.toContain(KEY_A);
    expect(block).toContain(escapeText(maskApiKey(KEY_A)));
  });

  test('tells keys that mask alike apart by their list position', () => {
    const twin = 'sk-fixture-qrstuv1111111189';
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: { ...budgets, entries: [{ ...budgets.entries[0], key: twin, saved: false }] },
        apiKeysText: `${KEY_A}\n${twin}`,
        onChange: () => {},
      })
    );
    expect(maskApiKey(KEY_A)).toBe(maskApiKey(twin));
    // The selected option is the second key, so its label carries its position.
    expect(block).toContain(escapeText(`${maskApiKey(twin)} #2`));
    expect(block).not.toContain(twin);
    expect(block).not.toContain(KEY_A);
  });

  test('gives every input, select and button an accessible name', () => {
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: budgets,
        apiKeysText: values.apiKeysText,
        onChange: () => {},
      })
    );
    for (const input of block.match(/<input\b[^>]*>/g) ?? []) {
      const id = input.match(/\bid="([^"]+)"/)?.[1];
      // Text inputs are named by a <label for>; the toggle checkbox carries an aria-label.
      expect(Boolean(id && block.includes(`for="${id}"`)) || /aria-label="[^"]+"/.test(input)).toBe(
        true
      );
    }
    for (const select of block.match(/<button\b[^>]*aria-haspopup="listbox"[^>]*>/g) ?? []) {
      const id = select.match(/\bid="([^"]+)"/)?.[1];
      expect(block).toContain(`for="${id}"`);
    }
    const buttons = block.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) {
      // Visible text: some non-space character between two tags.
      const hasText = />[^<]*\S[^<]*</.test(button);
      expect(/aria-label="[^"]+"/.test(button) || hasText || /aria-labelledby/.test(button)).toBe(
        true
      );
    }
    for (const name of [
      translations.t('config_management.visual.budgets.entry_remove_aria', { label: 'agents' }),
      translations.t('config_management.visual.budgets.rule_remove_aria', {
        index: 1,
        label: 'agents',
      }),
      translations.t('config_management.visual.budgets.rule_add_aria', { label: 'agents' }),
    ]) {
      expect(block).toContain(`aria-label="${escapeText(name)}"`);
    }
  });

  test('shows the static behaviour hint and hides the form while budgets are off', () => {
    const off = render(
      createElement(ApiKeyBudgetsEditor, {
        value: { ...budgets, enabled: false },
        apiKeysText: values.apiKeysText,
        onChange: () => {},
      })
    );
    expect(off).toContain(
      escapeText(translations.t('config_management.visual.budgets.behavior_hint'))
    );
    expect(off).not.toContain(
      escapeText(translations.t('config_management.visual.budgets.timezone'))
    );
    expect(off).not.toContain(
      escapeText(translations.t('config_management.visual.budgets.entry_add'))
    );
  });

  test('disables every control in read-only mode', () => {
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: budgets,
        apiKeysText: values.apiKeysText,
        disabled: true,
        onChange: () => {},
      })
    );
    const controls = block.match(/<(?:input|textarea|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) expect(control).toContain('disabled=""');
  });

  test('renders the validator message next to the offending field', () => {
    const block = render(
      createElement(ApiKeyBudgetsEditor, {
        value: {
          ...budgets,
          entries: [
            {
              ...budgets.entries[0],
              rules: [{ ...budgets.entries[0].rules[0], limit: '0', models: '' }],
            },
          ],
        },
        apiKeysText: values.apiKeysText,
        onChange: () => {},
      })
    );
    for (const code of ['limit_invalid', 'models_required']) {
      expect(block).toContain(
        escapeText(translations.t(`config_management.visual.budgets.issues.${code}`))
      );
    }
    expect((block.match(/aria-invalid="true"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('API keys card', () => {
  const message = 'A removed API key still has a label';

  test('explains why dropping a labelled key cannot be saved yet', () => {
    const markup = render(
      createElement(SectionConnectivity, { ...props, values: { ...values, apiKeysText: KEY_A } })
    );
    expect(markup).toContain(message);
    expect(markup).not.toContain(KEY_B);
  });

  test('stays quiet while every labelled key is listed', () => {
    expect(render(createElement(SectionConnectivity, props))).not.toContain(message);
  });
});
