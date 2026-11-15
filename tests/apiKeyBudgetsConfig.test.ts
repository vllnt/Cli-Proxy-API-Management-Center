import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'yaml';
import { useVisualConfig } from '../src/hooks/useVisualConfig';
import { buildConfigPatch } from '../src/services/api/configPatch';
import { createBudgetEntry } from '../src/features/config/apiKeyBudgets';
import type { ApiKeyBudgetsDraft } from '../src/types/visualConfig';
import { runVisualConfig } from './helpers/visualConfig';

// The yaml library's own output form, so equality below is byte identity.
const canonical = (yaml: string) =>
  parseDocument(yaml).toString({ indent: 2, lineWidth: 120, minContentWidth: 0 });
const SERVER = canonical(`# gateway
server:
  port: 8317 # keep
access:
  api-keys:
    - key-agents-0001
    - key-monitor-0002
    - key-spare-00003
  api-key-labels:
    agents: key-agents-0001
    monitor: key-monitor-0002
  api-key-auth-allowlist:
    monitor:
      tags: [pool]
  api-key-budgets:
    mode: observe
    labels:
      agents:
        - { models: claude-fable-*, window: week, limit: 2000000 }
future-key: { a: 1 }
`);
const NO_BUDGETS = `# gateway
access:
  api-keys:
    - key-agents-0001
    - key-spare-00003
future-key: { a: 1 }
`;

const draftOf = (yaml: string): ApiKeyBudgetsDraft =>
  structuredClone(runVisualConfig(yaml).visualValues.apiKeyBudgets);

describe('API key budgets in the visual config', () => {
  test('loads into the draft without marking anything dirty', () => {
    const loaded = runVisualConfig(SERVER);
    const budgets = loaded.visualValues.apiKeyBudgets;
    expect(loaded.visualDirty).toBe(false);
    expect(budgets.enabled).toBe(true);
    expect(budgets.entries.map((entry) => entry.label)).toEqual(['agents']);
    expect(budgets.allowlistLabels).toEqual(['monitor']);
    expect(loaded.visualValidationErrors.apiKeyBudgets).toBeUndefined();
  });

  test('an edit marks only apiKeyBudgets dirty and changes only the touched rule', () => {
    const draft = draftOf(SERVER);
    draft.entries[0].rules[0].limit = '1000';
    const config = runVisualConfig(SERVER, [{ apiKeyBudgets: draft }]);
    expect([...config.visualDirtyFields]).toEqual(['apiKeyBudgets']);
    const out = config.applyVisualChangesToYaml(SERVER);
    expect(out).toContain('limit: 1000 }');
    expect(out.replace('limit: 1000 }', 'limit: 2000000 }')).toBe(SERVER);
    expect(buildConfigPatch(SERVER, out).deletions).toEqual([]);
  });

  test('switching to source mode writes the same budgets edit into the draft', () => {
    const draft = draftOf(SERVER);
    draft.entries[0].rules[0].limit = '1000';
    const config = runVisualConfig(SERVER, [{ apiKeyBudgets: draft }]);
    const toDraft = config.applyVisualChangesToYaml(SERVER, 'draft');
    expect(toDraft).toBe(config.applyVisualChangesToYaml(SERVER, 'server'));
    expect(toDraft).toContain('limit: 1000 }');
  });

  test('adding a budget on the second key writes the label and the rules', () => {
    const draft = draftOf(NO_BUDGETS);
    const entry = createBudgetEntry();
    entry.label = 'second';
    entry.key = 'key-spare-00003';
    entry.rules[0] = { ...entry.rules[0], models: 'claude-fable-*', window: 'week', limit: '1000' };
    draft.enabled = true;
    draft.entries = [entry];
    const config = runVisualConfig(NO_BUDGETS, [{ apiKeyBudgets: draft }]);
    expect(config.visualValidationErrors.apiKeyBudgets).toBeUndefined();
    const out = parseDocument(config.applyVisualChangesToYaml(NO_BUDGETS)).toJS();
    expect(out.access['api-key-labels']).toEqual({ second: 'key-spare-00003' });
    expect(out.access['api-key-budgets'].labels.second).toEqual([
      { models: 'claude-fable-*', window: 'week', limit: 1000 },
    ]);
    expect(out['future-key']).toEqual({ a: 1 });
  });

  test('turning budgets off deletes the block but keeps the allowlisted label', () => {
    const draft = draftOf(SERVER);
    draft.enabled = false;
    const config = runVisualConfig(SERVER, [{ apiKeyBudgets: draft }]);
    const out = config.applyVisualChangesToYaml(SERVER);
    const access = parseDocument(out).toJS().access;
    expect(access['api-key-budgets']).toBeUndefined();
    expect(access['api-key-labels']).toEqual({ monitor: 'key-monitor-0002' });
    expect(access['api-key-auth-allowlist']).toEqual({ monitor: { tags: ['pool'] } });
    expect(out).toContain('# gateway');
    // Labels go last, so no request leaves a budget or allowlist pointing at a missing label.
    const deletions = buildConfigPatch(SERVER, out).deletions.map((path) => path.join('.'));
    const firstLabel = deletions.findIndex((path) => path.startsWith('access.api-key-labels'));
    expect(deletions.some((path) => path.startsWith('access.api-key-budgets'))).toBe(true);
    expect(deletions.some((path) => path.startsWith('access.api-key-labels'))).toBe(true);
    expect(
      deletions.slice(firstLabel).every((path) => path.startsWith('access.api-key-labels'))
    ).toBe(true);
  });

  test('an invalid draft reports the field error and valid drafts clear it', () => {
    const draft = draftOf(SERVER);
    draft.entries[0].rules[0].limit = '1.5';
    expect(
      runVisualConfig(SERVER, [{ apiKeyBudgets: draft }]).visualValidationErrors.apiKeyBudgets
    ).toBe('invalid_api_key_budgets');
    draft.entries[0].rules[0].limit = '5';
    expect(
      runVisualConfig(SERVER, [{ apiKeyBudgets: draft }]).visualValidationErrors.apiKeyBudgets
    ).toBeUndefined();
  });

  test('removing an API key that a budget uses blocks the save', () => {
    const config = runVisualConfig(SERVER, [{ apiKeysText: 'key-monitor-0002\nkey-spare-00003' }]);
    expect(config.visualValidationErrors.apiKeyBudgets).toBe('invalid_api_key_budgets');
  });

  test('a rebase keeps the user edit and aligns the entry with the new server state', () => {
    const edited = draftOf(SERVER);
    edited.entries[0].rules[0].limit = '1000';
    const latest = SERVER.replace('port: 8317', 'port: 9000');
    let seen: ApiKeyBudgetsDraft | undefined;
    let dirty: string[] = [];
    function Harness() {
      const v = useVisualConfig();
      const [step, setStep] = useState(0);
      if (step === 0) v.loadVisualValuesFromYaml(SERVER);
      else if (step === 1) v.setVisualValues({ apiKeyBudgets: edited });
      else if (step === 2) {
        const draft = v.applyVisualChangesToYaml(latest);
        expect(v.rebaseVisualValuesFromYaml(latest, draft)).toEqual({ ok: true });
      } else {
        seen = v.visualValues.apiKeyBudgets;
        dirty = [...v.visualDirtyFields];
      }
      if (step < 3) setStep(step + 1);
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(seen?.entries[0].rules[0].limit).toBe('1000');
    expect(seen?.entries[0].id).toBe('budget:agents');
    // The server still has the old limit, so the edit stays pending after the rebase.
    expect(dirty).toEqual(['apiKeyBudgets']);
  });
});
