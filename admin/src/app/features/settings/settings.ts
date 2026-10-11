import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, linkedSignal, signal, WritableSignal } from '@angular/core';
import { FieldTree, form, FormField, max, maxLength, min } from '@angular/forms/signals';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS, MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { configErrorMessage, validationIssues } from '../../core/api/api-errors';
import { ConfigApi } from '../../core/api/config-api.service';
import {
  ConfigPatch,
  ConfigUpdateResult,
  ConfigView,
  FieldView,
  LlmTestResult,
  SectionId,
  SettingsView,
} from '../../core/api/config.types';
import { ConfirmDialog, ConfirmDialogData } from './confirm-dialog';
import {
  buildSectionPatch,
  changeSummary,
  displayValue,
  Draft,
  groupIssues,
  IssueGroups,
  IssueSection,
  sourceLabel,
  toDraft,
} from './settings-model';

interface LlmDraft {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  disableThinking: boolean;
  anthropicModel: string;
}
interface AssistantDraft {
  memoryTurns: number;
  showCitations: boolean;
}
interface McpDraft {
  serverCommand: string;
  serverArgs: string;
  toolsMapping: string;
  callTimeoutMs: number;
}
interface ScriptsDraft {
  registry: string;
}

const NO_ISSUES: IssueGroups = { fields: {}, sections: {} };
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * "Configuración": the runtime settings with their effective value and source, saved per section (only the
 * changed keys), plus the write-only Anthropic key, a connection test and the change history. Every server
 * string (descriptions, reasons, issues, audit values) is rendered as plain text.
 */
