# Glosario de abreviaturas y sinónimos

Palabras informales del equipo de Acme y cómo se llaman en la documentación. Este archivo no se indexa como documento: antes de buscar, el bot reemplaza en la pregunta cada término de la primera columna por el de la segunda (por ejemplo, "no me andan los wc" se busca como "no me andan los web component"). Una fila con "—" solo define el término.

| Se dice | En la documentación | Qué es |
|---|---|---|
| wc, wcs, webcomponent, webcomponents | web component | Componente Angular Elements que carga el shell. |
| lib, libs, librería | librería compartida | Librería del registry npm interno (por ejemplo `@acme/ui-kit`). |
| master | main | Rama principal de un repositorio. |
| PR, pull request, merge request | MR | Pedido de merge; aprobar un MR es dar el visto bueno de la revisión. |
| manifest | manifiesto | `manifest.json` de cada ambiente; define qué versión carga el shell. |
| pipe | pipeline | Ejecución de CI; un job es un paso del pipeline (por ejemplo `deploy:cdn-qa`). |
| shell | — | Aplicación Angular que carga los web components desde el CDN. |
| CDN | — | Servidor desde el que el shell descarga el bundle de cada web component. |
| QA, prod | — | Ambientes de pruebas y de producción. |
| guardia | — | Guardia de Plataforma, para incidentes urgentes. |
| backup humano | — | Quien cubre a Arquitectura Frontend durante las vacaciones. |
