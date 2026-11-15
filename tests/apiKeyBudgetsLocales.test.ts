import { describe, expect, test } from 'bun:test';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru'] as const;
const ISSUE_CODES = [
  'mode_invalid',
  'timezone_invalid',
  'weight_invalid',
  'label_required',
  'label_invalid',
  'label_duplicate',
  'label_key_mismatch',
  'key_required',
  'key_not_listed',
  'key_duplicate',
  'key_has_other_label',
  'models_required',
  'window_invalid',
  'limit_invalid',
  'rule_mode_invalid',
  'rule_duplicate',
];

type Tree = { [key: string]: string | Tree };

async function load(locale: string) {
  const json = (await Bun.file(`src/i18n/locales/${locale}.json`).json()) as Tree;
  const visual = (json.config_management as Tree).visual as Tree;
  return { budgets: visual.budgets as Tree, validation: visual.validation as Tree };
}

const leaves = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value === 'string') acc[prefix + key] = value;
    else Object.assign(acc, leaves(value, `${prefix}${key}.`));
    return acc;
  }, {});
const params = (text: string) => (text.match(/{{\s*\w+\s*}}/g) ?? []).sort();

describe('API key budgets locales', () => {
  test('every locale defines the same non-empty keys with the same interpolation params', async () => {
    const reference = leaves((await load('en')).budgets);
    expect(Object.keys(reference).length).toBeGreaterThan(40);
    for (const locale of LOCALES) {
      const own = leaves((await load(locale)).budgets);
      expect(Object.keys(own).sort()).toEqual(Object.keys(reference).sort());
      for (const [key, value] of Object.entries(own)) {
        expect(value.trim().length).toBeGreaterThan(0);
        expect(params(value)).toEqual(params(reference[key]));
      }
    }
  });

  test('every validator issue code has a message and the block error is translated', async () => {
    for (const locale of LOCALES) {
      const { budgets, validation } = await load(locale);
      const issues = budgets.issues as Tree;
      expect(Object.keys(issues).sort()).toEqual([...ISSUE_CODES].sort());
      expect(typeof validation.invalid_api_key_budgets).toBe('string');
      expect(String(validation.invalid_api_key_budgets).length).toBeGreaterThan(0);
    }
  });

  test('the masked key parameter is the only way a key reaches a message', async () => {
    for (const locale of LOCALES) {
      const issues = (await load(locale)).budgets.issues as Tree;
      expect(params(String(issues.key_not_listed))).toEqual(['{{key}}']);
    }
  });
});
