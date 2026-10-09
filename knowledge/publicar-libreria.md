# Publicar una versión de una librería compartida

Las librerías Angular compartidas (por ejemplo `@acme/ui-kit` y `@acme/core`) se publican en el registry npm interno de Acme (`registry.example.com`).

## Versionado (semver)

- Versión mayor (major): cuando se rompe la API pública (se elimina o renombra un input, un servicio o un export).
- Versión menor (minor): funcionalidad nueva compatible hacia atrás.
- Parche (patch): correcciones sin cambios de API.
- Antes de una versión mayor, marcar lo viejo como `@deprecated` durante al menos una versión menor.

## Pasos para publicar

1. Actualizar el `CHANGELOG.md` con los cambios de la versión.
2. Subir la versión con `npm version <major|minor|patch>` en la carpeta de la librería.
3. Abrir un MR a `main` y esperar la aprobación de Arquitectura Frontend.
4. Al mergear, el pipeline de release ejecuta `ng build` y publica el paquete en el registry.
5. Avisar en el canal del equipo qué versión salió y si requiere cambios en los consumidores.

## Qué no hacer

- Nunca publicar a mano desde una máquina local.
- No reutilizar un número de versión ya publicado; si algo salió mal, publicar un parche nuevo.
