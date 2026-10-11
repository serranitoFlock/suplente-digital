import { inject, Injectable, InjectionToken, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { AdminEvent } from '../api/api.types';
import { AuthService } from '../auth/auth.service';
import { createSseParser } from './sse-parser';

export type EventsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** `fetch`, injectable so tests can feed a fake stream. */
export const FETCH = new InjectionToken<typeof fetch>('FETCH', {
  factory: () => globalThis.fetch.bind(globalThis),
});

const EVENT_TYPES = new Set<string>(['done', 'needs_approval', 'failed']);
const MAX_BACKOFF_MS = 30_000;

/** Delay before reconnect attempt `n` (1-based): 1 s, 2 s, 4 s, ... capped at 30 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

function toAdminEvent(event: string, data: string): AdminEvent | undefined {
  if (!EVENT_TYPES.has(event)) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'number'
    )
      return undefined;
    return { type: event, data: parsed } as AdminEvent;
  } catch {
    return undefined;
  }
}

/** Live job events (`done`, `needs_approval`, `failed`) for the admin; components depend on this abstraction. */
@Injectable({ providedIn: 'root', useFactory: () => new FetchAdminEvents() })
export abstract class AdminEvents {
  abstract readonly events$: Observable<AdminEvent>;
  abstract readonly status: () => EventsStatus;
  abstract start(): void;
  abstract stop(): void;
}

/**
 * Reads `GET /v1/events` with `fetch` + `ReadableStream`, because `EventSource` cannot send the Authorization
 * header. Reconnects with exponential backoff; a 401 ends the session; `stop()` aborts the request.
 */
export class FetchAdminEvents extends AdminEvents {
  readonly #auth = inject(AuthService);
  readonly #fetch = inject(FETCH);
  readonly #events = new Subject<AdminEvent>();
  readonly #status = signal<EventsStatus>('idle');
  #controller: AbortController | undefined;

  readonly events$ = this.#events.asObservable();
  readonly status = this.#status.asReadonly();

  start(): void {
    if (this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#run(controller.signal);
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    this.#status.set('idle');
  }

  async #run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const token = this.#auth.token();
      if (!token) return this.stop();
      this.#status.set(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const response = await this.#fetch('/v1/events', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          signal,
        });
        if (response.status === 401) {
          this.stop();
          this.#auth.logout();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        attempt = 0;
        this.#status.set('open');
        await this.#consume(response.body, signal);
      } catch {
        // Network error or dropped stream: fall through to the backoff below.
      }
      if (signal.aborted) return;
      attempt += 1;
      this.#status.set('reconnecting');
      await sleep(backoffDelay(attempt), signal);
    }
  }

  async #consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          const event = toAdminEvent(message.event, message.data);
          if (event) this.#events.next(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
