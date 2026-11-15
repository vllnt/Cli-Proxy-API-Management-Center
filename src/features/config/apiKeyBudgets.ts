import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';
import { assertConfigListsUnchanged } from '@/services/api/configPatch';
import { makeClientId } from '@/types/visualConfig';
import type {
  ApiKeyBudgetEntryDraft,
  ApiKeyBudgetRuleDraft,
  ApiKeyBudgetsDraft,
  ApiKeyBudgetWeightsDraft,
} from '@/types/visualConfig';

// Source: backend internal/config/api_key_budgets.go, api_key_allowlist.go (config v8).
// The backend stays the authority; the checks here only catch the same mistakes earlier.
type Doc = ReturnType<typeof parseDocument>;

const ACCESS_PATH = ['access'];
const BUDGETS_PATH = ['access', 'api-key-budgets'];
const BUDGET_LABELS_PATH = [...BUDGETS_PATH, 'labels'];
const WEIGHTS_PATH = [...BUDGETS_PATH, 'weights'];
const KEY_LABELS_PATH = ['access', 'api-key-labels'];
const ALLOWLIST_PATH = ['access', 'api-key-auth-allowlist'];

export const BUDGET_WINDOWS = ['day', 'week', 'month'] as const;
export const BUDGET_MODES = ['observe', 'enforce'] as const;
export const BUDGET_WEIGHT_FIELDS = [
  { key: 'input', yaml: 'input' },
  { key: 'output', yaml: 'output' },
  { key: 'cacheWrite', yaml: 'cache-write' },
  { key: 'cacheRead', yaml: 'cache-read' },
] as const satisfies ReadonlyArray<{ key: keyof ApiKeyBudgetWeightsDraft; yaml: string }>;

export type BudgetIssueCode =
  | 'mode_invalid'
  | 'timezone_invalid'
  | 'weight_invalid'
  | 'label_required'
  | 'label_invalid'
  | 'label_duplicate'
  | 'label_key_mismatch'
  | 'key_required'
  | 'key_not_listed'
  | 'key_duplicate'
  | 'key_has_other_label'
  | 'models_required'
  | 'window_invalid'
  | 'limit_invalid'
  | 'rule_mode_invalid'
  | 'rule_duplicate';

export type BudgetRuleIssues = Partial<
  Record<'models' | 'window' | 'limit' | 'mode', BudgetIssueCode>
>;
export type BudgetEntryIssues = {
  label?: BudgetIssueCode;
  key?: BudgetIssueCode;
  /** Keyed by rule id; only rules with a problem appear. */
  rules: Record<string, BudgetRuleIssues>;
};
/** Sparse: absent keys mean no problem. */
export type ApiKeyBudgetsIssues = {
  mode?: BudgetIssueCode;
  timezone?: BudgetIssueCode;
  weights: Partial<Record<keyof ApiKeyBudgetWeightsDraft, BudgetIssueCode>>;
  /** Keyed by entry id; only entries with a problem appear. */
  entries: Record<string, BudgetEntryIssues>;
};

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function plain(doc: Doc, path: string[]): unknown {
  const node = doc.getIn(path, true);
  if (isScalar(node)) return node.value;
  return isMap(node) || isSeq(node) ? node.toJSON() : undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** The backend lower-cases and trims modes; keep anything else so validation can flag it. */
function normalizeMode(value: unknown): string {
  const raw = text(value).trim();
  const lower = raw.toLowerCase();
  return lower === 'observe' || lower === 'enforce' ? lower : raw;
}

export function createBudgetRule(): ApiKeyBudgetRuleDraft {
  return { id: makeClientId(), models: '*', window: 'day', limit: '', mode: '' };
}

export function createBudgetEntry(): ApiKeyBudgetEntryDraft {
  return { id: makeClientId(), label: '', key: '', saved: false, rules: [createBudgetRule()] };
}

/** The client keys of the api-keys editor, one per line. */
export const splitApiKeys = (apiKeysText: string): string[] =>
  apiKeysText
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean);

