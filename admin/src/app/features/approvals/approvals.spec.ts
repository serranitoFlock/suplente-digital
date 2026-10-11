import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of, Subject } from 'rxjs';
import { AdminEvent, JobView } from '../../core/api/api.types';
import { AdminEvents, EventsStatus } from '../../core/events/admin-events.service';
import { Approvals } from './approvals';

class FakeAdminEvents extends AdminEvents {
  readonly source = new Subject<AdminEvent>();
  readonly events$ = this.source.asObservable();
  readonly status = signal<EventsStatus>('open');
  start(): void {}
  stop(): void {}
}

const job = (id: number, overrides: Partial<JobView> = {}): JobView => ({
  id,
  question: `Pregunta ${id}`,
  requester: 'ana',
  status: 'needs_approval',
  createdAt: `2026-10-11T10:0${id}:00.000Z`,
  updatedAt: `2026-10-11T10:0${id}:00.000Z`,
  route: 'sensitive',
  draft: `Borrador ${id} <img src=x onerror=alert(1)>`,
  ...overrides,
});

describe('Approvals', () => {
  let fixture: ComponentFixture<Approvals>;
  let backend: HttpTestingController;
  let events: FakeAdminEvents;
  let dialogResult: { note: string } | undefined;
  const snackBar = { open: vi.fn() };

  const el = () => fixture.nativeElement as HTMLElement;
  const cards = () =>
    [...el().querySelectorAll('mat-card')].map((card) =>
      card.querySelector('mat-card-title')?.textContent?.trim(),
    );
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };
  const expectRequest = (method: string, url: string) =>
    vi.waitFor(
      (): TestRequest =>
        backend.expectOne((req) => req.method === method && req.urlWithParams === url),
    );
  const button = (label: string) =>
    el().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  async function render(jobs: JobView[]) {
    fixture = TestBed.createComponent(Approvals);
    (await expectRequest('GET', '/v1/jobs?status=needs_approval')).flush({ jobs });
    await settle();
  }

  beforeEach(() => {
    dialogResult = { note: '  ok, adelante  ' };
    snackBar.open.mockReset();
    events = new FakeAdminEvents();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AdminEvents, useValue: events },
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(dialogResult) }) } },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      ],
    });
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('renders pending jobs oldest first, with the draft as plain text', async () => {
    await render([job(2), job(1)]);
    expect(cards()).toEqual(['Pedido #1 · ana', 'Pedido #2 · ana']);
    const draft = el().querySelector('.job__draft')!;
    expect(draft.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(draft.querySelector('img')).toBeNull();
  });

  it('shows the empty state', async () => {
    await render([]);
    expect(el().textContent).toContain('No hay pedidos esperando aprobación');
  });

  it('approves with the trimmed note, removes the job and confirms', async () => {
    await render([job(1)]);
    button('Aprobar el pedido #1').click();
    const request = await expectRequest('POST', '/v1/jobs/1/approve');
    expect(request.request.body).toEqual({ note: 'ok, adelante' });
    request.flush({ result: 'accepted' });
    await settle();
    expect(cards()).toEqual([]);
    expect(snackBar.open).toHaveBeenCalledWith('Pedido #1 aprobado', 'Cerrar', expect.anything());
  });

  it('does nothing when the dialog is cancelled', async () => {
    await render([job(1)]);
    dialogResult = undefined;
    button('Rechazar el pedido #1').click();
    await settle();
    backend.expectNone((req) => req.method === 'POST');
    expect(cards()).toEqual(['Pedido #1 · ana']);
  });

  it('on 409 shows "Ya fue decidido" and refreshes the list', async () => {
    await render([job(1), job(2)]);
    button('Rechazar el pedido #1').click();
    (await expectRequest('POST', '/v1/jobs/1/reject')).flush(
      { error: { code: 'not_pending', message: 'Job #1 is not waiting for approval.' } },
      { status: 409, statusText: 'Conflict' },
    );
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith('Ya fue decidido', 'Cerrar', expect.anything()),
    );
    (await expectRequest('GET', '/v1/jobs?status=needs_approval')).flush({ jobs: [job(2)] });
    await settle();
    expect(cards()).toEqual(['Pedido #2 · ana']);
  });

  it('adds live needs_approval jobs (read in full) and removes listed jobs on done/failed', async () => {
    await render([job(1)]);
    events.source.next({
      type: 'needs_approval',
      data: { id: 3, requester: 'beto', question: 'Pregunta 3', draft: 'Borrador 3' },
    });
    (await expectRequest('GET', '/v1/jobs/3')).flush(job(3, { requester: 'beto' }));
    await settle();
    expect(cards()).toEqual(['Pedido #1 · ana', 'Pedido #3 · beto']);

    events.source.next({ type: 'done', data: { id: 1, question: 'Pregunta 1', answer: 'listo' } });
    events.source.next({
      type: 'failed',
      data: { id: 3, question: 'Pregunta 3', message: 'm', error: 'e' },
    });
    await settle();
    expect(cards()).toEqual([]);
  });

  it('ignores a live event for a job that is no longer waiting', async () => {
    await render([]);
    events.source.next({
      type: 'needs_approval',
      data: { id: 4, question: 'Pregunta 4', draft: 'b' },
    });
    (await expectRequest('GET', '/v1/jobs/4')).flush(job(4, { status: 'running' }));
    await settle();
    expect(cards()).toEqual([]);
  });
});
