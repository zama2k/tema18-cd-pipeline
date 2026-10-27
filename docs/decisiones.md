# Decisiones de diseño

Cada fila: qué se decidió, por qué y en qué se aparta de lo habitual en este tipo de ejercicios.

| Decisión | Por qué | Lo habitual y su problema |
| --- | --- | --- |
| **Construir una vez, desplegar muchas**: CI publica `ghcr.io/<repo>:sha-<sha>` y registra el digest; staging, producción y rollback despliegan ese mismo digest. | Lo que se probó en staging es exactamente lo que llega a producción. | Reconstruir en cada entorno: puede salir otro binario. |
| **Los CD usan `workflow_run.head_sha`**, no `github.sha`. | En `workflow_run`, `github.sha` es la punta actual de `main`, que puede ser un commit distinto del que pasó CI. | Hacer checkout del HEAD de `main` y desplegar código que nadie ha probado. |
| **El digest viaja como artefacto** (`image-digest`) y se vuelve a comprobar en GHCR. | Si alguien mueve la etiqueta `sha-<sha>`, el pipeline sigue usando el digest que CI construyó. | Desplegar por etiqueta mutable. |
| **Health check que exige `commit == sha`** y reintentos con espera creciente. | Un `200` solo dice que algo responde; puede ser la versión anterior. La app expone `GIT_SHA` en `/health`. | `curl /health` una vez, o `sleep` fijo. |
| **Smoke tests contra la URL desplegada**, no contra `localhost`. | Un job que no tiene la app levantada no prueba nada. En producción son de solo lectura. | Smoke tests contra `localhost`; crear datos de prueba en producción. |
| **Rollback automático real**: se vuelve al digest de la última deployment correcta del entorno, verificando de nuevo el commit. | La materia lo anuncia pero no lo implementa. | `echo "rolling back"`. |
| **El historial de deployments vive en la API de Deployments de GitHub** (`task: deploy-image`, `payload` con sha/imagen/digest). | Da "última deployment correcta" y "ese sha pasó por staging" sin una base de datos propia, y se ve en la pestaña *Environments*. | Variables de repositorio o ficheros en una rama. |
| **"Correcta" = tiene un `success` y ningún `failure`/`error`.** | GitHub añade `inactive` a los deployments sustituidos; mirar solo el último estado perdería el candidato de rollback. | Comparar el último estado con `success`. |
| **Concurrency por entorno con `cancel-in-progress: false`**; los tres workflows de un entorno comparten grupo. | Nunca se mata un deploy a medias ni se solapan CD y rollback. GitHub sustituye el pendiente por el más reciente. | `cancel-in-progress: true` en deploys. |
| **CD Staging salta commits que ya no son la punta de `main`.** | Los CI terminan fuera de orden; desplegar el antiguo el último dejaría staging atrasado. | Desplegar siempre lo último que llegue. |
| **Producción solo promueve un commit que pasó por staging** y exige que la etiqueta `sha-<sha>` apunte al digest probado (`--strict-tag`). | Impide saltarse staging o desplegar una imagen reconstruida. | `workflow_dispatch` que acepta cualquier ref. |
| **Todo `${{ inputs.* }}` y `github.head_ref` pasan por `env:`**; la versión se valida con regex. | Evita la inyección de scripts. | Interpolar en `run:`. |
| **`permissions: contents: read` por defecto** y más permisos solo en el job que los usa. | Mínimo privilegio. | Sin bloque `permissions`. |
| **Acciones fijadas por SHA** con comentario de versión + Dependabot. | Una etiqueta se puede mover; un SHA no. | `@v4`, `@master`. |
| **`gh release create`** en vez de `actions/create-release`. | La acción está archivada. | `actions/create-release@v1`. |
| **Caché de capas Docker (`type=gha`)** y de `~/.npm` con `setup-node`; `npm ci`. | Rápido y sin los problemas de cachear `node_modules`. | Cachear `node_modules`. |
| **`ci-ok`** como único check requerido. | Nombre estable; también pasa cuando la preview se salta y falla si un job se cancela. | Listar cada job en la protección de rama. |
| **Los scripts de despliegue son Node sin dependencias, con tests** y servidores falsos. | Se puede probar el rollback sin cuentas. | Bloques de `run:` de 40 líneas imposibles de probar. |
| **ESLint 10 con `.eslintrc.json` cargado mediante `FlatCompat`.** | El enunciado pide `.eslintrc.json`; ESLint ≥ 9 solo lee `eslint.config.js`. Las reglas siguen en un único fichero. | Bajar a ESLint 8 (sin soporte) o ignorar el enunciado. |
| **`coverageThreshold` (singular)** de Jest al 80 %. | La clave plural se ignora en silencio. Se comprobó que el umbral falla cuando no se cumple (`evidencias/local/04-...`). | `coverageThresholds` que nunca bloquea. |
| **Dos plataformas con papeles distintos**: Render ejecuta la imagen (staging y producción); Vercel solo hace previews de PR. | Cubre el bonus de "múltiples plataformas" con una separación honesta. | Fingir un frontend y un backend que no existen. |
| **Wait timer de producción = 1 minuto** (configurable). | Con una sola cuenta un reloj largo solo frena. `WAIT_TIMER_MINUTES=5` reproduce el enunciado. | 5 minutos fijos. |

## Lo que no se hizo, a propósito

- No hay base de datos: la API guarda los *items* en memoria (máximo 100) y se pierden al reiniciar.
  No se simula PostgreSQL. Lo importante del reto es el pipeline.
- No hay *blue-green* ni *canary*: Render sustituye la instancia con su despliegue gradual por
  defecto. El rollback es un nuevo deploy del digest anterior.
- No se usa OIDC: no hay nube de la que obtener credenciales; las claves son tokens de servicio
  de Render y Vercel, guardados como secretos (el de Render, por entorno).
