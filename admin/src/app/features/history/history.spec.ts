import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { AdminEvent, JobView } from '../../core/api/api.types';
import { AdminEvents, EventsStatus } from '../../core/events/admin-events.service';
import { History } from './history';
import { JobDetailDialog } from './job-detail-dialog';

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
  status: 'done',
  createdAt: `2026-10-11T10:0${id}:00.000Z`,
  updatedAt: `2026-10-11T10:0${id}:00.000Z`,
  route: 'question',
  answer: `Respuesta ${id}`,
  ...overrides,
});

const XSS = '<img src=x onerror=alert(1)>';

describe('History', () => {
  let fixture: ComponentFixture<History>;
  let backend: HttpTestingController;
  let events: FakeAdminEvents;
  const dialog = { open: vi.fn() };

  const el = () => fixture.nativeElement as HTMLElement;
  const rows = () =>
    [...el().querySelectorAll('tr.history__row')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim()),
    );
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };
  const expectRequest = (url: string) =>
    vi.waitFor((): TestRequest =>
      backend.expectOne((req) => req.method === 'GET' && req.urlWithParams === url),
    );

  async function render(jobs: JobView[]) {
    fixture = TestBed.createComponent(History);
    (await expectRequest('/v1/jobs')).flush({ jobs });
    await settle();
  }

  beforeEach(() => {
    dialog.open.mockReset();
    events = new FakeAdminEvents();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AdminEvents, useValue: events },
        { provide: MatDialog, useValue: dialog },
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      ],
    });
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('renders every job newest first with Spanish status labels', async () => {
    await render([
      job(1),
      job(3, { status: 'failed', requester: 'beto' }),
      job(2, { status: 'needs_approval' }),
    ]);
    expect(rows()).toEqual([
      ['3', expect.any(String), 'beto', 'Pregunta 3', 'Falló'],
      ['2', expect.any(String), 'ana', 'Pregunta 2', 'Esperando aprobación'],
      ['1', expect.any(String), 'ana', 'Pregunta 1', 'Respondida'],
    ]);
    expect(el().querySelector('table[aria-label="Pedidos"]')).not.toBeNull();
  });

  it('filters by free text over the answer', async () => {
    await render([job(1), job(2, { answer: 'Se purga desde la consola del CDN' })]);
    const input = el().querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'cdn';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(rows().map((row) => row[0])).toEqual(['2']);

    input.value = 'nada parecido';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(el().textContent).toContain('Ningún pedido coincide con los filtros');
  });

  it('opens the detail with the job on row click and from the keyboard-reachable button', async () => {
    await render([job(1)]);
    el().querySelector<HTMLElement>('tr.history__row')!.click();
    expect(dialog.open).toHaveBeenCalledWith(
      JobDetailDialog,
      expect.objectContaining({ data: job(1) }),
    );
    el()
      .querySelector<HTMLButtonElement>('button[aria-label="Ver el detalle del pedido #1"]')!
      .click();
    expect(dialog.open).toHaveBeenCalledTimes(2);
  });

  it('patches the affected row from a live event, reading the job in full', async () => {
    await render([job(1), job(2, { status: 'running', answer: undefined })]);
    events.source.next({ type: 'done', data: { id: 2, question: 'Pregunta 2', answer: 'listo' } });
    (await expectRequest('/v1/jobs/2')).flush(job(2, { answer: 'listo' }));
    await settle();
    expect(rows()[0]).toEqual(['2', expect.any(String), 'ana', 'Pregunta 2', 'Respondida']);

    events.source.next({
      type: 'needs_approval',
      data: { id: 4, question: 'Pregunta 4', draft: 'b' },
    });
    (await expectRequest('/v1/jobs/4')).flush(job(4, { status: 'needs_approval' }));
    await settle();
    expect(rows().map((row) => row[0])).toEqual(['4', '2', '1']);
  });

  it('shows the empty and error states', async () => {
    await render([]);
    expect(el().textContent).toContain('Todavía no hay pedidos');

    fixture.destroy();
    fixture = TestBed.createComponent(History);
    (await expectRequest('/v1/jobs')).flush(null, { status: 500, statusText: 'Error' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'No se pudo cargar el historial',
    );
  });
});

describe('JobDetailDialog', () => {
  it('renders answer, draft and error as plain text', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MAT_DIALOG_DATA,
          useValue: job(7, {
            status: 'failed',
            requester: 'beto',
            answer: `Respuesta ${XSS}`,
            draft: `Borrador ${XSS}`,
            error: `Error ${XSS}`,
          }),
        },
      ],
    });
    const fixture = TestBed.createComponent(JobDetailDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Pedido #7');
    expect(el.textContent).toContain('beto');
    expect(el.textContent).toContain('Falló');
    for (const selector of ['.detail__answer', '.detail__draft', '.detail__error']) {
      expect(el.querySelector(selector)?.textContent).toContain(XSS);
    }
    expect(el.querySelector('img')).toBeNull();
  });
});