/** Labels whose value is not a string cannot be a key mapping and stay out of the draft. */
export function readApiKeyBudgets(doc: Doc): ApiKeyBudgetsDraft {
  const labels: Record<string, string> = {};
  for (const [label, key] of Object.entries(record(plain(doc, KEY_LABELS_PATH)))) {
    if (typeof key === 'string') labels[label] = key;
  }
  const allowlist = plain(doc, ALLOWLIST_PATH);
  const allowlistLabels = Object.keys(record(allowlist));
  const enabled = isMap(doc.getIn(BUDGETS_PATH, true));
  const draft: ApiKeyBudgetsDraft = {
    enabled,
    mode: 'observe',
    timezone: '',
    weights: { input: '', output: '', cacheWrite: '', cacheRead: '' },
    entries: [],
    labels,
    allowlistLabels,
  };
  if (!enabled) return draft;

  const budgets = record(plain(doc, BUDGETS_PATH));
  draft.mode = normalizeMode(budgets.mode) || 'observe';
  draft.timezone = text(budgets.timezone).trim();
  const weights = record(budgets.weights);
  for (const { key, yaml } of BUDGET_WEIGHT_FIELDS) draft.weights[key] = text(weights[yaml]).trim();
  draft.entries = Object.entries(record(budgets.labels)).map(([label, rules]) => ({
    id: `budget:${label}`,
    label,
    key: labels[label] ?? '',
    saved: hasOwn(labels, label),
    rules: (Array.isArray(rules) ? rules : []).map((rule, index) => {
      const row = record(rule);
      return {
        id: `budget:${label}#${index}`,
        models: text(row.models),
        window: text(row.window),
        limit: text(row.limit),
        mode: normalizeMode(row.mode),
      };
    }),
  }));
  return draft;
}

const ruleSignature = (rule: ApiKeyBudgetRuleDraft) =>
  JSON.stringify([rule.models, rule.window, rule.limit, rule.mode]);
const sameRules = (a: ApiKeyBudgetRuleDraft[], b: ApiKeyBudgetRuleDraft[]) =>
  a.length === b.length &&
  a.every((rule, index) => ruleSignature(rule) === ruleSignature(b[index]));

/** Editor ids are bookkeeping; everything else is the saved intent. Off ignores leftovers. */
function budgetsSignature(draft: ApiKeyBudgetsDraft): string {
  if (!draft.enabled) return 'off';
  return JSON.stringify([
    draft.mode,
    draft.timezone,
    BUDGET_WEIGHT_FIELDS.map(({ key }) => draft.weights[key]),
    draft.entries.map((entry) => [entry.label, entry.key, entry.rules.map(ruleSignature)]),
  ]);
}

export const areApiKeyBudgetsEqual = (a: ApiKeyBudgetsDraft, b: ApiKeyBudgetsDraft) =>
  budgetsSignature(a) === budgetsSignature(b);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Go's time.LoadLocation is case-sensitive; Intl is not, so reject a case-only difference. */
function isKnownTimezone(zone: string): boolean {
  if (!zone || zone === 'Local') return true;
  if (/^[+-]/.test(zone)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    return !(resolved !== zone && resolved.toLowerCase() === zone.toLowerCase());
  } catch {
    return false;
  }
}

function labelIssue(label: string): BudgetIssueCode | undefined {
  if (!label) return 'label_required';
  // The panel deletes labels by URL path, so separators and control characters cannot be sent.
  if (
    label !== label.trim() ||
    label === '.' ||
    label === '..' ||
    /[/\\]/.test(label) ||
    Array.from(label).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return 'label_invalid';
  }
  return undefined;
}

export const isBudgetLimit = (value: string) =>
  /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export const isBudgetWeight = (value: string) =>
  /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value));

// The backend accepts an empty mode (it falls back to observe) and ignores case and padding.
const validMode = (mode: string) =>
  mode.trim() === '' || (BUDGET_MODES as readonly string[]).includes(mode.trim().toLowerCase());

