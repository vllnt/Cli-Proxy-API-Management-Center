import { memo, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useAuthStore } from '@/stores';
import { maskApiKey } from '@/utils/format';
import type {
  ApiKeyBudgetEntryDraft,
  ApiKeyBudgetRuleDraft,
  ApiKeyBudgetsDraft,
} from '@/types/visualConfig';
import {
  BUDGET_MODES,
  BUDGET_WEIGHT_FIELDS,
  BUDGET_WINDOWS,
  createBudgetEntry,
  createBudgetRule,
  splitApiKeys,
  validateApiKeyBudgets,
  type BudgetIssueCode,
} from '../../apiKeyBudgets';
import { apiKeyNameFingerprint, readApiKeyNames } from '../../apiKeyNames';
import { FieldGrid, FieldHint, FieldShell, FieldStack, ToggleRow } from '../fields/FieldPrimitives';
import styles from './Blocks.module.scss';

interface ApiKeyBudgetsEditorProps {
  value: ApiKeyBudgetsDraft;
  /** The api-keys editor's text; the picker offers exactly these keys. */
  apiKeysText: string;
  disabled?: boolean;
  onChange: (next: ApiKeyBudgetsDraft) => void;
}

export const ApiKeyBudgetsEditor = memo(function ApiKeyBudgetsEditor(
  props: ApiKeyBudgetsEditorProps
) {
  const apiBase = useAuthStore((state) => state.apiBase);
  return <ScopedApiKeyBudgetsEditor {...props} apiBase={apiBase} />;
});

type Option = { value: string; label: string };

function SelectField({
  id,
  label,
  value,
  options,
  placeholder,
  disabled,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <FieldShell label={label} htmlFor={id} error={error} errorId={errorId}>
      <Select
        id={id}
        value={value}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        ariaInvalid={Boolean(error)}
        ariaDescribedBy={error ? errorId : undefined}
        onChange={onChange}
      />
    </FieldShell>
  );
}

