import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of } from 'rxjs';
import { AuditEntry, ConfigView, FieldView } from '../../core/api/config.types';
import { Settings } from './settings';

const XSS = '<img src=x onerror=alert(1)>';
const KEY = 'sk-ant-super-secret-123';

const f = <T>(value: T, source: FieldView['source'] = 'env', updatedAt?: string): FieldView<T> => ({
  value,
  source,
  restartRequired: false,
  ...(updatedAt ? { updatedAt } : {}),
});

function configView(overrides: Partial<ConfigView> = {}): ConfigView {
  return {
    settings: {
      llm: {
        provider: f<'openai-compatible' | 'anthropic'>('openai-compatible'),
        baseUrl: f('http://localhost:11434/v1', 'default'),
        model: f<string | null>('qwen3:8b'),
        temperature: f(0.2, 'panel', '2026-10-11T10:00:00.000Z'),
        disableThinking: f(true, 'default'),
        anthropicModel: f('claude-x', 'default'),
        anthropicApiKey: { set: false, source: 'default' },
      },
      assistant: { memoryTurns: f(6, 'default'), showCitations: f(false, 'default') },
      mcp: {
        serverCommand: f<string | null>('npx'),
        serverArgs: f(['-y', 'mcp-server']),
        toolsMapping: f<Record<string, unknown> | null>({ tools: [] }),
        callTimeoutMs: f(30000, 'default'),
      },
      scripts: { registry: f<unknown>({ scripts: [] }) },
    },
    llm: { description: `qwen3:8b @ http://localhost:11434/v1 ${XSS}` },
    scripts: { registered: ['disk.usage'], rejected: [{ id: 'old.one', reason: `gone ${XSS}` }] },
    pendingRestart: [],
    ...overrides,
  };
}

