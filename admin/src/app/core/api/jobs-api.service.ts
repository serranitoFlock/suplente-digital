import { HttpClient, httpResource, HttpResourceRequest } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DecisionResponse, JobList, JobStatus, JobView } from './api.types';

export type Decision = 'approve' | 'reject';

/** Typed client for the admin-scope job endpoints. The bearer token is added by `authInterceptor`. */
@Injectable({ providedIn: 'root' })
export class JobsApi {
  readonly #http = inject(HttpClient);

  /** Reactive list of jobs with the given status (`httpResource`; call it in an injection context). */
  listResource(status: () => JobStatus | undefined) {
    return httpResource<JobList>((): HttpResourceRequest => {
      const value = status();
      return value === undefined
        ? { url: '/v1/jobs' }
        : { url: '/v1/jobs', params: { status: value } };
    });
  }

  get(id: number): Promise<JobView> {
    return firstValueFrom(this.#http.get<JobView>(`/v1/jobs/${id}`));
  }

  /** `note` is optional; an empty note is not sent. Rejects with `HttpErrorResponse` (404, 409 not_pending, ...). */
  decide(id: number, decision: Decision, note?: string): Promise<DecisionResponse> {
    const trimmed = note?.trim();
    return firstValueFrom(
      this.#http.post<DecisionResponse>(
        `/v1/jobs/${id}/${decision}`,
        trimmed ? { note: trimmed } : {},
      ),
    );
  }
}
