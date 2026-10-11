import { HttpErrorResponse } from '@angular/common/http';

/** The API error body: `{ error: { code, message } }` (validation errors add `issues`). */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

function apiMessage(error: HttpErrorResponse): string | undefined {
  const body = error.error as Partial<ApiErrorBody> | null;
  return typeof body?.error?.message === 'string' ? body.error.message : undefined;
}

const unexpected = (error: unknown) =>
  error instanceof HttpErrorResponse
    ? `Error inesperado de la API (HTTP ${error.status})`
    : 'Error inesperado';

/** User-facing text for a failed login check (`GET /v1/jobs?status=needs_approval` with the pasted token). */
export function loginErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return unexpected(error);
  switch (error.status) {
    case 401:
      return 'Token inválido';
    case 403:
      return 'Ese token no es de administrador';
    case 0:
      return 'No se pudo conectar con la API. ¿Está corriendo `npm run serve`?';
    default:
      return unexpected(error);
  }
}

/** User-facing text for a failed approve/reject. */
export function decisionErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return unexpected(error);
  switch (error.status) {
    case 409:
      return 'Ya fue decidido';
    case 404:
      return 'Ya no existe';
    case 422:
      return `La nota no es válida: ${apiMessage(error) ?? 'revise el texto'}`;
    case 0:
      return 'No se pudo conectar con la API';
    default:
      return unexpected(error);
  }
}

/** The `issues` of a 422 `validation_failed` body (dotted paths), or undefined for any other error. */
export function validationIssues(error: unknown): { path: string; message: string }[] | undefined {
  if (!(error instanceof HttpErrorResponse) || error.status !== 422) return undefined;
  const issues = (error.error as { error?: { issues?: unknown } } | null)?.error?.issues;
  if (!Array.isArray(issues))
    return [{ path: '', message: apiMessage(error) ?? 'Datos inválidos' }];
  return issues.flatMap((issue: unknown) => {
    const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
    return typeof message === 'string'
      ? [{ path: typeof path === 'string' ? path : '', message }]
      : [];
  });
}

/** User-facing text for a failed configuration request (401 already ends the session in the interceptor). */
export function configErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return unexpected(error);
  switch (error.status) {
    case 0:
      return 'No se pudo conectar con la API';
    case 401:
      return 'La sesión expiró';
    case 404:
      return 'Este servidor no tiene configuración en tiempo de ejecución';
    case 413:
      return 'El contenido es demasiado grande';
    case 422:
      return `No se guardó: ${apiMessage(error) ?? 'hay datos inválidos'}`;
    default:
      return unexpected(error);
  }
}
