import { HttpErrorResponse } from '@angular/common/http';
import { decisionErrorMessage, loginErrorMessage } from './api-errors';

const httpError = (status: number, error: unknown = null) =>
  new HttpErrorResponse({ status, error });

describe('loginErrorMessage', () => {
  it('maps 401 to an invalid token message', () => {
    expect(loginErrorMessage(httpError(401))).toBe('Token inválido');
  });

  it('maps 403 to a not-admin message, so the client token cannot log in', () => {
    expect(loginErrorMessage(httpError(403))).toBe('Ese token no es de administrador');
  });

  it('maps a network failure to a connection message', () => {
    expect(loginErrorMessage(httpError(0))).toBe(
      'No se pudo conectar con la API. ¿Está corriendo `npm run serve`?',
    );
  });

  it('falls back to a generic message with the status for anything else', () => {
    expect(loginErrorMessage(httpError(500))).toBe('Error inesperado de la API (HTTP 500)');
    expect(loginErrorMessage(new Error('boom'))).toBe('Error inesperado');
  });
});

describe('decisionErrorMessage', () => {
  it('maps 409 not_pending to "Ya fue decidido"', () => {
    expect(
      decisionErrorMessage(httpError(409, { error: { code: 'not_pending', message: 'x' } })),
    ).toBe('Ya fue decidido');
  });

  it('maps 404 to "Ya no existe"', () => {
    expect(decisionErrorMessage(httpError(404))).toBe('Ya no existe');
  });

  it('shows the API validation message for 422 and a generic message otherwise', () => {
    expect(
      decisionErrorMessage(
        httpError(422, {
          error: { code: 'validation_failed', message: 'The request is not valid.' },
        }),
      ),
    ).toBe('La nota no es válida: The request is not valid.');
    expect(decisionErrorMessage(httpError(0))).toBe('No se pudo conectar con la API');
    expect(decisionErrorMessage(httpError(500))).toBe('Error inesperado de la API (HTTP 500)');
  });
});