@Component({
  selector: 'sd-settings',
  // Hints take the space they need, so a two-line hint never overlaps the next field's source badge.
  providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { subscriptSizing: 'dynamic' } }],
  imports: [
    DatePipe,
    FormField,
    MatAutocompleteModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatSliderModule,
    NgTemplateOutlet,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  readonly #api = inject(ConfigApi);
  readonly #dialog = inject(MatDialog);
  readonly #snackBar = inject(MatSnackBar);

  protected readonly resource = this.#api.configResource();
  protected readonly models = this.#api.modelsResource();
  protected readonly audit = this.#api.auditResource();

  /** Server view, replaced by the `config` of every change response. */
  protected readonly config = linkedSignal<ConfigView | undefined>(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );
  protected readonly settings = computed(() => this.config()?.settings);
  protected readonly pendingRestart = computed(() => this.config()?.pendingRestart ?? []);

  protected readonly llmModel = this.#draft<LlmDraft>('llm');
  protected readonly assistantModel = this.#draft<AssistantDraft>('assistant');
  protected readonly mcpModel = this.#draft<McpDraft>('mcp');
  protected readonly scriptsModel = this.#draft<ScriptsDraft>('scripts');
  protected readonly llmForm = form(this.llmModel, (path) => {
    min(path.temperature, 0, { message: 'La temperatura va de 0 a 2' });
    max(path.temperature, 2, { message: 'La temperatura va de 0 a 2' });
  });
  protected readonly assistantForm = form(this.assistantModel, (path) => {
    min(path.memoryTurns, 0, { message: 'Los turnos de memoria van de 0 a 50' });
    max(path.memoryTurns, 50, { message: 'Los turnos de memoria van de 0 a 50' });
  });
  protected readonly mcpForm = form(this.mcpModel, (path) => {
    min(path.callTimeoutMs, 100, { message: 'El tiempo máximo va de 100 a 600000 ms' });
    max(path.callTimeoutMs, 600_000, { message: 'El tiempo máximo va de 100 a 600000 ms' });
  });
  protected readonly scriptsForm = form(this.scriptsModel);

  /** Write-only: never prefilled, cleared after a successful save. */
  protected readonly secretModel = signal({ key: '' });
  protected readonly secretForm = form(this.secretModel, (path) => {
    maxLength(path.key, 1000, { message: 'La clave admite hasta 1000 caracteres' });
  });

  protected readonly busy = signal<SectionId | 'secret' | 'test' | null>(null);
  protected readonly issues = signal<IssueGroups>(NO_ISSUES);
  /** Client-side parse errors by `section.field`. */
  protected readonly clientErrors = signal<Record<string, string>>({});
  protected readonly testResult = signal<LlmTestResult | null>(null);
  protected readonly testError = signal<string | null>(null);

  protected readonly modelOptions = computed(() => {
    const names = this.models.hasValue() ? this.models.value().models : [];
    const typed = this.llmModel().model.trim().toLowerCase();
    return typed ? names.filter((name) => name.toLowerCase().includes(typed)) : names;
  });

  protected readonly sourceLabel = sourceLabel;
  protected readonly displayValue = displayValue;

  protected field(section: SectionId, name: string): FieldView | undefined {
    const group = this.settings()?.[section] as Record<string, FieldView> | undefined;
    return group?.[name];
  }

  protected errorsFor(key: string): string[] {
    const client = this.clientErrors()[key];
    return [...(client ? [client] : []), ...(this.issues().fields[key] ?? [])];
  }

  protected sectionErrors(section: IssueSection): string[] {
    return this.issues().sections[section] ?? [];
  }

  protected reload(): void {
    this.resource.reload();
    this.models.reload();
    this.audit.reload();
  }

  protected async save(section: SectionId): Promise<void> {
    const settings = this.settings();
    if (!settings || this.busy()) return;
    this.issues.set(NO_ISSUES);
    const patch = this.#validPatch(section, settings);
    if (!patch) return;
    if (Object.keys(patch).length === 0) {
      this.#notify('No hay cambios para guardar');
      return;
    }
    await this.#change(section, () => this.#api.update({ [section]: patch } as ConfigPatch));
  }

  /** Back to the `.env` / default value. */
  protected async reset(section: SectionId, name: string): Promise<void> {
    this.issues.set(NO_ISSUES);
    await this.#change(section, () => this.#api.update({ [section]: { [name]: null } }));
  }

  protected async saveSecret(event: Event): Promise<void> {
    event.preventDefault();
    const value = this.secretModel().key.trim();
    this.issues.set(NO_ISSUES);
    if (!value || this.secretForm.key().invalid()) {
      this.clientErrors.set({
        'llm.anthropicApiKey': value ? 'La clave es demasiado larga' : 'Ingrese la clave',
      });
      return;
    }
    this.clientErrors.set({});
    const saved = await this.#change('secret', () => this.#api.setAnthropicApiKey(value));
    if (saved) this.secretModel.set({ key: '' });
  }

  protected async deleteSecret(): Promise<void> {
    const dialog = this.#dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'Borrar la clave de Anthropic',
        message:
          'Se borra la clave cargada desde el panel; vuelve a usarse la del .env, si hay una. Si el proveedor es Anthropic y no queda ninguna clave, el servidor rechaza el cambio.',
        confirm: 'Borrar',
      },
      width: 'min(480px, calc(100vw - 32px))',
      maxWidth: '100vw',
    });
    if (!(await firstValueFrom(dialog.afterClosed()))) return;
    this.issues.set(NO_ISSUES);
    await this.#change('secret', () => this.#api.deleteAnthropicApiKey());
  }

  /** Tests the model with the unsaved LLM fields as overrides (the stored config is not changed). */
  protected async testConnection(): Promise<void> {
    const settings = this.settings();
    if (!settings || this.busy()) return;
    this.issues.set(NO_ISSUES);
    const patch = this.#validPatch('llm', settings);
    if (!patch) return;
    this.testResult.set(null);
    this.testError.set(null);
    this.busy.set('test');
    try {
      this.testResult.set(await this.#api.testLlm(patch));
    } catch (error) {
      const issues = validationIssues(error);
      if (issues) this.issues.set(groupIssues(issues));
      this.testError.set(configErrorMessage(error));
    } finally {
      this.busy.set(null);
    }
  }

  /** The section's minimal patch, or undefined after showing its client-side errors next to the fields. */
  #validPatch(section: SectionId, settings: SettingsView): Record<string, unknown> | undefined {
    const { patch, errors } = buildSectionPatch(
      section,
      settings[section],
      this.#drafts[section](),
    );
    const all = { ...errors, ...this.#formErrors(section) };
    this.clientErrors.set(
      Object.fromEntries(
        Object.entries(all).map(([name, message]) => [`${section}.${name}`, message]),
      ),
    );
    return Object.keys(all).length > 0 ? undefined : patch;
  }

  /** Range errors of the section's signal form, by field name (the server re-validates everything). */
  #formErrors(section: SectionId): Record<string, string> {
    const tree = this.#forms[section] as unknown as Record<string, FieldTree<unknown>>;
    const errors: Record<string, string> = {};
    for (const name of Object.keys(this.#drafts[section]())) {
      const message = tree[name]?.().errors()[0]?.message;
      if (message) errors[name] = message;
    }
    return errors;
  }

  readonly #forms = {
    llm: this.llmForm,
    assistant: this.assistantForm,
    mcp: this.mcpForm,
    scripts: this.scriptsForm,
  };

  readonly #drafts: Record<SectionId, () => Draft> = {
    llm: () => this.llmModel() as unknown as Draft,
    assistant: () => this.assistantModel() as unknown as Draft,
    mcp: () => this.mcpModel() as unknown as Draft,
    scripts: () => this.scriptsModel() as unknown as Draft,
  };

  /**
   * The editable copy of a section: reset from the server whenever that section's effective view changes, so
   * saving one section keeps the unsaved edits of the others.
   */
  #draft<T>(section: SectionId): WritableSignal<T> {
    const view = computed(() => this.settings()?.[section] ?? EMPTY_VIEWS[section], {
      equal: sameJson,
    });
    return linkedSignal(() => toDraft(section, view()) as T);
  }

  /** Runs a change; returns true when it was stored. 422 issues go next to their fields. */
  async #change(
    target: SectionId | 'secret',
    run: () => Promise<ConfigUpdateResult>,
  ): Promise<boolean> {
    this.busy.set(target);
    try {
      const result = await run();
      this.config.set(result.config);
      this.clientErrors.set({});
      this.#notify(changeSummary(result));
      this.audit.reload();
      if (target === 'llm') this.models.reload();
      return true;
    } catch (error) {
      const issues = validationIssues(error);
      if (issues) this.issues.set(groupIssues(target === 'secret' ? secretIssues(issues) : issues));
      this.#notify(configErrorMessage(error));
      return false;
    } finally {
      this.busy.set(null);
    }
  }

  #notify(message: string): void {
    this.#snackBar.open(message, 'Cerrar', { duration: 8000 });
  }
}

/** The secret endpoint validates `{ value }`: show those issues on the key field. */
const secretIssues = (issues: { path: string; message: string }[]) =>
  issues.map((issue) =>
    issue.path === 'value' || issue.path === '' ? { ...issue, path: 'llm.anthropicApiKey' } : issue,
  );

const field = <T>(value: T): FieldView<T> => ({ value, source: 'default', restartRequired: false });

/** Placeholder views before the config loads (the form is only rendered once it has). */
const EMPTY_VIEWS: SettingsView = {
  llm: {
    provider: field('openai-compatible'),
    baseUrl: field(''),
    model: field(null),
    temperature: field(0),
    disableThinking: field(false),
    anthropicModel: field(''),
    anthropicApiKey: { set: false, source: 'default' },
  },
  assistant: { memoryTurns: field(0), showCitations: field(false) },
  mcp: {
    serverCommand: field(null),
    serverArgs: field([]),
    toolsMapping: field(null),
    callTimeoutMs: field(0),
  },
  scripts: { registry: field(null) },
};
