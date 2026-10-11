import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AuditList,
  ConfigPatch,
  ConfigUpdateResult,
  ConfigView,
  LlmTestOverrides,
  LlmTestResult,
  ModelList,
} from './config.types';

const SECRET_URL = '/v1/config/secrets/anthropic-api-key';

/** Typed client for the admin-scope runtime configuration endpoints. */
@Injectable({ providedIn: 'root' })
export class ConfigApi {
  readonly #http = inject(HttpClient);

  /** Reactive config view (`httpResource`; call it in an injection context). */
  configResource() {
    return httpResource<ConfigView>(() => '/v1/config');
  }

  /** Model names offered by a local OpenAI-compatible server (empty with a `reason` otherwise). */
  modelsResource() {
    return httpResource<ModelList>(() => '/v1/config/models');
  }

  auditResource(limit = 50) {
    return httpResource<AuditList>(() => ({ url: '/v1/config/audit', params: { limit } }));
  }

  /** Rejects with `HttpErrorResponse` (422 `validation_failed` with `issues`: nothing was stored). */
  update(patch: ConfigPatch): Promise<ConfigUpdateResult> {
    return firstValueFrom(this.#http.put<ConfigUpdateResult>('/v1/config', patch));
  }

  /** The value is write-only: the API never returns it. */
  setAnthropicApiKey(value: string): Promise<ConfigUpdateResult> {
    return firstValueFrom(this.#http.put<ConfigUpdateResult>(SECRET_URL, { value }));
  }

  deleteAnthropicApiKey(): Promise<ConfigUpdateResult> {
    return firstValueFrom(this.#http.delete<ConfigUpdateResult>(SECRET_URL));
  }

  testLlm(overrides: LlmTestOverrides): Promise<LlmTestResult> {
    const body = Object.keys(overrides).length > 0 ? { overrides } : {};
    return firstValueFrom(this.#http.post<LlmTestResult>('/v1/config/llm/test', body));
  }
}