export function validateApiKeyBudgets(
  draft: ApiKeyBudgetsDraft,
  apiKeys: readonly string[]
): ApiKeyBudgetsIssues {
  const issues: ApiKeyBudgetsIssues = { weights: {}, entries: {} };
  if (!draft.enabled) return issues;

  if (!validMode(draft.mode)) issues.mode = 'mode_invalid';
  if (!isKnownTimezone(draft.timezone.trim())) issues.timezone = 'timezone_invalid';
  for (const { key } of BUDGET_WEIGHT_FIELDS) {
    const value = draft.weights[key].trim();
    if (value && !isBudgetWeight(value)) issues.weights[key] = 'weight_invalid';
  }

  const labelCount = new Map<string, number>();
  const keyCount = new Map<string, number>();
  for (const entry of draft.entries) {
    labelCount.set(entry.label, (labelCount.get(entry.label) ?? 0) + 1);
    keyCount.set(entry.key, (keyCount.get(entry.key) ?? 0) + 1);
  }
  const listed = new Set(apiKeys);
  for (const entry of draft.entries) {
    const found: BudgetEntryIssues = { rules: {} };
    found.label = labelIssue(entry.label);
    if (!found.label && (labelCount.get(entry.label) ?? 0) > 1) found.label = 'label_duplicate';
    if (
      !found.label &&
      hasOwn(draft.labels, entry.label) &&
      draft.labels[entry.label] !== entry.key
    ) {
      found.label = 'label_key_mismatch';
    }
    if (!entry.key) found.key = 'key_required';
    else if (!listed.has(entry.key)) found.key = 'key_not_listed';
    else if ((keyCount.get(entry.key) ?? 0) > 1) found.key = 'key_duplicate';
    else if (
      Object.entries(draft.labels).some(
        ([label, key]) => key === entry.key && label !== entry.label
      )
    ) {
      found.key = 'key_has_other_label';
    }

    const seen = new Set<string>();
    for (const rule of entry.rules) {
      const problem: BudgetRuleIssues = {};
      const models = rule.models.trim().toLowerCase();
      if (!models) problem.models = 'models_required';
      if (!(BUDGET_WINDOWS as readonly string[]).includes(rule.window))
        problem.window = 'window_invalid';
      if (!isBudgetLimit(rule.limit)) problem.limit = 'limit_invalid';
      if (!validMode(rule.mode)) problem.mode = 'rule_mode_invalid';
      if (models && !problem.window) {
        const identity = `${models}|${rule.window}`;
        if (seen.has(identity)) problem.models = 'rule_duplicate';
        seen.add(identity);
      }
      if (Object.keys(problem).length) found.rules[rule.id] = problem;
    }
    if (found.label || found.key || Object.keys(found.rules).length) {
      issues.entries[entry.id] = found;
    }
  }
  return issues;
}

export const hasApiKeyBudgetIssues = (issues: ApiKeyBudgetsIssues) =>
  Boolean(issues.mode || issues.timezone) ||
  Object.keys(issues.weights).length > 0 ||
  Object.keys(issues.entries).length > 0;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function ensureMap(doc: Doc, path: string[]) {
  for (let length = 1; length <= path.length; length += 1) {
    const prefix = path.slice(0, length);
    if (!isMap(doc.getIn(prefix, true))) doc.setIn(prefix, doc.createNode({}));
  }
}

function deleteIfMapEmpty(doc: Doc, path: string[]) {
  const node = doc.getIn(path, true);
  if (isMap(node) && node.items.length === 0) doc.deleteIn(path);
}

