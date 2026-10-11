import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService, SKIP_LOGOUT_ON_401 } from './auth.service';

/** Only same-origin API calls (proxied in dev) ever carry the token. */
const isApiRequest = (url: string) => url.startsWith('/v1/');

/** Adds the admin bearer token to API calls; a 401 (token revoked or rotated) ends the session. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiRequest(req.url)) return next(req);
  const auth = inject(AuthService);
  const token = auth.token();
  const request =
    token && !req.headers.has('Authorization')
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;
  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !req.context.get(SKIP_LOGOUT_ON_401)
      )
        auth.logout();
      return throwError(() => error);
    }),
  );
};
