import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { decisionErrorMessage } from '../../core/api/api-errors';
import { AdminEvent, JobView, NeedsApprovalEventData } from '../../core/api/api.types';
import { Decision, JobsApi } from '../../core/api/jobs-api.service';
import { AdminEvents } from '../../core/events/admin-events.service';
import { DecisionDialog, DecisionDialogData, DecisionDialogResult } from './decision-dialog';

const byOldestFirst = (a: JobView, b: JobView) =>
  a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/** The approval queue: jobs in `needs_approval`, kept live with the events stream. */
@Component({
  selector: 'sd-approvals',
  imports: [DatePipe, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './approvals.html',
  styleUrl: './approvals.scss',
})
export class Approvals {
  readonly #api = inject(JobsApi);
  readonly #dialog = inject(MatDialog);
  readonly #snackBar = inject(MatSnackBar);
  readonly #announcer = inject(LiveAnnouncer);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly pending = this.#api.listResource(() => 'needs_approval');
  /** Server list, then patched locally by decisions and live events until the next reload. */
  protected readonly jobs = linkedSignal(() =>
    this.pending.hasValue() ? [...this.pending.value().jobs].sort(byOldestFirst) : [],
  );
  protected readonly busy = signal<ReadonlySet<number>>(new Set());

  constructor() {
    inject(AdminEvents)
      .events$.pipe(takeUntilDestroyed())
      .subscribe((event) => void this.#onEvent(event));
  }

  protected reload(): void {
    this.pending.reload();
  }

  protected async decide(job: JobView, decision: Decision): Promise<void> {
    const dialog = this.#dialog.open<DecisionDialog, DecisionDialogData, DecisionDialogResult>(
      DecisionDialog,
      {
        data: { job, decision },
        width: 'min(560px, calc(100vw - 32px))',
        maxWidth: '100vw',
      },
    );
    const result = await firstValueFrom(dialog.afterClosed());
    if (!result) return;

    this.#setBusy(job.id, true);
    try {
      await this.#api.decide(job.id, decision, result.note);
      this.#remove(job.id);
      this.#notify(
        decision === 'approve' ? `Pedido #${job.id} aprobado` : `Pedido #${job.id} rechazado`,
      );
    } catch (error) {
      this.#notify(decisionErrorMessage(error));
      if (error instanceof HttpErrorResponse && (error.status === 404 || error.status === 409)) {
        this.#remove(job.id);
        this.pending.reload();
      }
    } finally {
      this.#setBusy(job.id, false);
    }
  }

  async #onEvent(event: AdminEvent): Promise<void> {
    if (event.type !== 'needs_approval') {
      this.#remove(event.data.id, false);
      return;
    }
    if (this.#isListed(event.data.id)) return;
    const job = await this.#fetchJob(event.data);
    if (!job || job.status !== 'needs_approval' || this.#isListed(job.id)) return;
    this.jobs.update((jobs) => [...jobs, job].sort(byOldestFirst));
    this.#announcer.announce(`Nuevo pedido esperando aprobación: #${job.id}`);
  }

  /** The event lacks timestamps: read the full job. If that fails (other than 404), show the event as is. */
  async #fetchJob(data: NeedsApprovalEventData): Promise<JobView | undefined> {
    try {
      return await this.#api.get(data.id);
    } catch (error) {
      if (error instanceof HttpErrorResponse && (error.status === 404 || error.status === 401))
        return undefined;
      const receivedAt = new Date().toISOString();
      return { ...data, status: 'needs_approval', createdAt: receivedAt, updatedAt: receivedAt };
    }
  }

  #isListed(id: number): boolean {
    return this.jobs().some((job) => job.id === id);
  }

  /** Removes a job; after a decision, focus moves to the page heading (the card and its buttons are gone). */
  #remove(id: number, moveFocus = true): void {
    if (!this.#isListed(id)) return;
    this.jobs.update((jobs) => jobs.filter((job) => job.id !== id));
    if (moveFocus) this.heading().nativeElement.focus();
  }

  #setBusy(id: number, busy: boolean): void {
    this.busy.update((ids) => {
      const next = new Set(ids);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  #notify(message: string): void {
    this.#snackBar.open(message, 'Cerrar', { duration: 6000 });
  }
}
