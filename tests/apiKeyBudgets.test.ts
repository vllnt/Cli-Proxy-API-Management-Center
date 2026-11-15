import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import {
  areApiKeyBudgetsEqual,
  createBudgetEntry,
  hasApiKeyBudgetIssues,
  readApiKeyBudgets,
  validateApiKeyBudgets,
  writeApiKeyBudgets,
} from '@/features/config/apiKeyBudgets';
import { ConfigDraftConflictError } from '@/services/api/configPatch';
import type { ApiKeyBudgetsDraft } from '@/types/visualConfig';

const OPTIONS = { indent: 2, lineWidth: 120, minContentWidth: 0 } as const;
// The yaml library's own output form, so equality below is byte identity.
const canonical = (yaml: string) => parseDocument(yaml).toString(OPTIONS);

const RAW = `# gateway config
server:
  port: 8317 # keep
access:
  # client keys
  api-keys:
    - key-agents-0001
    - key-monitor-0002
    - key-spare-00003
  api-key-labels:
    agents: key-agents-0001 # agents label
    monitor: key-monitor-0002
  api-key-auth-allowlist:
    monitor:
      auth-ids: [claude-0123abcd.json]
  api-key-budgets:
    mode: observe # global mode
    timezone: UTC
    weights: { input: 1, output: 1, cache-write: 1, cache-read: 0.1 }
    labels:
      agents:
        # weekly Fable cap
        - { models: claude-fable-*, window: week, limit: 2000000 }
        - { models: "*", window: day, limit: 20000000, mode: enforce }
      monitor:
        - { models: "*", window: day, limit: 1000 }
future-key: { a: 1 }
`;
const YAML = canonical(RAW);
const KEYS = ['key-agents-0001', 'key-monitor-0002', 'key-spare-00003'];

const load = (yaml: string) => readApiKeyBudgets(parseDocument(yaml));

function edit(yaml: string, mutate: (draft: ApiKeyBudgetsDraft) => void, serverYaml = yaml) {
  const doc = parseDocument(yaml);
  const baseline = readApiKeyBudgets(parseDocument(serverYaml));
  const desired = structuredClone(baseline);
  mutate(desired);
  writeApiKeyBudgets(doc, baseline, desired, serverYaml);
  return doc.toString(OPTIONS);
}

const lines = (yaml: string) => yaml.split('\n');
/** Lines present in only one side, so a test can assert the exact blast radius of an edit. */
function diff(before: string, after: string) {
  const a = lines(before);
  const b = lines(after);
  return {
    removed: a.filter((line) => !b.includes(line)),
    added: b.filter((line) => !a.includes(line)),
  };
}

describe('fixture', () => {
  test('is stable under the yaml library output form', () => {
    expect(canonical(YAML)).toBe(YAML);
  });
});

describe('readApiKeyBudgets', () => {
  test('parses the block, the label table and the allowlist labels', () => {
    const draft = load(YAML);
    expect(draft).toMatchObject({
      enabled: true,
      mode: 'observe',
      timezone: 'UTC',
      weights: { input: '1', output: '1', cacheWrite: '1', cacheRead: '0.1' },
      labels: { agents: 'key-agents-0001', monitor: 'key-monitor-0002' },
      allowlistLabels: ['monitor'],
    });
    expect(draft.entries.map((entry) => [entry.label, entry.key, entry.saved])).toEqual([
      ['agents', 'key-agents-0001', true],
      ['monitor', 'key-monitor-0002', true],
    ]);
    expect(
      draft.entries[0].rules.map(({ models, window, limit, mode }) => [models, window, limit, mode])
    ).toEqual([
      ['claude-fable-*', 'week', '2000000', ''],
      ['*', 'day', '20000000', 'enforce'],
    ]);
  });

  test('an absent block is off, with the default mode and no entries', () => {
    const draft = load('access:\n  api-keys: [a]\n');
    expect(draft).toMatchObject({ enabled: false, mode: 'observe', timezone: '', entries: [] });
  });

  test('a null block counts as absent', () => {
    expect(load('access:\n  api-key-budgets:\n').enabled).toBe(false);
  });

  test('keeps modes the backend would reject so validation can flag them', () => {
    const draft = load(
      'access:\n  api-key-budgets:\n    mode: Enforce\n    labels:\n      a: [{ models: x, window: day, limit: 1, mode: bogus }]\n'
    );
    expect(draft.mode).toBe('enforce');
    expect(draft.entries[0].rules[0].mode).toBe('bogus');
    expect(draft.entries[0].saved).toBe(false);
  });
});

