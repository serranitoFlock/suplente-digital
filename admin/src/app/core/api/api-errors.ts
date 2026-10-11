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
