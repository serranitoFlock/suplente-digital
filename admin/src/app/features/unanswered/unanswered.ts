import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { EscalationItem, UnansweredItem } from '../../core/api/api.types';
import { PendingApi } from '../../core/api/pending-api.service';

const REASON_LABELS: Record<UnansweredItem['reason'], string> = {
  unknown: 'La documentación no lo cubre',
  unsupported_task: 'Tarea no soportada',
};

/**
 * "Welcome back" view of the pending log, grouped by topic: what the bot could not answer and the docs to write
 * first; escalations, tool failures and security refusals after. Every question is rendered as plain text.
 */
@Component({
  selector: 'sd-unanswered',
  imports: [DatePipe, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './unanswered.html',
  styleUrl: './unanswered.scss',
})
export class Unanswered {
  protected readonly summary = inject(PendingApi).summaryResource();
  protected readonly topics = computed(() =>
    this.summary.hasValue() ? this.summary.value().topics : [],
  );
  protected readonly suggestions = computed(() =>
    this.topics().flatMap(({ topic, suggestedDoc, counts }) =>
      suggestedDoc
        ? [{ topic, doc: suggestedDoc, questions: counts.unknown + counts.unsupported_task }]
        : [],
    ),
  );

  protected reload(): void {
    this.summary.reload();
  }

  protected reasonLabel(item: UnansweredItem): string {
    return REASON_LABELS[item.reason];
  }

  protected decisionLabel(item: EscalationItem): string {
    if (item.decision === 'approved') return 'Aprobada';
    if (item.decision === 'rejected') return 'Rechazada';
    return 'Sin decidir';
  }
}
