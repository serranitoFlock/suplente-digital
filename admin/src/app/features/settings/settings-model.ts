import {
  ConfigUpdateResult,
  FieldView,
  SectionId,
  SecretView,
  SettingSource,
  ValidationIssue,
} from '../../core/api/config.types';

const SOURCE_LABELS: Record<SettingSource, string> = {
  panel: 'Panel',
  env: '.env',
  default: 'Por defecto',
};

export const sourceLabel = (source: SettingSource): string => SOURCE_LABELS[source];

/** How a field is edited: JSON documents as text, string lists one entry per line. */
type FieldKind = 'json' | 'lines' | 'plain';

const KINDS: Record<string, FieldKind> = {
  'mcp.serverArgs': 'lines',
  'mcp.toolsMapping': 'json',
  'scripts.registry': 'json',
};

const kindOf = (section: SectionId, name: string): FieldKind =>
  KINDS[`${section}.${name}`] ?? 'plain';

/** Form state of one section: field name → editable value (text for JSON and lists). */
export type Draft = Record<string, unknown>;

type SectionFields = Record<string, FieldView | SecretView>;

const isField = (view: FieldView | SecretView): view is FieldView => 'value' in view;

function draftValue(kind: FieldKind, value: unknown): unknown {
  if (kind === 'json') return value == null ? '' : JSON.stringify(value, null, 2);
  if (kind === 'lines') return Array.isArray(value) ? value.join('\n') : '';
  return value ?? '';
}

/** The editable values of a section, from its effective config (secrets are never part of a draft). */
export function toDraft(section: SectionId, fields: SectionFields): Draft {
  const draft: Draft = {};
  for (const [name, view] of Object.entries(fields)) {
    if (isField(view)) draft[name] = draftValue(kindOf(section, name), view.value);
  }
  return draft;
}

type Parsed = { skip: true } | { value: unknown } | { error: string };

function parseJsonDocument(text: string): Parsed {
  if (text.trim() === '') return { skip: true };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      error: `JSON inválido: ${error instanceof Error ? error.message : 'revise la sintaxis'}`,
    };
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { value }
    : { error: 'Debe ser un objeto JSON ({ ... })' };
}

function parseDraft(kind: FieldKind, effective: unknown, raw: unknown): Parsed {
  if (kind === 'json') return parseJsonDocument(String(raw ?? ''));
  if (kind === 'lines')
    return {
      value: String(raw ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  if (typeof effective === 'number' || typeof raw === 'number') {
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) && raw !== '' && raw !== null
      ? { value }
      : { error: 'Ingrese un número' };
  }
  if (typeof raw === 'string') {
    const value = raw.trim();
    return value === '' ? { skip: true } : { value };
  }
  return { value: raw };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The minimal patch for one section: only the fields whose parsed draft differs from the effective value.
 * A blank text or JSON field is left unchanged (resetting is the explicit "Restablecer" action, which sends
 * `null`). Values that cannot be parsed are reported in `errors` and never sent.
 */
export function buildSectionPatch(
  section: SectionId,
  fields: SectionFields,
  draft: Draft,
): { patch: Record<string, unknown>; errors: Record<string, string> } {
  const patch: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [name, view] of Object.entries(fields)) {
    if (!isField(view) || !(name in draft)) continue;
    const parsed = parseDraft(kindOf(section, name), view.value, draft[name]);
    if ('error' in parsed) errors[name] = parsed.error;
    else if ('value' in parsed && !same(parsed.value, view.value)) patch[name] = parsed.value;
  }
  return { patch, errors };
}

export type IssueSection = SectionId | 'general';

export interface IssueGroups {
  /** `section.field` → messages (script entries and nested document paths are prefixed). */
  fields: Record<string, string[]>;
  /** Issues about a whole section (e.g. `llm` from the model resolver) or the request. */
  sections: Partial<Record<IssueSection, string[]>>;
}

const SECTIONS: readonly string[] = ['llm', 'assistant', 'mcp', 'scripts'];

/** Groups the API's 422 issues by the field or section they belong to. */
export function groupIssues(issues: readonly ValidationIssue[]): IssueGroups {
  const groups: IssueGroups = { fields: {}, sections: {} };
  const push = <K extends string>(map: Partial<Record<K, string[]>>, key: K, message: string) =>
    (map[key] ??= []).push(message);
  for (const { path, message } of issues) {
    const [section = '', name, ...rest] = path.split('.');
    if (!SECTIONS.includes(section)) {
      push(groups.sections, 'general', message);
    } else if (name === undefined) {
      push(groups.sections, section as SectionId, message);
    } else if (rest.length === 0) {
      push(groups.fields, `${section}.${name}`, message);
    } else if (section === 'scripts' && name === 'registry') {
      push(groups.fields, 'scripts.registry', `Script «${rest.join('.')}»: ${message}`);
    } else {
      push(groups.fields, `${section}.${name}`, `${rest.join('.')}: ${message}`);
    }
  }
  return groups;
}

/** One line for the snackbar after a change. */
export function changeSummary({
  applied,
  restartRequired,
}: Pick<ConfigUpdateResult, 'applied' | 'restartRequired'>): string {
  const parts: string[] = [];
  if (applied.length > 0) parts.push(`Aplicado: ${applied.join(', ')}`);
  if (restartRequired.length > 0)
    parts.push(
      `${applied.length > 0 ? '' : 'Guardado. '}Requiere reiniciar el servidor: ${restartRequired.join(', ')}`,
    );
  return parts.length > 0 ? parts.join('. ') : 'Sin cambios';
}

/** Audit values as short plain text (secrets already arrive as `***`). */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
