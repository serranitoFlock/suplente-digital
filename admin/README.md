# Panel de administración

Panel web para la persona que hace de suplente humano: trabaja la cola de aprobaciones con el borrador a la vista, revisa el historial de pedidos y ve lo que el bot no supo responder. Es un cliente de la [API HTTP](../README.md#api-http) con el scope **admin**; no agrega capacidades a la API.

Angular 22 (componentes standalone, signals, Signal Forms) + Angular Material 22 (tema Material 3 que sigue el modo claro u oscuro del sistema).

## Cómo correrlo en local

Requiere Node 22.13 o superior.

1. En la raíz del repo, levantar la API con los dos tokens (generarlos con `openssl rand -hex 32`):

   ```bash
   ASSISTANT_API_TOKEN=<token-cliente> ASSISTANT_ADMIN_TOKEN=<token-admin> npm run serve
   ```

   La API escucha en `http://127.0.0.1:8787`.

2. En otra terminal, levantar el panel:

   ```bash
   cd admin
   npm ci
   npm start
   ```

   Abrir `http://localhost:4200`. El servidor de desarrollo reenvía `/v1` y `/health` a la API (`proxy.conf.json`), así que la API no necesita CORS.

3. Ingresar con el token de **administración** (`ASSISTANT_ADMIN_TOKEN`). El token de cliente no sirve para entrar: la API responde 403 y el panel muestra "Ese token no es de administrador".

El token queda solo en `sessionStorage` de esa pestaña: se borra al cerrarla o con "Cerrar sesión", y si la API responde 401 (por ejemplo, porque el token cambió) el panel vuelve a la pantalla de ingreso.

## Qué cubre (U1)

- **Ingreso** con el token de administración, validado contra un endpoint solo de admin.
- **Aprobaciones**: los pedidos en `needs_approval` con la pregunta, quién la hizo, la hora y el borrador de respuesta (mostrado siempre como texto, nunca como HTML). Aprobar o rechazar con una nota opcional (la nota la ve quien preguntó). Si otro ya lo decidió, se muestra "Ya fue decidido" y se actualiza la lista; si el pedido no existe, "Ya no existe".
- **En vivo**: el panel escucha `GET /v1/events` (SSE) con `fetch` y el header `Authorization`, porque `EventSource` no puede enviarlo. Los pedidos nuevos que esperan aprobación aparecen solos (el panel lee el trabajo completo con `GET /v1/jobs/:id`, porque el evento no trae la hora) y los que terminan (`done` / `failed`) desaparecen. Si la conexión se corta, reintenta con espera creciente (1 s, 2 s, 4 s… hasta 30 s). La barra superior muestra el estado de la conexión.

## Qué agrega U2

- **Historial** (`/historial`): todos los pedidos (`GET /v1/jobs`) en una tabla, del más nuevo al más viejo, con filtros por estado, por solicitante (los que aparecen en la lista) y por texto libre sobre la pregunta y la respuesta (sin distinguir mayúsculas ni tildes), orden por fecha y paginado. Filtrar, ordenar y paginar se hace en el navegador sobre la lista completa. Al hacer clic en una fila (o en el número del pedido, accesible con teclado) se abre el detalle: solicitante, estado, ruta, fechas, pregunta, respuesta, borrador y error, siempre como texto. En vivo: cada evento `done` / `failed` / `needs_approval` relee el pedido con `GET /v1/jobs/:id` y actualiza (o agrega) su fila.
- **Sin responder** (`/sin-responder`): la vista de "bienvenido de vuelta" a partir de `GET /v1/pending/summary`. Agrupa los pendientes por tema, destaca las preguntas que el bot no supo responder (la documentación no lo cubre o es una tarea no soportada) y los docs sugeridos para escribir (`knowledge/<tema>.md`), y después muestra las escalaciones (aprobada / rechazada, con la nota), las fallas de herramientas y los rechazos de seguridad. No se actualiza en vivo: usar "Actualizar".

## Comandos

| Comando | Qué hace |
|---------|----------|
| `npm start` | Servidor de desarrollo con el proxy a la API |
| `npm run build` | Build de producción en `dist/admin` |
| `npm test` | Tests (Vitest + jsdom) en modo watch |
| `npm run test:ci` | Tests una sola vez (lo que corre CI) |

Los tests no usan la API real: las llamadas HTTP se simulan con `HttpTestingController` y el stream de eventos con una fuente falsa. Corren en Node con jsdom, sin navegador.

## Estructura

| Ruta | Qué hay |
|------|---------|
| `src/app/core/api/` | Tipos de la API, clientes (`JobsApi`, `PendingApi`), mensajes de error |
| `src/app/core/auth/` | `AuthService` (token en `sessionStorage`), interceptor, guards |
| `src/app/core/events/` | Parser SSE (función pura) y `AdminEvents` (fetch + reconexión) |
| `src/app/layout/` | Barra superior, navegación, estado de la conexión |
| `src/app/features/login/` | Pantalla de ingreso |
| `src/app/features/approvals/` | Cola de aprobaciones y diálogo de decisión |
| `src/app/features/history/` | Historial: filtros como funciones puras, tabla, diálogo de detalle |
| `src/app/features/unanswered/` | Sin responder: pendientes agrupados por tema |

## Pendiente

Servirlo en producción (build estático detrás del mismo proxy inverso con TLS y una Content-Security-Policy) es una tarea posterior; por ahora se usa solo con el servidor de desarrollo. Ver [`docs/security.md`](../docs/security.md#admin-panel-admin).
