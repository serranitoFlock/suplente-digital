# Crear un web component con Angular Elements

Los web components de Acme son componentes Angular empaquetados como Custom Elements con Angular Elements. Cada uno vive en su propio repositorio con el sufijo `-elements` (por ejemplo `acme-card-elements`).

## Convenciones de nombre

- El tag del custom element siempre usa el prefijo `acme-` (por ejemplo `<acme-card>`).
- El repositorio se llama igual que el tag más el sufijo `-elements`.
- Los inputs públicos se exponen como atributos en kebab-case (`variant`, `show-footer`).

## Pasos para crear uno nuevo

1. Generar el repositorio desde la plantilla `acme-elements-template`.
2. Crear el componente standalone y registrarlo en `main.ts` con `createCustomElement(MiComponente, { injector })` y `customElements.define('acme-mi-componente', elemento)`.
3. Ejecutar `npm run build:elements`, que genera un único `bundle.js` en `dist/`.
4. Probarlo localmente con `npm run serve:elements` y la página `demo/index.html`.
5. Abrir un MR; el pipeline de CI corre lint, tests y `build:elements`.

## Buenas prácticas

- No usar estilos globales: los estilos van encapsulados en el componente.
- No acceder a `window` para comunicarse con el shell; usar eventos (`CustomEvent`) con prefijo `acme:`.
- Mantener el bundle chico: evitar importar librerías completas si solo se usa una función.
