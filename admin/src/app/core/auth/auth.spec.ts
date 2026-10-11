import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { authGuard, guestGuard } from './auth.guards';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

@Component({ template: '' })
class Blank {}

const TOKEN_KEY = 'sd.adminToken';

function setup(storedToken?: string) {
  sessionStorage.clear();
  if (storedToken) sessionStorage.setItem(TOKEN_KEY, storedToken);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    auth: TestBed.inject(AuthService),
    http: TestBed.inject(HttpClient),
    backend: TestBed.inject(HttpTestingController),
    router: TestBed.inject(Router),
  };
}

const runGuard = (guard: typeof authGuard) =>
  TestBed.runInInjectionContext(() =>
    guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );

afterEach(() => sessionStorage.clear());

describe('authGuard / guestGuard', () => {
  it('sends a visitor without a session to the login page', () => {
    setup();
    const result = runGuard(authGuard);
    expect(result instanceof UrlTree && result.toString()).toBe('/login');
    expect(runGuard(guestGuard)).toBe(true);
  });

  it('lets a session in and keeps it away from the login page', () => {
    setup('admin-token');
    expect(runGuard(authGuard)).toBe(true);
    const result = runGuard(guestGuard);
    expect(result instanceof UrlTree && result.toString()).toBe('/aprobaciones');
  });
});

describe('authInterceptor', () => {
  it('adds the bearer token to API calls only', () => {
    const { http, backend } = setup('admin-token');
    void firstValueFrom(http.get('/v1/pending'));
    void firstValueFrom(http.get('/assets/x.json'));
    expect(backend.expectOne('/v1/pending').request.headers.get('Authorization')).toBe(
      'Bearer admin-token',
    );
    expect(backend.expectOne('/assets/x.json').request.headers.has('Authorization')).toBe(false);
  });

  it('clears the session and goes to the login page on a 401', async () => {
    const { http, backend, auth, router } = setup('revoked-token');
    const call = firstValueFrom(http.get('/v1/pending')).catch((error: unknown) => error);
    backend
      .expectOne('/v1/pending')
      .flush(
        { error: { code: 'unauthorized', message: 'x' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    await call;
    await TestBed.inject(Router).navigated;
    await new Promise((resolve) => setTimeout(resolve));
    expect(auth.isLoggedIn()).toBe(false);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(router.url).toBe('/login');
  });

  it('does not end the session on other errors', async () => {
    const { http, backend, auth } = setup('admin-token');
    const call = firstValueFrom(http.get('/v1/pending')).catch(() => undefined);
    backend.expectOne('/v1/pending').flush(null, { status: 500, statusText: 'Error' });
    await call;
    expect(auth.isLoggedIn()).toBe(true);
  });
});

describe('AuthService.login', () => {
  async function attempt(status: number) {
    const { auth, backend } = setup();
    const result = auth.login('  pasted-token  ');
    const request = backend.expectOne((req) => req.url === '/v1/jobs');
    expect(request.request.params.get('status')).toBe('needs_approval');
    expect(request.request.headers.get('Authorization')).toBe('Bearer pasted-token');
    if (status === 200) request.flush({ jobs: [] });
    else request.flush({ error: { code: 'x', message: 'x' } }, { status, statusText: 'x' });
    return { message: await result, auth };
  }

  it('stores the token in sessionStorage after the admin endpoint accepts it', async () => {
    const { message, auth } = await attempt(200);
    expect(message).toBeUndefined();
    expect(auth.token()).toBe('pasted-token');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('pasted-token');
  });

  it('rejects an invalid token (401) without storing it', async () => {
    const { message, auth } = await attempt(401);
    expect(message).toBe('Token inválido');
    expect(auth.isLoggedIn()).toBe(false);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('rejects the client token (403 on an admin endpoint)', async () => {
    const { message, auth } = await attempt(403);
    expect(message).toBe('Ese token no es de administrador');
    expect(auth.isLoggedIn()).toBe(false);
  });

  it('logout clears the token', () => {
    const { auth } = setup('admin-token');
    auth.logout();
    expect(auth.token()).toBeUndefined();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
