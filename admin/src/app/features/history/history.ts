import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorIntl, MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSortModule, Sort } from '@angular/material/sort';
import { MatTableModule } from '@angular/material/table';
import { AdminEvent, JobStatus, JobView } from '../../core/api/api.types';
import { JobsApi } from '../../core/api/jobs-api.service';
import { AdminEvents } from '../../core/events/admin-events.service';
import {
  filterJobs,
  pageOf,
  requestersOf,
  SortDirection,
  sortByDate,
  STATUS_LABELS,
  upsertJob,
} from './history-filters';
import { JobDetailDialog } from './job-detail-dialog';
import { SpanishPaginatorIntl } from './spanish-paginator-intl';

/** Every job (admin view), filtered, sorted and paged on the client; kept live with the events stream. */
@Component({
  selector: 'sd-history',
  imports: [
    DatePipe,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSortModule,
    MatTableModule,
  ],
  providers: [{ provide: MatPaginatorIntl, useClass: SpanishPaginatorIntl }],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History {
  readonly #api = inject(JobsApi);
  readonly #dialog = inject(MatDialog);

  protected readonly statusLabels = STATUS_LABELS;
  protected readonly statuses = Object.keys(STATUS_LABELS) as JobStatus[];
  protected readonly columns = ['id', 'createdAt', 'requester', 'question', 'status'];
  protected readonly pageSizes = [10, 25, 50];

  protected readonly list = this.#api.listResource(() => undefined);
  /** Server list, then patched by live events until the next reload. */
  protected readonly jobs = linkedSignal<JobView[]>(() =>
    this.list.hasValue() ? this.list.value().jobs : [],
  );

  protected readonly status = signal<JobStatus | undefined>(undefined);
  protected readonly requester = signal<string | undefined>(undefined);
  protected readonly text = signal('');
  protected readonly direction = signal<SortDirection>('desc');
  protected readonly pageSize = signal(25);
  /** Back to the first page whenever a filter changes. */
  protected readonly pageIndex = linkedSignal({
    source: () => [this.status(), this.requester(), this.text()],
    computation: () => 0,
  });

  protected readonly requesters = computed(() => requestersOf(this.jobs()));
  protected readonly filtered = computed(() =>
    sortByDate(
      filterJobs(this.jobs(), {
        status: this.status(),
        requester: this.requester(),
        text: this.text(),
      }),
      this.direction(),
    ),
  );
  protected readonly currentPage = computed(() =>
    Math.min(
      this.pageIndex(),
      Math.max(0, Math.ceil(this.filtered().length / this.pageSize()) - 1),
    ),
  );
  protected readonly rows = computed(() =>
    pageOf(this.filtered(), this.currentPage(), this.pageSize()),
  );

  constructor() {
    inject(AdminEvents)
      .events$.pipe(takeUntilDestroyed())
      .subscribe((event) => void this.#onEvent(event));
  }

  protected statusLabel(job: JobView): string {
    return STATUS_LABELS[job.status];
  }

  protected reload(): void {
    this.list.reload();
  }

  protected onSort(sort: Sort): void {
    this.direction.set(sort.direction === 'asc' ? 'asc' : 'desc');
  }

  protected onPage(page: PageEvent): void {
    this.pageSize.set(page.pageSize);
    this.pageIndex.set(page.pageIndex);
  }

  protected open(job: JobView): void {
    this.#dialog.open(JobDetailDialog, {
      data: job,
      width: 'min(720px, calc(100vw - 32px))',
      maxWidth: '100vw',
    });
  }

  /** Events carry only part of the job: read it in full and patch (or add) its row. */
  async #onEvent(event: AdminEvent): Promise<void> {
    if (!this.list.hasValue()) return;
    try {
      const job = await this.#api.get(event.data.id);
      this.jobs.update((jobs) => upsertJob(jobs, job));
    } catch (error) {
      // 404: gone. Anything else: the next reload shows it; the table stays as it is.
      if (!(error instanceof HttpErrorResponse)) throw error;
    }
  }
}
