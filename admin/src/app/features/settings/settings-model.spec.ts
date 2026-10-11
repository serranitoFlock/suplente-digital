import { FieldView } from '../../core/api/config.types';
import {
  buildSectionPatch,
  changeSummary,
  displayValue,
  groupIssues,
  sourceLabel,
  toDraft,
} from './settings-model';

const field = <T>(value: T, source: FieldView['source'] = 'env'): FieldView<T> => ({
  value,
  source,
  restartRequired: false,
});

describe('sourceLabel', () => {
  it('names where each effective value comes from', () => {
    expect(sourceLabel('panel')).toBe('Panel');
    expect(sourceLabel('env')).toBe('.env');
    expect(sourceLabel('default')).toBe('Por defecto');
  });
});

describe('toDraft / buildSectionPatch', () => {
  const llm = {
    provider: field('openai-compatible'),
    baseUrl: field('http://localhost:11434/v1', 'default'),
    model: field<string | null>(null, 'default'),
    temperature: field(0.2),
    disableThinking: field(true),
    anthropicModel: field('claude-x', 'default'),
    anthropicApiKey: { set: true, source: 'env' as const },
  };

  it('sends nothing when the draft matches the effective config', () => {
    const draft = toDraft('llm', llm);
    expect(draft).not.toHaveProperty('anthropicApiKey');
    expect(buildSectionPatch('llm', llm, draft)).toEqual({ patch: {}, errors: {} });
  });

  it('sends only the changed keys', () => {
    const draft = { ...toDraft('llm', llm), temperature: 0.7, model: '  qwen3:8b ' };
    expect(buildSectionPatch('llm', llm, draft)).toEqual({
      patch: { temperature: 0.7, model: 'qwen3:8b' },
      errors: {},
    });
  });

  it('leaves a blank text field unchanged and flags a non-numeric number', () => {
    const draft = { ...toDraft('llm', llm), baseUrl: '   ', temperature: Number.NaN };
    expect(buildSectionPatch('llm', llm, draft)).toEqual({
      patch: {},
      errors: { temperature: 'Ingrese un número' },
    });
  });

  it('edits args one per line and JSON documents as text', () => {
    const mcp = {
      serverCommand: field<string | null>('npx'),
      serverArgs: field(['-y', 'server pkg']),
      toolsMapping: field<Record<string, unknown> | null>({ tools: [] }),
      callTimeoutMs: field(30000, 'default'),
    };
    const draft = toDraft('mcp', mcp);
    expect(draft['serverArgs']).toBe('-y\nserver pkg');
    expect(draft['toolsMapping']).toBe('{\n  "tools": []\n}');
    expect(buildSectionPatch('mcp', mcp, draft).patch).toEqual({});

    const changed = {
      ...draft,
      serverArgs: '-y\n\n server pkg \n--debug',
      toolsMapping: '{ "tools": [{ "name": "jira" }] }',
    };
    expect(buildSectionPatch('mcp', mcp, changed)).toEqual({
      patch: {
        serverArgs: ['-y', 'server pkg', '--debug'],
        toolsMapping: { tools: [{ name: 'jira' }] },
      },
      errors: {},
    });
  });

  it('rejects invalid JSON and non-object documents before sending', () => {
    const scripts = { registry: field<unknown>({ scripts: [] }) };
    expect(
      buildSectionPatch('scripts', scripts, { registry: '{ nope' }).errors['registry'],
    ).toMatch(/^JSON inválido/);
    expect(buildSectionPatch('scripts', scripts, { registry: '[1]' }).errors).toEqual({
      registry: 'Debe ser un objeto JSON ({ ... })',
    });
  });
});

describe('groupIssues', () => {
  it('maps 422 issue paths to fields, script entries and sections', () => {
    const groups = groupIssues([
      { path: 'llm.temperature', message: 'Too big' },
      { path: 'llm', message: 'anthropic needs a key' },
      { path: 'scripts.registry.disk.wipe', message: 'not readOnly' },
      { path: 'mcp.toolsMapping.tools.0.name', message: 'Required' },
      { path: '', message: 'Invalid body' },
    ]);
    expect(groups.fields).toEqual({
      'llm.temperature': ['Too big'],
      'scripts.registry': ['Script «disk.wipe»: not readOnly'],
      'mcp.toolsMapping': ['tools.0.name: Required'],
    });
    expect(groups.sections).toEqual({ llm: ['anthropic needs a key'], general: ['Invalid body'] });
  });
});

describe('changeSummary', () => {
  it('says what is in effect and what needs a restart', () => {
    expect(changeSummary({ applied: ['llm.temperature'], restartRequired: [] })).toBe(
      'Aplicado: llm.temperature',
    );
    expect(
      changeSummary({ applied: [], restartRequired: ['mcp.serverCommand', 'mcp.serverArgs'] }),
    ).toBe('Guardado. Requiere reiniciar el servidor: mcp.serverCommand, mcp.serverArgs');
    expect(changeSummary({ applied: [], restartRequired: [] })).toBe('Sin cambios');
  });
});

describe('displayValue', () => {
  it('renders audit values as short text', () => {
    expect(displayValue(null)).toBe('—');
    expect(displayValue('***')).toBe('***');
    expect(displayValue(0.5)).toBe('0.5');
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
  });
});