/** Set a scalar in place so its quoting and trailing comment survive; blank removes it. */
function syncScalar(doc: Doc, path: string[], value: string | number | undefined) {
  if (value === undefined || value === '') {
    if (doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  ensureMap(doc, path.slice(0, -1));
  doc.setIn(path, value);
}

function setRuleField(map: YAMLMap, key: string, value: string | number | undefined) {
  if (value === undefined || value === '') {
    map.delete(key);
    return;
  }
  const old = map.get(key, true);
  if (isScalar(old)) old.value = value;
  else map.set(key, value);
}

/** The typed value as the backend reads it; text that is not yet valid is kept as typed. */
const limitValue = (limit: string): string | number => {
  const trimmed = limit.trim();
  return isBudgetLimit(trimmed) ? Number(trimmed) : trimmed;
};

function writeRules(
  doc: Doc,
  path: string[],
  prior: ApiKeyBudgetRuleDraft[],
  rules: ApiKeyBudgetRuleDraft[]
) {
  const existing = doc.getIn(path, true);
  const nodes = new Map<string, unknown>();
  if (isSeq(existing)) prior.forEach((rule, index) => nodes.set(rule.id, existing.items[index]));
  const first = isSeq(existing) ? existing.items[0] : undefined;
  // Follow the neighbours' style; a brand-new list uses the compact form of the docs.
  const flow = isMap(first) ? first.flow === true : !isSeq(existing) || existing.items.length === 0;

  const rows = rules.map((rule) => {
    const old = prior.find((item) => item.id === rule.id);
    const reused = nodes.get(rule.id);
    const map = isMap(reused) ? reused : (doc.createNode({}) as YAMLMap);
    if (!isMap(reused)) map.flow = flow;
    const fresh = !isMap(reused) || !old;
    const fields: Array<[string, string | number | undefined, string | undefined]> = [
      ['models', rule.models.trim(), old?.models],
      ['window', rule.window.trim(), old?.window],
      ['limit', limitValue(rule.limit), old?.limit],
      ['mode', rule.mode.trim() || undefined, old?.mode],
    ];
    for (const [key, value, before] of fields) {
      const same = key === 'limit' ? before === rule.limit : before === (value ?? '');
      if (fresh || !same) setRuleField(map, key, value);
    }
    return map;
  });

  if (isSeq(existing)) existing.items = rows;
  else {
    ensureMap(doc, BUDGET_LABELS_PATH);
    doc.setIn(path, doc.createNode(rows));
  }
}

function removeLabelIfUnused(doc: Doc, label: string, key: string) {
  if (hasOwn(record(plain(doc, ALLOWLIST_PATH)), label)) return;
  // Only the mapping this editor saw; a label another admin re-pointed is theirs.
  if (plain(doc, [...KEY_LABELS_PATH, label]) === key) doc.deleteIn([...KEY_LABELS_PATH, label]);
  deleteIfMapEmpty(doc, KEY_LABELS_PATH);
}

/**
 * Apply the budgets edit to the document, touching only what changed so unrelated keys,
 * comments and order survive. With `serverYaml` the replaced rule lists must not have been
 * changed by someone else since that snapshot (lists are written whole).
 */
export function writeApiKeyBudgets(
  doc: Doc,
  baseline: ApiKeyBudgetsDraft,
  desired: ApiKeyBudgetsDraft,
  serverYaml?: string
) {
  const latest = serverYaml === undefined ? '' : doc.toString();
  const replaced: string[][] = [];
  const rulesPath = (label: string) => [...BUDGET_LABELS_PATH, label];

  if (!desired.enabled) {
    for (const entry of baseline.entries) replaced.push(rulesPath(entry.label));
    if (doc.hasIn(BUDGETS_PATH)) doc.deleteIn(BUDGETS_PATH);
    // Allowlist entries keep their label; the block's own labels go with it.
    for (const entry of baseline.entries) removeLabelIfUnused(doc, entry.label, entry.key);
    deleteIfMapEmpty(doc, ACCESS_PATH);
  } else {
    const fresh = !baseline.enabled;
    ensureMap(doc, BUDGETS_PATH);
    if (fresh || desired.mode !== baseline.mode) {
      syncScalar(doc, [...BUDGETS_PATH, 'mode'], desired.mode.trim());
    }
    if (fresh || desired.timezone !== baseline.timezone) {
      syncScalar(doc, [...BUDGETS_PATH, 'timezone'], desired.timezone.trim());
    }
    for (const { key, yaml } of BUDGET_WEIGHT_FIELDS) {
      if (!fresh && desired.weights[key] === baseline.weights[key]) continue;
      const value = desired.weights[key].trim();
      syncScalar(doc, [...WEIGHTS_PATH, yaml], isBudgetWeight(value) ? Number(value) : value);
    }
    deleteIfMapEmpty(doc, WEIGHTS_PATH);

    const wanted = new Set(desired.entries.map((entry) => entry.label));
    for (const entry of baseline.entries) {
      if (wanted.has(entry.label)) continue;
      replaced.push(rulesPath(entry.label));
      doc.deleteIn(rulesPath(entry.label));
      removeLabelIfUnused(doc, entry.label, entry.key);
    }
    const before = new Map(baseline.entries.map((entry) => [entry.label, entry]));
    for (const entry of desired.entries) {
      // Incomplete rows only exist in the draft; validation keeps them out of saves.
      if (!entry.label || !entry.key) continue;
      if (plain(doc, [...KEY_LABELS_PATH, entry.label]) !== entry.key) {
        ensureMap(doc, KEY_LABELS_PATH);
        doc.setIn([...KEY_LABELS_PATH, entry.label], entry.key);
      }
      const prior = before.get(entry.label);
      if (prior && sameRules(prior.rules, entry.rules)) continue;
      replaced.push(rulesPath(entry.label));
      writeRules(doc, rulesPath(entry.label), prior?.rules ?? [], entry.rules);
    }
    deleteIfMapEmpty(doc, BUDGET_LABELS_PATH);
  }

  if (serverYaml !== undefined && replaced.length) {
    assertConfigListsUnchanged(serverYaml, doc.toString(), latest, replaced);
  }
}
