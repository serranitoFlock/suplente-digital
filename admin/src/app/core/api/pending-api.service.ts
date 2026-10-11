import { httpResource } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { PendingSummary } from './api.types';

/** Typed client for the admin-scope pending log endpoints. */
@Injectable({ providedIn: 'root' })
export class PendingApi {
  /** Reactive pending log summary (`httpResource`; call it in an injection context). */
  summaryResource() {
    return httpResource<PendingSummary>(() => '/v1/pending/summary');
  }
}
