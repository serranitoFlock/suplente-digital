import { Component, inject, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'sd-login',
  imports: [
    FormField,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  readonly #auth = inject(AuthService);
  readonly #router = inject(Router);

  protected readonly model = signal({ token: '' });
  protected readonly loginForm = form(this.model, (path) => {
    required(path.token, { message: 'Ingrese el token de administración' });
  });
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected onSubmit(event: Event): void {
    event.preventDefault();
    void submit(this.loginForm, async () => {
      this.busy.set(true);
      this.error.set('');
      const message = await this.#auth.login(this.model().token);
      this.busy.set(false);
      if (message !== undefined) {
        this.error.set(message);
        return;
      }
      await this.#router.navigateByUrl('/aprobaciones');
    });
  }
}
