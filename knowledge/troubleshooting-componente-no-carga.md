# Troubleshooting: el componente no carga

Checklist cuando un web component no aparece en el shell.

## 1. Revisar la consola del navegador

- Error 404 sobre `bundle.js`: la versión del manifiesto apunta a un bundle que no existe en el CDN. Verificar que el job `deploy:cdn-qa` (o el de prod) haya terminado bien.
- Error `Failed to execute 'define' on 'CustomElementRegistry'`: el tag se está registrando dos veces; revisar que el bundle no esté incluido dos veces en el manifiesto o en el shell.

## 2. Revisar el manifiesto

- Confirmar que el tag del componente existe en el manifiesto del ambiente correcto.
- Confirmar que la versión del manifiesto coincide con la publicada.

## 3. Caché

- El CDN cachea el manifiesto hasta 5 minutos. Probar con recarga forzada o en ventana privada.

## 4. Inputs y eventos

- Si el componente carga pero se ve vacío, revisar que los atributos estén en kebab-case y que los datos se pasen como string JSON cuando son objetos.

## Si nada de esto funciona

Abrir un ticket en el proyecto DEMO con la URL, el ambiente, la versión del manifiesto y una captura de la consola.
