import { JobView } from '../../core/api/api.types';
import {
  filterJobs,
  pageOf,
  requestersOf,
  sortByDate,
  STATUS_LABELS,
  upsertJob,
} from './history-filters';

const job = (id: number, overrides: Partial<JobView> = {}): JobView => ({
  id,
  question: `Pregunta ${id}`,
  requester: 'ana',
  status: 'done',
  createdAt: `2026-10-11T10:${String(id).padStart(2, '0')}:00.000Z`,
  updatedAt: `2026-10-11T10:${String(id).padStart(2, '0')}:00.000Z`,
  ...overrides,
});

describe('STATUS_LABELS', () => {
  it('names every status in Spanish', () => {
    expect(STATUS_LABELS).toEqual({
      queued: 'En cola',
      running: 'Procesando',
      needs_approval: 'Esperando aprobación',
      done: 'Respondida',
      failed: 'Falló',
    });
  });
});

describe('filterJobs', () => {
  const jobs = [
    job(1, { status: 'done', requester: 'ana', answer: 'Se purga desde la consola del CDN' }),
    job(2, { status: 'failed', requester: 'beto', question: '¿Cuándo es la migración?' }),
    job(3, { status: 'needs_approval', requester: undefined, question: 'Pedido de aumento' }),
  ];
  const ids = (list: JobView[]) => list.map((j) => j.id);

  it('keeps everything with no filters', () => {
    expect(ids(filterJobs(jobs, {}))).toEqual([1, 2, 3]);
  });

  it('filters by status and by requester', () => {
    expect(ids(filterJobs(jobs, { status: 'failed' }))).toEqual([2]);
    expect(ids(filterJobs(jobs, { requester: 'ana' }))).toEqual([1]);
    expect(ids(filterJobs(jobs, { status: 'done', requester: 'beto' }))).toEqual([]);
  });

  it('matches free text over question and answer, ignoring case and accents', () => {
    expect(ids(filterJobs(jobs, { text: 'cdn' }))).toEqual([1]);
    expect(ids(filterJobs(jobs, { text: 'MIGRACION' }))).toEqual([2]);
    expect(ids(filterJobs(jobs, { text: '  aumento ' }))).toEqual([3]);
    expect(ids(filterJobs(jobs, { text: '   ' }))).toEqual([1, 2, 3]);
  });
});

describe('sortByDate', () => {
  it('sorts by creation date, newest first by default, ties by id', () => {
    const jobs = [job(2), job(5), job(1, { createdAt: job(5).createdAt })];
    expect(sortByDate(jobs).map((j) => j.id)).toEqual([5, 1, 2]);
    expect(sortByDate(jobs, 'asc').map((j) => j.id)).toEqual([2, 1, 5]);
    expect(jobs.map((j) => j.id)).toEqual([2, 5, 1]);
  });
});

describe('pageOf', () => {
  const jobs = Array.from({ length: 23 }, (_, i) => job(i + 1));

  it('slices one page', () => {
    expect(pageOf(jobs, 0, 10).map((j) => j.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pageOf(jobs, 2, 10).map((j) => j.id)).toEqual([21, 22, 23]);
  });

  it('clamps a page index past the end to the last page', () => {
    expect(pageOf(jobs, 9, 10).map((j) => j.id)).toEqual([21, 22, 23]);
    expect(pageOf([], 3, 10)).toEqual([]);
  });
});

describe('requestersOf', () => {
  it('lists the distinct requesters present, sorted', () => {
    expect(
      requestersOf([
        job(1, { requester: 'beto' }),
        job(2),
        job(3, { requester: undefined }),
        job(4),
      ]),
    ).toEqual(['ana', 'beto']);
  });
});

describe('upsertJob', () => {
  it('replaces a listed job and appends a new one, without mutating', () => {
    const jobs = [job(1), job(2, { status: 'running' })];
    const replaced = upsertJob(jobs, job(2, { status: 'done', answer: 'listo' }));
    expect(replaced.map((j) => [j.id, j.status])).toEqual([
      [1, 'done'],
      [2, 'done'],
    ]);
    expect(upsertJob(jobs, job(3)).map((j) => j.id)).toEqual([1, 2, 3]);
    expect(jobs[1]!.status).toBe('running');
  });
});