describe('writeApiKeyBudgets', () => {
  test('writing an unchanged draft leaves every byte alone', () => {
    expect(edit(YAML, () => {})).toBe(YAML);
  });

  test('re-submitting identical rules does not rewrite the list', () => {
    expect(
      edit(YAML, (draft) => {
        draft.entries[0].rules = draft.entries[0].rules.map((rule) => ({ ...rule }));
      })
    ).toBe(YAML);
  });

  test('editing one limit changes one line and keeps comments and flow style', () => {
    const out = edit(YAML, (draft) => {
      draft.entries[0].rules[0].limit = '3000000';
    });
    expect(diff(YAML, out)).toEqual({
      removed: ['        - { models: claude-fable-*, window: week, limit: 2000000 }'],
      added: ['        - { models: claude-fable-*, window: week, limit: 3000000 }'],
    });
    expect(out).toContain('# weekly Fable cap');
  });

  test('clearing a rule override removes only its mode key', () => {
    const out = edit(YAML, (draft) => {
      draft.entries[0].rules[1].mode = '';
    });
    expect(diff(YAML, out).added).toEqual([
      '        - { models: "*", window: day, limit: 20000000 }',
    ]);
  });

  test('changing the global settings touches only those lines', () => {
    const out = edit(YAML, (draft) => {
      draft.mode = 'enforce';
      draft.timezone = 'Europe/Paris';
      draft.weights.cacheRead = '';
    });
    const { removed, added } = diff(YAML, out);
    expect(added).toEqual([
      '    mode: enforce # global mode',
      '    timezone: Europe/Paris',
      '    weights: { input: 1, output: 1, cache-write: 1 }',
    ]);
    expect(removed).toHaveLength(3);
    expect(out).toContain('# weekly Fable cap');
  });

  test('adding a budget saves the label and its rules, and nothing else moves', () => {
    const out = edit(YAML, (draft) => {
      draft.entries.push({
        id: 'new',
        label: 'batch',
        key: 'key-spare-00003',
        saved: false,
        rules: [
          { id: 'r', models: 'claude-fable-*', window: 'week', limit: '1000', mode: 'observe' },
        ],
      });
    });
    const parsed = parseDocument(out).toJS();
    expect(parsed.access['api-key-labels']).toEqual({
      agents: 'key-agents-0001',
      monitor: 'key-monitor-0002',
      batch: 'key-spare-00003',
    });
    expect(parsed.access['api-key-budgets'].labels.batch).toEqual([
      { models: 'claude-fable-*', window: 'week', limit: 1000, mode: 'observe' },
    ]);
    expect(diff(YAML, out).removed).toEqual([]);
    const reread = load(out);
    expect(reread.entries.map((entry) => entry.label)).toEqual(['agents', 'monitor', 'batch']);
    expect(reread.entries[2]).toMatchObject({ key: 'key-spare-00003', saved: true });
  });

  test('enabling budgets on a config without them creates the block and the label', () => {
    const base = canonical('access:\n  api-keys: [key-a, key-b] # keys\nfuture: 1\n');
    const out = edit(base, (draft) => {
      draft.enabled = true;
      draft.timezone = 'UTC';
      draft.weights.input = '2';
      draft.entries.push({
        id: 'n',
        label: 'agents',
        key: 'key-b',
        saved: false,
        rules: [{ id: 'r', models: '*', window: 'day', limit: '500', mode: '' }],
      });
    });
    expect(parseDocument(out).toJS()).toEqual({
      access: {
        'api-keys': ['key-a', 'key-b'],
        'api-key-labels': { agents: 'key-b' },
        'api-key-budgets': {
          mode: 'observe',
          timezone: 'UTC',
          weights: { input: 2 },
          labels: { agents: [{ models: '*', window: 'day', limit: 500 }] },
        },
      },
      future: 1,
    });
    expect(out).toContain('# keys');
    expect(out).toContain('models: "*"');
  });

  test('enabling with no entries writes just the global block', () => {
    const base = canonical('access:\n  api-keys: [key-a]\n');
    const out = edit(base, (draft) => {
      draft.enabled = true;
      draft.timezone = 'UTC';
    });
    expect(parseDocument(out).toJS().access).toEqual({
      'api-keys': ['key-a'],
      'api-key-budgets': { mode: 'observe', timezone: 'UTC' },
    });
  });

  test('turning budgets off deletes the block and keeps the labels the allowlist uses', () => {
    const out = edit(YAML, (draft) => {
      draft.enabled = false;
    });
    const parsed = parseDocument(out).toJS();
    expect(parsed.access['api-key-budgets']).toBeUndefined();
    // agents was only budgeted; monitor is referenced by the allowlist
    expect(parsed.access['api-key-labels']).toEqual({ monitor: 'key-monitor-0002' });
    expect(parsed.access['api-key-auth-allowlist']).toEqual({
      monitor: { 'auth-ids': ['claude-0123abcd.json'] },
    });
    expect(parsed['future-key']).toEqual({ a: 1 });
    expect(out).toContain('# keep');
    expect(out).toContain('# client keys');
  });

  test('turning budgets off drops an emptied label table', () => {
    const base = canonical(
      'access:\n  api-keys: [k]\n  api-key-labels:\n    a: k\n  api-key-budgets:\n    labels:\n      a: [{ models: "*", window: day, limit: 1 }]\n'
    );
    const out = edit(base, (draft) => {
      draft.enabled = false;
    });
    expect(parseDocument(out).toJS()).toEqual({ access: { 'api-keys': ['k'] } });
  });

  test('removing an entry keeps a label the allowlist references', () => {
    const out = edit(YAML, (draft) => {
      draft.entries = draft.entries.filter((entry) => entry.label !== 'monitor');
    });
    const parsed = parseDocument(out).toJS();
    expect(Object.keys(parsed.access['api-key-budgets'].labels)).toEqual(['agents']);
    expect(parsed.access['api-key-labels'].monitor).toBe('key-monitor-0002');
    expect(parsed.access['api-key-auth-allowlist'].monitor).toBeDefined();
  });

  test('removing an entry deletes its label when nothing else references it', () => {
    const out = edit(YAML, (draft) => {
      draft.entries = draft.entries.filter((entry) => entry.label !== 'agents');
    });
    const parsed = parseDocument(out).toJS();
    expect(parsed.access['api-key-labels']).toEqual({ monitor: 'key-monitor-0002' });
    expect(Object.keys(parsed.access['api-key-budgets'].labels)).toEqual(['monitor']);
  });

  test('removing the last entry drops the empty labels map', () => {
    const base = canonical(
      'access:\n  api-keys: [k]\n  api-key-labels:\n    a: k\n  api-key-budgets:\n    mode: observe\n    labels:\n      a: [{ models: "*", window: day, limit: 1 }]\n'
    );
    const out = edit(base, (draft) => {
      draft.entries = [];
    });
    expect(parseDocument(out).toJS()).toEqual({
      access: { 'api-keys': ['k'], 'api-key-budgets': { mode: 'observe' } },
    });
  });

  test('an existing label is reused, not duplicated, and labels without budgets are untouched', () => {
    const base = canonical(
      'access:\n  api-keys: [k1, k2]\n  api-key-labels:\n    spare: k1 # kept\n    other: k2\n  api-key-auth-allowlist:\n    spare: { tags: [pool] }\n'
    );
    const draft0 = load(base);
    expect(draft0.entries).toEqual([]);
    const out = edit(base, (draft) => {
      draft.enabled = true;
      draft.entries.push({
        id: 'n',
        label: 'spare',
        key: 'k1',
        saved: true,
        rules: [{ id: 'r', models: '*', window: 'month', limit: '9', mode: '' }],
      });
    });
    expect(out).toContain('spare: k1 # kept');
    expect(out.match(/spare: k1/g)).toHaveLength(1);
    expect(parseDocument(out).toJS().access['api-key-labels']).toEqual({
      spare: 'k1',
      other: 'k2',
    });
  });

  test('an unrelated edit to another label leaves a label with a different spelling alone', () => {
    const base = canonical(
      'access:\n  api-keys: [k]\n  api-key-labels:\n    "123": k\n  api-key-budgets:\n    labels:\n      "123": [{ models: "*", window: day, limit: 1 }]\n'
    );
    const out = edit(base, (draft) => {
      draft.entries[0].rules[0].limit = '2';
    });
    expect(parseDocument(out).toJS().access['api-key-budgets'].labels['123'][0].limit).toBe(2);
    expect(load(out).entries[0].label).toBe('123');
  });

  test('refuses to replace a rule list that changed on the server meanwhile', () => {
    const latest = YAML.replace('limit: 1000 }', 'limit: 5 }');
    expect(latest).not.toBe(YAML);
    expect(() =>
      edit(
        latest,
        (draft) => {
          draft.entries[1].rules[0].limit = '2000';
        },
        YAML
      )
    ).toThrow(ConfigDraftConflictError);
  });

  test('a concurrent change to a list this edit does not touch is not a conflict', () => {
    const latest = YAML.replace('limit: 1000 }', 'limit: 5 }');
    const out = edit(
      latest,
      (draft) => {
        draft.entries[0].rules[0].limit = '1';
      },
      YAML
    );
    expect(out).toContain('limit: 5 }');
    expect(out).toContain('limit: 1 }');
  });

  test('skips rows that are still incomplete in the draft', () => {
    const out = edit(YAML, (draft) => {
      draft.entries.push(createBudgetEntry());
    });
    expect(out).toBe(YAML);
  });
});

