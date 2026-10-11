import { Component, computed, DestroyRef, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { AdminEvents } from '../core/events/admin-events.service';

const STATUS_LABELS = {
  idle: 'Sin conexión en vivo',
  connecting: 'Conectando…',
  open: 'En vivo',
  reconnecting: 'Reconectando…',
} as const;

/** Authenticated layout: top bar, navigation and the live events connection for the whole session. */
@Component({
  selector: 'sd-shell',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatToolbarModule,
    MatTooltipModule,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  readonly #auth = inject(AuthService);
  readonly #events = inject(AdminEvents);

  protected readonly liveStatus = computed(() => this.#events.status());
  protected readonly liveLabel = computed(() => STATUS_LABELS[this.liveStatus()]);

  constructor() {
    this.#events.start();
    inject(DestroyRef).onDestroy(() => this.#events.stop());
  }

  protected logout(): void {
    this.#events.stop();
    this.#auth.logout();
  }
}
