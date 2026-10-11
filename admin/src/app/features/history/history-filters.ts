import { JobStatus, JobView } from '../../core/api/api.types';

/** Spanish labels for job statuses. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En cola',
  running: 'Procesando',
  needs_approval: 'Esperando aprobación',
  done: 'Respondida',
  failed: 'Falló',
};

export interface HistoryFilters {
  status?: JobStatus;
  requester?: string;
  /** Free text over question and answer (case- and accent-insensitive). */
  text?: string;
}

export type SortDirection = 'asc' | 'desc';

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function filterJobs(jobs: readonly JobView[], filters: HistoryFilters): JobView[] {
  const text = fold(filters.text?.trim() ?? '');
  return jobs.filter(
    (job) =>
      (filters.status === undefined || job.status === filters.status) &&
      (filters.requester === undefined || job.requester === filters.requester) &&
      (text === '' || fold(`${job.question}\n${job.answer ?? ''}`).includes(text)),
  );
}

/** Sorted copy by `createdAt` (ISO 8601, so string order is time order), ties by id. */
export function sortByDate(jobs: readonly JobView[], direction: SortDirection = 'desc'): JobView[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...jobs].sort((a, b) => sign * (a.createdAt.localeCompare(b.createdAt) || a.id - b.id));
}

/** One page of `size` items; an index past the end shows the last page. */
export function pageOf<T>(items: readonly T[], index: number, size: number): T[] {
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const start = Math.min(Math.max(0, index), last) * size;
  return items.slice(start, start + size);
}

export function requestersOf(jobs: readonly JobView[]): string[] {
  const names = new Set(jobs.flatMap((job) => (job.requester ? [job.requester] : [])));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Copy with `job` replacing the listed job with the same id, or appended. */
export function upsertJob(jobs: readonly JobView[], job: JobView): JobView[] {
  return jobs.some((j) => j.id === job.id)
    ? jobs.map((j) => (j.id === job.id ? job : j))
    : [...jobs, job];
}