describe('areApiKeyBudgetsEqual', () => {
  test('ignores editor ids and leftovers while off', () => {
    const a = load(YAML);
    const b = structuredClone(a);
    b.entries.forEach((entry) => {
      entry.id = `other-${entry.id}`;
      entry.rules.forEach((rule) => (rule.id = `other-${rule.id}`));
    });
    expect(areApiKeyBudgetsEqual(a, b)).toBe(true);
    b.entries[0].rules[0].limit = '1';
    expect(areApiKeyBudgetsEqual(a, b)).toBe(false);
    const off = { ...a, enabled: false };
    expect(areApiKeyBudgetsEqual(off, { ...off, entries: [], mode: 'enforce' })).toBe(true);
  });
});

describe('validateApiKeyBudgets', () => {
  const valid = () => load(YAML);
  const issues = (mutate: (draft: ApiKeyBudgetsDraft) => void, keys = KEYS) => {
    const draft = valid();
    mutate(draft);
    return validateApiKeyBudgets(draft, keys);
  };
  const rule = (result: ReturnType<typeof validateApiKeyBudgets>, entry = 0, index = 0) => {
    const draft = valid();
    const found =
      result.entries[draft.entries[entry].id]?.rules[draft.entries[entry].rules[index].id];
    return found ?? {};
  };

  test('accepts what the backend accepts', () => {
    expect(hasApiKeyBudgetIssues(validateApiKeyBudgets(valid(), KEYS))).toBe(false);
    expect(
      hasApiKeyBudgetIssues(validateApiKeyBudgets({ ...valid(), enabled: false, mode: 'x' }, []))
    ).toBe(false);
  });

  test('bad window', () => {
    expect(rule(issues((d) => (d.entries[0].rules[0].window = 'year')))).toEqual({
      window: 'window_invalid',
    });
    expect(rule(issues((d) => (d.entries[0].rules[0].window = 'Day')))).toEqual({
      window: 'window_invalid',
    });
    expect(rule(issues((d) => (d.entries[0].rules[0].window = '')))).toEqual({
      window: 'window_invalid',
    });
  });

  test('limit must be a positive whole number', () => {
    for (const limit of ['0', '-5', '1.5', 'abc', '', ' ', '1e3', '9007199254740993']) {
      expect(rule(issues((d) => (d.entries[0].rules[0].limit = limit)))).toEqual({
        limit: 'limit_invalid',
      });
    }
    for (const limit of ['1', ' 42 ', '2000000']) {
      expect(hasApiKeyBudgetIssues(issues((d) => (d.entries[0].rules[0].limit = limit)))).toBe(
        false
      );
    }
  });

  test('models must not be empty', () => {
    for (const models of ['', '   ']) {
      expect(rule(issues((d) => (d.entries[0].rules[0].models = models)))).toEqual({
        models: 'models_required',
      });
    }
  });

  test('two rules with the same models and window collide, whatever the case', () => {
    const result = issues((d) => {
      d.entries[0].rules[1] = {
        ...d.entries[0].rules[1],
        models: ' CLAUDE-FABLE-* ',
        window: 'week',
      };
    });
    expect(rule(result, 0, 1)).toEqual({ models: 'rule_duplicate' });
    // the same pattern in another window is a different rule
    expect(
      hasApiKeyBudgetIssues(
        issues(
          (d) => (d.entries[0].rules[1] = { ...d.entries[0].rules[1], models: 'claude-fable-*' })
        )
      )
    ).toBe(false);
  });

  test('bad modes', () => {
    expect(issues((d) => (d.mode = 'strict')).mode).toBe('mode_invalid');
    expect(issues((d) => (d.mode = ' Enforce ')).mode).toBeUndefined();
    expect(rule(issues((d) => (d.entries[0].rules[0].mode = 'strict')))).toEqual({
      mode: 'rule_mode_invalid',
    });
  });

  test('duplicate label', () => {
    const result = issues((d) => (d.entries[1].label = 'agents'));
    const draft = valid();
    expect(result.entries[draft.entries[0].id].label).toBe('label_duplicate');
    expect(result.entries[draft.entries[1].id].label).toBe('label_duplicate');
  });

  test('label shape', () => {
    for (const label of ['', ' a', 'a ', 'a/b', 'a\\b', '.', '..', 'a\nb']) {
      const draft = valid();
      draft.entries[0] = { ...draft.entries[0], label, saved: false };
      const code = validateApiKeyBudgets(draft, KEYS).entries[draft.entries[0].id].label;
      expect(code).toBe(label === '' ? 'label_required' : 'label_invalid');
    }
  });

  test('key must exist in api-keys', () => {
    const draft = valid();
    expect(validateApiKeyBudgets(draft, KEYS.slice(1)).entries[draft.entries[0].id].key).toBe(
      'key_not_listed'
    );
    draft.entries[0].key = '';
    expect(validateApiKeyBudgets(draft, KEYS).entries[draft.entries[0].id].key).toBe(
      'key_required'
    );
  });

  test('one key cannot carry two entries or two labels', () => {
    const draft = valid();
    draft.entries[1].key = draft.entries[0].key;
    const result = validateApiKeyBudgets(draft, KEYS);
    expect(result.entries[draft.entries[0].id].key).toBe('key_duplicate');
    expect(result.entries[draft.entries[1].id].key).toBe('key_duplicate');

    const fresh = valid();
    fresh.entries.push({
      id: 'n',
      label: 'second',
      key: 'key-agents-0001',
      saved: false,
      rules: [],
    });
    expect(validateApiKeyBudgets(fresh, KEYS).entries.n.key).toBe('key_duplicate');
    fresh.entries[0].key = 'key-spare-00003';
    fresh.entries[0].saved = false;
    expect(validateApiKeyBudgets(fresh, KEYS).entries.n.key).toBe('key_has_other_label');
  });

  test('a typed label cannot silently re-point an existing label', () => {
    const draft = valid();
    draft.entries.push({
      id: 'n',
      label: 'agents',
      key: 'key-spare-00003',
      saved: false,
      rules: [],
    });
    expect(validateApiKeyBudgets(draft, KEYS).entries.n.label).toBe('label_duplicate');
    draft.entries = [draft.entries[1], draft.entries[2]];
    expect(validateApiKeyBudgets(draft, KEYS).entries.n.label).toBe('label_key_mismatch');
    draft.entries[1].key = 'key-agents-0001';
    expect(hasApiKeyBudgetIssues(validateApiKeyBudgets(draft, KEYS))).toBe(false);
  });

  test('weights and timezone', () => {
    expect(issues((d) => (d.weights.output = '-1')).weights).toEqual({ output: 'weight_invalid' });
    expect(issues((d) => (d.weights.input = 'Infinity')).weights).toEqual({
      input: 'weight_invalid',
    });
    expect(issues((d) => (d.weights.cacheRead = '0')).weights).toEqual({});
    expect(issues((d) => (d.weights.cacheRead = '')).weights).toEqual({});
    for (const timezone of ['Mars/Base', 'utc', 'america/new_york', '+05:00', 'UTC+1']) {
      expect(issues((d) => (d.timezone = timezone)).timezone).toBe('timezone_invalid');
    }
    for (const timezone of ['', 'UTC', 'Europe/Paris', 'America/New_York', 'Asia/Tokyo', 'Local']) {
      expect(issues((d) => (d.timezone = timezone)).timezone).toBeUndefined();
    }
  });
});