function ScopedApiKeyBudgetsEditor({
  value,
  apiKeysText,
  disabled,
  onChange,
  apiBase,
}: ApiKeyBudgetsEditorProps & { apiBase: string }) {
  const { t } = useTranslation();
  const id = useId();
  const apiKeys = useMemo(() => splitApiKeys(apiKeysText), [apiKeysText]);
  const fingerprints = useMemo(
    () => apiKeys.map((key) => apiKeyNameFingerprint(apiBase, key)),
    [apiBase, apiKeys]
  );
  // Names are edited in the API keys card; reading them per render keeps the picker current.
  const names = readApiKeyNames(apiBase);
  const issues = useMemo(() => validateApiKeyBudgets(value, apiKeys), [value, apiKeys]);
  const issueText = (code: BudgetIssueCode | undefined, key = '') =>
    code
      ? t(`config_management.visual.budgets.issues.${code}`, { key: maskApiKey(key) })
      : undefined;

  // Only masked keys and names reach the DOM; the option value is an index, never a key.
  const keyLabels = apiKeys.map((key, index) => {
    const name = names[fingerprints[index]];
    return name ? `${name} · ${maskApiKey(key)}` : maskApiKey(key);
  });
  // Different keys can mask alike; the list position (as in the API keys card) tells them apart.
  const keyOptions: Option[] = keyLabels.map((label, index) => ({
    value: String(index),
    label:
      keyLabels.indexOf(label) === keyLabels.lastIndexOf(label) ? label : `${label} #${index + 1}`,
  }));
  const modeOptions = (inherit: boolean): Option[] => [
    ...(inherit
      ? [{ value: '', label: t('config_management.visual.budgets.rule_mode_inherit') }]
      : []),
    ...BUDGET_MODES.map((mode) => ({
      value: mode,
      label: t(`config_management.visual.budgets.mode_${mode}`),
    })),
  ];
  const windowOptions: Option[] = BUDGET_WINDOWS.map((window) => ({
    value: window,
    label: t(`config_management.visual.budgets.window_${window}`),
  }));

  const patch = (next: Partial<ApiKeyBudgetsDraft>) => onChange({ ...value, ...next });
  const updateEntry = (entryId: string, next: Partial<ApiKeyBudgetEntryDraft>) =>
    patch({
      entries: value.entries.map((entry) => (entry.id === entryId ? { ...entry, ...next } : entry)),
    });
  const updateRule = (
    entry: ApiKeyBudgetEntryDraft,
    ruleId: string,
    next: Partial<ApiKeyBudgetRuleDraft>
  ) =>
    updateEntry(entry.id, {
      rules: entry.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...next } : rule)),
    });
  const pickKey = (entry: ApiKeyBudgetEntryDraft, index: string) => {
    const key = apiKeys[Number(index)] ?? '';
    // A key that already has a label is budgeted under that label; never a second one.
    const existing = Object.entries(value.labels).find(([, mapped]) => mapped === key)?.[0];
    updateEntry(entry.id, existing === undefined ? { key } : { key, label: existing, saved: true });
  };

  return (
    <FieldStack>
      <ToggleRow
        title={t('config_management.visual.budgets.enable')}
        description={t('config_management.visual.budgets.enable_desc')}
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) =>
          patch(enabled ? { enabled, timezone: value.timezone || 'UTC' } : { enabled })
        }
      />
      <FieldHint id={`${id}-behavior`}>
        {t('config_management.visual.budgets.behavior_hint')}
      </FieldHint>

      {value.enabled ? (
        <>
          <FieldGrid>
            <SelectField
              id={`${id}-mode`}
              label={t('config_management.visual.budgets.mode')}
              value={value.mode}
              options={modeOptions(false)}
              disabled={disabled}
              error={issueText(issues.mode)}
              onChange={(mode) => patch({ mode })}
            />
            <Input
              label={t('config_management.visual.budgets.timezone')}
              placeholder="UTC"
              value={value.timezone}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              error={issueText(issues.timezone)}
              hint={t('config_management.visual.budgets.timezone_hint')}
              onChange={(event) => patch({ timezone: event.target.value })}
            />
          </FieldGrid>

          <div role="group" aria-labelledby={`${id}-weights`}>
            <FieldStack>
              <div id={`${id}-weights`} className={styles.blockLabel}>
                {t('config_management.visual.budgets.weights_title')}
              </div>
              <FieldHint>{t('config_management.visual.budgets.weights_desc')}</FieldHint>
              <FieldGrid>
                {BUDGET_WEIGHT_FIELDS.map(({ key }) => (
                  <Input
                    key={key}
                    label={t(`config_management.visual.budgets.weight_${key}`)}
                    placeholder={key === 'cacheRead' ? '0.1' : '1'}
                    inputMode="decimal"
                    value={value.weights[key]}
                    disabled={disabled}
                    autoComplete="off"
                    error={issueText(issues.weights[key])}
                    onChange={(event) =>
                      patch({ weights: { ...value.weights, [key]: event.target.value } })
                    }
                  />
                ))}
              </FieldGrid>
            </FieldStack>
          </div>

          <div className={styles.blockHeaderRow}>
            <div className={styles.blockLabel}>
              {t('config_management.visual.budgets.entries_title')}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => patch({ entries: [...value.entries, createBudgetEntry()] })}
            >
              {t('config_management.visual.budgets.entry_add')}
            </Button>
          </div>

          {value.entries.length === 0 ? (
            <div className={styles.emptyState}>
              {t('config_management.visual.budgets.entries_empty')}
            </div>
          ) : (
            value.entries.map((entry) => {
              const found = issues.entries[entry.id];
              const entryName = entry.label || t('config_management.visual.budgets.entry_untitled');
              const base = `${id}-${entry.id}`;
              const keyIndex = apiKeys.indexOf(entry.key);
              const allowlisted = value.allowlistLabels.includes(entry.label);
              return (
                <div
                  key={entry.id}
                  role="group"
                  aria-label={t('config_management.visual.budgets.entry_title', {
                    label: entryName,
                  })}
                  className={styles.ruleCard}
                >
                  <div className={styles.ruleCardHeader}>
                    <div className={styles.budgetTitle}>
                      <span className={styles.ruleCardTitle}>{entryName}</span>
                      {allowlisted ? (
                        <span className="pill">
                          {t('config_management.visual.budgets.allowlist_badge')}
                        </span>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t('config_management.visual.budgets.entry_remove_aria', {
                        label: entryName,
                      })}
                      onClick={() =>
                        patch({ entries: value.entries.filter((item) => item.id !== entry.id) })
                      }
                    >
                      {t('config_management.visual.budgets.entry_remove')}
                    </Button>
                  </div>
                  {allowlisted ? (
                    <FieldHint>{t('config_management.visual.budgets.allowlist_note')}</FieldHint>
                  ) : null}

                  <FieldGrid>
                    <Input
                      label={t('config_management.visual.budgets.label')}
                      placeholder="agents"
                      value={entry.label}
                      disabled={disabled || entry.saved}
                      autoComplete="off"
                      spellCheck={false}
                      error={issueText(found?.label)}
                      hint={t('config_management.visual.budgets.label_hint')}
                      onChange={(event) => updateEntry(entry.id, { label: event.target.value })}
                    />
                    <SelectField
                      id={`${base}-key`}
                      label={t('config_management.visual.budgets.key')}
                      value={keyIndex >= 0 ? String(keyIndex) : ''}
                      options={keyOptions}
                      placeholder={t('config_management.visual.budgets.key_placeholder')}
                      disabled={disabled || entry.saved}
                      error={issueText(found?.key, entry.key)}
                      onChange={(index) => pickKey(entry, index)}
                    />
                  </FieldGrid>

                  <div className={styles.blockStack}>
                    <div className={styles.blockLabel}>
                      {t('config_management.visual.budgets.rules_title')}
                    </div>
                    <FieldHint>{t('config_management.visual.budgets.rules_hint')}</FieldHint>
                    {entry.rules.map((rule, index) => {
                      const problem = found?.rules[rule.id];
                      const ruleBase = `${base}-${rule.id}`;
                      return (
                        <div
                          key={rule.id}
                          role="group"
                          aria-label={t('config_management.visual.budgets.rule_title', {
                            index: index + 1,
                          })}
                          className={styles.budgetRule}
                        >
                          <div className={styles.ruleCardHeader}>
                            <span className={styles.blockLabel}>
                              {t('config_management.visual.budgets.rule_title', {
                                index: index + 1,
                              })}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={disabled}
                              aria-label={t('config_management.visual.budgets.rule_remove_aria', {
                                index: index + 1,
                                label: entryName,
                              })}
                              onClick={() =>
                                updateEntry(entry.id, {
                                  rules: entry.rules.filter((item) => item.id !== rule.id),
                                })
                              }
                            >
                              {t('config_management.visual.budgets.rule_remove')}
                            </Button>
                          </div>
                          <div className={styles.budgetRuleGrid}>
                            <Input
                              label={t('config_management.visual.budgets.models')}
                              placeholder="claude-fable-*"
                              value={rule.models}
                              disabled={disabled}
                              autoComplete="off"
                              spellCheck={false}
                              error={issueText(problem?.models)}
                              onChange={(event) =>
                                updateRule(entry, rule.id, { models: event.target.value })
                              }
                            />
                            <SelectField
                              id={`${ruleBase}-window`}
                              label={t('config_management.visual.budgets.window')}
                              value={rule.window}
                              options={windowOptions}
                              disabled={disabled}
                              error={issueText(problem?.window)}
                              onChange={(window) => updateRule(entry, rule.id, { window })}
                            />
                            <Input
                              label={t('config_management.visual.budgets.limit')}
                              placeholder="2000000"
                              inputMode="numeric"
                              value={rule.limit}
                              disabled={disabled}
                              autoComplete="off"
                              error={issueText(problem?.limit)}
                              onChange={(event) =>
                                updateRule(entry, rule.id, { limit: event.target.value })
                              }
                            />
                            <SelectField
                              id={`${ruleBase}-mode`}
                              label={t('config_management.visual.budgets.rule_mode')}
                              value={rule.mode}
                              options={modeOptions(true)}
                              disabled={disabled}
                              error={issueText(problem?.mode)}
                              onChange={(mode) => updateRule(entry, rule.id, { mode })}
                            />
                          </div>
                        </div>
                      );
                    })}
                    <div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={disabled}
                        aria-label={t('config_management.visual.budgets.rule_add_aria', {
                          label: entryName,
                        })}
                        onClick={() =>
                          updateEntry(entry.id, { rules: [...entry.rules, createBudgetRule()] })
                        }
                      >
                        {t('config_management.visual.budgets.rule_add')}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </>
      ) : null}
    </FieldStack>
  );
}
