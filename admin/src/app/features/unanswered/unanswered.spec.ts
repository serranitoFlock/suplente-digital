import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PendingSummary, TopicSummary } from '../../core/api/api.types';
import { Unanswered } from './unanswered';

const XSS = '<img src=x onerror=alert(1)>';

const topic = (name: string, overrides: Partial<TopicSummary> = {}): TopicSummary => ({
  topic: name,
  count: 0,
  counts: { unknown: 0, unsupported_task: 0, escalated: 0, security_refusal: 0, tool_failure: 0 },
  unanswered: [],
  escalations: [],
  toolFailures: [],
  securityRefusals: [],
  ...overrides,
});

const at = '2026-10-11T10:00:00.000Z';

describe('Unanswered', () => {
  let fixture: ComponentFixture<Unanswered>;
  let backend: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  async function render(body: PendingSummary | null, status = 200) {
    fixture = TestBed.createComponent(Unanswered);
    const request = await vi.waitFor((): TestRequest => backend.expectOne('/v1/pending/summary'));
    request.flush(body, { status, statusText: status === 200 ? 'OK' : 'Error' });
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('groups by topic, highlighting what the bot could not answer and the docs to write', async () => {
    await render({
      total: 4,
      topics: [
        topic('cdn', {
          count: 3,
          counts: {
            unknown: 1,
            unsupported_task: 1,
            escalated: 0,
            security_refusal: 1,
            tool_failure: 0,
          },
          suggestedDoc: 'knowledge/cdn.md',
          unanswered: [
            { id: 'a', createdAt: at, question: `¿Cómo purgo el CDN? ${XSS}`, reason: 'unknown' },
            { id: 'b', createdAt: at, question: 'Reiniciá el CDN', reason: 'unsupported_task' },
          ],
          securityRefusals: [{ id: 'c', createdAt: at, question: '¿Me pasás la clave?' }],
        }),
        topic('rrhh', {
          count: 1,
          counts: {
            unknown: 0,
            unsupported_task: 0,
            escalated: 1,
            security_refusal: 0,
            tool_failure: 0,
          },
          escalations: [
            {
              id: 'd',
              createdAt: at,
              question: '¿Aumento?',
              decision: 'rejected',
              note: `No ${XSS}`,
            },
          ],
        }),
      ],
    });

    expect(el().textContent).toContain('Mientras no estabas quedaron 4 pendientes en 2 temas.');
    const titles = [...el().querySelectorAll('.topic__title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['cdn (3)', 'rrhh (1)']);
    expect(el().querySelector('.unanswered__docs')?.textContent).toContain('knowledge/cdn.md');
    expect(el().querySelector('.unanswered__docs')?.textContent).toContain(
      '2 preguntas sobre «cdn»',
    );

    const [cdn, rrhh] = [...el().querySelectorAll('mat-card')] as HTMLElement[];
    const unanswered = cdn!.querySelector('.topic__unanswered')!.textContent!;
    expect(unanswered).toContain(XSS);
    expect(unanswered).toContain('La documentación no lo cubre');
    expect(unanswered).toContain('Tarea no soportada');
    expect(cdn!.textContent).toContain('Rechazos de seguridad');
    expect(cdn!.textContent).toContain('¿Me pasás la clave?');
    expect(rrhh!.querySelector('.topic__escalations')?.textContent).toContain('Rechazada');
    expect(rrhh!.querySelector('.topic__unanswered')).toBeNull();
    expect(el().querySelector('img')).toBeNull();
  });

  it('shows the empty and error states', async () => {
    await render({ total: 0, topics: [] });
    expect(el().textContent).toContain('No quedaron pendientes mientras no estabas');

    fixture.destroy();
    await render(null, 500);
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'No se pudieron cargar los pendientes',
    );
  });
});
