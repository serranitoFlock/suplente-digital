import { HttpClient, HttpContext, HttpContextToken, HttpHeaders } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { loginErrorMessage } from '../api/api-errors';
import { JobList } from '../api/api.types';

const STORAGE_KEY = 'sd.adminToken';

/** Marks a request whose 401 must not trigger the global logout (the login check itself). */
export const SKIP_LOGOUT_ON_401 = new HttpContextToken<boolean>(() => false);

function readStored(): string | undefined {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(token: string | undefined): void {
  try {
    if (token === undefined) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage blocked (private mode, policy): the session lives only in memory.
  }
}

/**
 * Holds the admin bearer token. It is kept in `sessionStorage` only (gone when the tab closes), never in
 * `localStorage` or cookies. Login validates the token against an admin-only endpoint first.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #http = inject(HttpClient);
  readonly #router = inject(Router);
  readonly #token = signal<string | undefined>(readStored());

  readonly token = this.#token.asReadonly();
  readonly isLoggedIn = computed(() => this.#token() !== undefined);

  /** Resolves `undefined` on success, or the Spanish error message to show. */
  async login(rawToken: string): Promise<string | undefined> {
    const token = rawToken.trim();
    if (!token) return 'Ingrese el token de administración';
    try {
      await firstValueFrom(
        this.#http.get<JobList>('/v1/jobs', {
          params: { status: 'needs_approval' },
          headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
          context: new HttpContext().set(SKIP_LOGOUT_ON_401, true),
        }),
      );
    } catch (error) {
      return loginErrorMessage(error);
    }
    writeStored(token);
    this.#token.set(token);
    return undefined;
  }

  /** Clears the token and goes back to the login page. */
  logout(): void {
    writeStored(undefined);
    this.#token.set(undefined);
    void this.#router.navigateByUrl('/login');
  }
}
