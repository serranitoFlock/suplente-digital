import { TestBed } from '@angular/core/testing';
import { firstValueFrom, take, toArray } from 'rxjs';
import { AdminEvent } from '../api/api.types';
import { AuthService } from '../auth/auth.service';
import { AdminEvents, backoffDelay, FETCH } from './admin-events.service';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Left open, like a live SSE stream.
    },
  });
}

function setup(fetchImpl: typeof fetch) {
  const logout = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: FETCH, useValue: fetchImpl },
      { provide: AuthService, useValue: { token: () => 'admin-token', logout } },
    ],
  });
  return { events: TestBed.inject(AdminEvents), logout };
}

describe('AdminEvents (fetch + ReadableStream)', () => {
  it('sends the bearer token and emits typed events, skipping comments and unknown events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          streamOf(
            ': connected\n\n',
            'event: needs_approval\ndata: {"id":3,"question":"q","draft":"d"}\n\n',
            'event: other\ndata: {"id":9}\n\n: ping\n\nevent: do',
            'ne\ndata: {"id":3,"question":"q","answer":"a"}\n\n',
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    const { events } = setup(fetchMock);
    const received = firstValueFrom(events.events$.pipe(take(2), toArray()));
    events.start();
    const list: AdminEvent[] = await received;
    expect(list.map((e) => [e.type, e.data.id])).toEqual([
      ['needs_approval', 3],
      ['done', 3],
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/v1/events');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer admin-token');
    expect(events.status()).toBe('open');
    events.stop();
    expect(events.status()).toBe('idle');
    expect((init?.signal as AbortSignal).aborted).toBe(true);
  });

  it('ends the session when the stream answers 401', async () => {
    const { events, logout } = setup(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    );
    events.start();
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(events.status()).toBe('idle');
  });

  it('backs off exponentially up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});
