import { Component, computed, inject, signal } from '@angular/core';
import { form, FormField, maxLength } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { JobView } from '../../core/api/api.types';
import { Decision } from '../../core/api/jobs-api.service';

export interface DecisionDialogData {
  job: JobView;
  decision: Decision;
}

/** Closes with `{ note }` to confirm, or with nothing when cancelled. */
export interface DecisionDialogResult {
  note: string;
}

const MAX_NOTE = 4000;

@Component({
  selector: 'sd-decision-dialog',
  imports: [FormField, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ title() }}</h2>
    <form novalidate (submit)="confirm($event)">
      <mat-dialog-content>
        <p class="question">{{ data.job.question }}</p>
        <mat-form-field appearance="outline" class="note">
          <mat-label>Nota (opcional)</mat-label>
          <textarea matInput rows="4" cdkFocusInitial [formField]="noteForm.note"></textarea>
          <mat-hint>{{ hint() }}</mat-hint>
          @if (noteForm.note().invalid()) {
            <mat-error>{{ noteForm.note().errors()[0]?.message }}</mat-error>
          }
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Cancelar</button>
        <button
          mat-flat-button
          type="submit"
          [class.reject]="data.decision === 'reject'"
          [disabled]="noteForm.note().invalid()"
        >
          {{ confirmLabel() }}
        </button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .question {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--mat-sys-on-surface-variant);
    }
    .note {
      width: 100%;
    }
    .reject {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class DecisionDialog {
  protected readonly data = inject<DecisionDialogData>(MAT_DIALOG_DATA);
  readonly #ref = inject<MatDialogRef<DecisionDialog, DecisionDialogResult>>(MatDialogRef);

  protected readonly model = signal({ note: '' });
  protected readonly noteForm = form(this.model, (path) => {
    maxLength(path.note, MAX_NOTE, { message: `La nota admite hasta ${MAX_NOTE} caracteres` });
  });

  protected readonly title = computed(() =>
    this.data.decision === 'approve'
      ? `Aprobar el pedido #${this.data.job.id}`
      : `Rechazar el pedido #${this.data.job.id}`,
  );
  protected readonly confirmLabel = computed(() =>
    this.data.decision === 'approve' ? 'Aprobar' : 'Rechazar',
  );
  protected readonly hint = computed(() =>
    this.data.decision === 'approve'
      ? 'Se envía el borrador a quien preguntó. La nota, si la escribe, se agrega al final y la ve esa persona.'
      : 'No se envía el borrador: quien preguntó recibe un aviso de que queda para la persona responsable. La nota, si la escribe, la ve esa persona.',
  );

  protected confirm(event: Event): void {
    event.preventDefault();
    if (this.noteForm.note().invalid()) return;
    this.#ref.close({ note: this.model().note });
  }
}
