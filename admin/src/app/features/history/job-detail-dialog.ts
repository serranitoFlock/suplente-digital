import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { JobView } from '../../core/api/api.types';
import { STATUS_LABELS } from './history-filters';

/** Read-only detail of one job. Answer, draft and error are model/tool text: plain text only, never HTML. */
@Component({
  selector: 'sd-job-detail-dialog',
  imports: [DatePipe, MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Pedido #{{ job.id }}</h2>
    <mat-dialog-content>
      <dl class="detail__meta">
        <dt>Solicitante</dt>
        <dd>{{ job.requester ?? 'sin solicitante' }}</dd>
        <dt>Estado</dt>
        <dd>{{ statusLabel }}</dd>
        <dt>Ruta</dt>
        <dd>{{ job.route ?? '—' }}</dd>
        <dt>Creado</dt>
        <dd>
          <time [attr.datetime]="job.createdAt">{{
            job.createdAt | date: 'dd/MM/yyyy HH:mm:ss'
          }}</time>
        </dd>
        <dt>Actualizado</dt>
        <dd>
          <time [attr.datetime]="job.updatedAt">{{
            job.updatedAt | date: 'dd/MM/yyyy HH:mm:ss'
          }}</time>
        </dd>
      </dl>
      <h3 class="detail__label">Pregunta</h3>
      <p class="detail__text detail__question">{{ job.question }}</p>
      @if (job.answer !== undefined) {
        <h3 class="detail__label">Respuesta</h3>
        <p class="detail__text detail__answer">{{ job.answer }}</p>
      }
      @if (job.draft !== undefined) {
        <h3 class="detail__label">Borrador</h3>
        <p class="detail__text detail__draft">{{ job.draft }}</p>
      }
      @if (job.error !== undefined) {
        <h3 class="detail__label">Error</h3>
        <p class="detail__text detail__error">{{ job.error }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close cdkFocusInitial>Cerrar</button>
    </mat-dialog-actions>
  `,
  styles: `
    .detail__meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 16px;
      margin: 0 0 8px;
    }
    dt {
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
    }
    .detail__label {
      margin: 16px 0 4px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .detail__text {
      margin: 0;
      padding: 12px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container-high);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .detail__error {
      color: var(--mat-sys-error);
    }
  `,
})
export class JobDetailDialog {
  protected readonly job = inject<JobView>(MAT_DIALOG_DATA);
  protected readonly statusLabel = STATUS_LABELS[this.job.status];
}