describe('Settings', () => {
  let fixture: ComponentFixture<Settings>;
  let backend: HttpTestingController;
  let confirmed: boolean | undefined;
  const snackBar = { open: vi.fn() };

  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };
  const expectRequest = (method: string, url: string) =>
    vi.waitFor(
      (): TestRequest =>
        backend.expectOne((req) => req.method === method && req.urlWithParams === url),
    );
  const card = (title: string) =>
    [...el().querySelectorAll<HTMLElement>('mat-card')].find(
      (c) => c.querySelector('h2')?.textContent?.trim() === title,
    )!;
  /** The input/textarea of the form field labelled `label`. */
  const control = (label: string) => {
    const field = [...el().querySelectorAll('mat-form-field')].find(
      (ff) => ff.querySelector('mat-label')?.textContent?.trim() === label,
    )!;
    return field.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!;
  };
  const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const buttonIn = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    )!;
  const submit = async (root: HTMLElement, label: string) => {
    buttonIn(root, label).click();
    await settle();
  };
  const result = (config: ConfigView, applied: string[] = [], restartRequired: string[] = []) => ({
    applied,
    restartRequired,
    config,
  });

  async function render(view = configView(), audit: AuditEntry[] = []) {
    fixture = TestBed.createComponent(Settings);
    (await expectRequest('GET', '/v1/config')).flush(view);
    (await expectRequest('GET', '/v1/config/models')).flush({ models: ['qwen3:8b', 'gemma3'] });
    (await expectRequest('GET', '/v1/config/audit?limit=50')).flush({ entries: audit });
    await settle();
  }

  /** After a change the audit (and, for the model section, the models list) is reloaded. */
  async function flushReloads(models = false) {
    (await expectRequest('GET', '/v1/config/audit?limit=50')).flush({ entries: [] });
    if (models) (await expectRequest('GET', '/v1/config/models')).flush({ models: [] });
    await settle();
  }

  beforeEach(() => {
    confirmed = true;
    snackBar.open.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(confirmed) }) } },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      ],
    });
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('renders the effective values with their sources, as plain text', async () => {
    await render();
    const llm = card('Modelo');
    expect(llm.textContent).toContain(`Modelo actual: qwen3:8b @ http://localhost:11434/v1 ${XSS}`);
    expect(control('URL base').value).toBe('http://localhost:11434/v1');
    expect(control('Modelo').value).toBe('qwen3:8b');
    expect(control('Temperatura').value).toBe('0.2');
    expect(control('Turnos de memoria').value).toBe('6');
    expect(control('Argumentos').value).toBe('-y\nmcp-server');
    expect(control('Mapeo de herramientas (JSON)').value).toBe('{\n  "tools": []\n}');

    const badges = [...llm.querySelectorAll('.meta .badge')].map((b) => b.textContent?.trim());
    expect(badges.slice(0, 4)).toEqual([
      'Origen: .env',
      'Origen: Por defecto',
      'Origen: .env',
      'Origen: Panel',
    ]);
    // Only panel values can be reset.
    expect(buttonIn(llm, 'Restablecer Temperatura')).toBeDefined();
    expect(buttonIn(llm, 'Restablecer URL base')).toBeUndefined();
    expect(llm.querySelector('.secret__state')?.textContent).toContain('No configurada');
    expect(card('Scripts de consulta').querySelector('.scripts__rejected')?.textContent).toContain(
      `old.one — gone ${XSS}`,
    );
    expect(el().querySelector('img')).toBeNull();
  });

  it('saves only the changed key and refreshes from the response', async () => {
    await render();
    type(control('Temperatura') as HTMLInputElement, '0.7');
    await settle();
    await submit(card('Modelo'), 'Guardar modelo');

    const put = await expectRequest('PUT', '/v1/config');
    expect(put.request.body).toEqual({ llm: { temperature: 0.7 } });
    const next = configView();
    next.settings.llm.temperature = f(0.7, 'panel');
    put.flush(result(next, ['llm.temperature']));
    await flushReloads(true);

    expect(snackBar.open).toHaveBeenCalledWith(
      'Aplicado: llm.temperature',
      'Cerrar',
      expect.anything(),
    );
    expect(control('Temperatura').value).toBe('0.7');
  });

  it('does not send anything when nothing changed', async () => {
    await render();
    await submit(card('Respuestas'), 'Guardar respuestas');
    expect(snackBar.open).toHaveBeenCalledWith(
      'No hay cambios para guardar',
      'Cerrar',
      expect.anything(),
    );
  });

  it('"Restablecer" sends null for that key', async () => {
    await render();
    await submit(card('Modelo'), 'Restablecer Temperatura');
    const put = await expectRequest('PUT', '/v1/config');
    expect(put.request.body).toEqual({ llm: { temperature: null } });
    put.flush(result(configView(), ['llm.temperature']));
    await flushReloads(true);
  });

  it('never prefills the API key and clears it after saving', async () => {
    await render();
    const llm = card('Modelo');
    const input = control('Clave') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');

    type(input, KEY);
    await settle();
    await submit(llm, 'Cargar');
    const put = await expectRequest('PUT', '/v1/config/secrets/anthropic-api-key');
    expect(put.request.body).toEqual({ value: KEY });
    const next = configView();
    next.settings.llm.anthropicApiKey = {
      set: true,
      source: 'panel',
      updatedAt: '2026-10-11T12:00:00.000Z',
    };
    put.flush(result(next, ['llm.anthropicApiKey']));
    await flushReloads();

    expect(llm.querySelector('.secret__state')?.textContent).toContain('Configurada');
    expect((control('Nueva clave') as HTMLInputElement).value).toBe('');
    expect(el().innerHTML).not.toContain(KEY);
    expect(
      [...el().querySelectorAll('input, textarea')].some(
        (node) => (node as HTMLInputElement).value === KEY,
      ),
    ).toBe(false);

    await submit(llm, 'Borrar');
    const del = await expectRequest('DELETE', '/v1/config/secrets/anthropic-api-key');
    del.flush(result(configView(), ['llm.anthropicApiKey']));
    await flushReloads();
    expect(llm.querySelector('.secret__state')?.textContent).toContain('No configurada');
  });

  it('marks the MCP fields and pending keys as restart-only', async () => {
    await render(configView({ pendingRestart: ['mcp.serverCommand'] }));
    expect(card('Herramientas MCP').textContent).toContain('Requiere reiniciar el servidor.');
    expect(el().querySelector('.banner--restart[role="status"]')?.textContent).toContain(
      'mcp.serverCommand',
    );

    type(control('Comando del servidor MCP'), 'node');
    await settle();
    await submit(card('Herramientas MCP'), 'Guardar herramientas');
    const put = await expectRequest('PUT', '/v1/config');
    expect(put.request.body).toEqual({ mcp: { serverCommand: 'node' } });
    put.flush(
      result(configView({ pendingRestart: ['mcp.serverCommand'] }), [], ['mcp.serverCommand']),
    );
    await flushReloads();
    expect(snackBar.open).toHaveBeenCalledWith(
      'Guardado. Requiere reiniciar el servidor: mcp.serverCommand',
      'Cerrar',
      expect.anything(),
    );
  });

  it('shows invalid JSON before sending and the 422 write-guard issues next to the registry', async () => {
    await render();
    const scripts = card('Scripts de consulta');
    expect(scripts.textContent).toContain('se rechaza por diseño');
    const registry = control('Registro de scripts (JSON)');

    type(registry, '{ nope');
    await settle();
    await submit(scripts, 'Guardar scripts');
    expect(scripts.querySelector('.field-error')?.textContent).toMatch(/^JSON inválido/);

    type(registry, '{ "scripts": [{ "id": "disk.wipe" }] }');
    await settle();
    await submit(scripts, 'Guardar scripts');
    (await expectRequest('PUT', '/v1/config')).flush(
      {
        error: {
          code: 'validation_failed',
          message: 'Invalid',
          issues: [{ path: 'scripts.registry.disk.wipe', message: `not readOnly ${XSS}` }],
        },
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await settle();
    const error = scripts.querySelector('.field-error[role="alert"]')!;
    expect(error.textContent).toBe(`Script «disk.wipe»: not readOnly ${XSS}`);
    expect(el().querySelector('img')).toBeNull();
    // The draft is kept so it can be fixed.
    expect(registry.value).toContain('disk.wipe');
  });

  it('tests the connection with the unsaved model fields and shows the result', async () => {
    await render();
    const llm = card('Modelo');
    await submit(llm, 'Probar conexión');
    const ok = await expectRequest('POST', '/v1/config/llm/test');
    expect(ok.request.body).toEqual({});
    ok.flush({ ok: true, latencyMs: 42, model: 'qwen3:8b' });
    await settle();
    expect(llm.querySelector('.test-result')?.textContent).toContain(
      'Conexión correcta con qwen3:8b (42 ms)',
    );

    type(control('Modelo'), 'gemma3');
    await settle();
    await submit(llm, 'Probar conexión');
    const failed = await expectRequest('POST', '/v1/config/llm/test');
    expect(failed.request.body).toEqual({ overrides: { model: 'gemma3' } });
    failed.flush({ ok: false, latencyMs: 7, model: 'gemma3', error: `model not found ${XSS}` });
    await settle();
    expect(llm.querySelector('.test-result')?.textContent).toContain(
      `Falló la conexión con gemma3 (7 ms): model not found ${XSS}`,
    );
    expect(el().querySelector('img')).toBeNull();
  });

  it('lists the audit, newest first as sent, with masked secrets', async () => {
    await render(configView(), [
      {
        id: 2,
        key: 'llm.anthropicApiKey',
        oldValue: null,
        newValue: '***',
        changedAt: '2026-10-11T12:00:00.000Z',
        actor: 'admin',
      },
      {
        id: 1,
        key: 'llm.temperature',
        oldValue: 0.2,
        newValue: 0.7,
        changedAt: '2026-10-11T11:00:00.000Z',
        actor: 'admin',
      },
    ]);
    const rows = [...card('Historial de cambios').querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')]
        .slice(0, 2)
        .map((td) => td.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows).toEqual([
      ['llm.anthropicApiKey', '— → a ***'],
      ['llm.temperature', '0.2 → a 0.7'],
    ]);
  });

  it('shows the load error', async () => {
    fixture = TestBed.createComponent(Settings);
    (await expectRequest('GET', '/v1/config')).flush(null, { status: 500, statusText: 'Error' });
    (await expectRequest('GET', '/v1/config/models')).flush({ models: [] });
    (await expectRequest('GET', '/v1/config/audit?limit=50')).flush({ entries: [] });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'No se pudo cargar la configuración',
    );
  });
});
