# Desplegar una versión de un componente en el CDN

El shell de Acme carga los web components desde `cdn.example.com`. Qué versión carga cada ambiente lo define el manifiesto de versiones (`manifest.json`) de ese ambiente.

## Estructura del manifiesto

Cada entrada del manifiesto tiene el tag del componente, la versión y la URL del bundle:

```json
{ "acme-card": { "version": "1.3.0", "url": "https://cdn.example.com/wcs/acme-card/1.3.0/bundle.js" } }
```

Hay un manifiesto por ambiente: `dev`, `qa` y `prod`.

## Pasos para desplegar en QA

1. Verificar que el pipeline del componente haya publicado el bundle de la versión en el CDN (job `deploy:cdn-qa`).
2. Actualizar la versión del componente en el manifiesto de QA mediante un MR al repositorio `acme-cdn-manifests`.
3. Al mergear, el manifiesto se publica y el shell de QA toma la versión nueva (puede tardar hasta 5 minutos por caché).

## Producción

El cambio del manifiesto de producción solo lo aprueba Arquitectura Frontend, después de la validación funcional en QA. El suplente digital nunca modifica manifiestos.

## Rollback

Para volver atrás, se cambia la versión en el manifiesto a la anterior; los bundles viejos nunca se borran del CDN.
