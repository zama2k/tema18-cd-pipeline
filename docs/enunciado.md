# Requisito del enunciado → dónde se cumple

Leyenda de estado: **Local** = comprobado ejecutándolo en este ordenador (ver `evidencias/local/`);
**✔** = comprobado en GitHub, Render o Vercel reales, con enlace al run (ver
[`evidencias/github/`](../evidencias/github/README.md)); **No verificado** = no hemos podido comprobarlo.

## Nivel 1 (obligatorio)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| API Express con `/` y `/health` | `src/app.js`, `src/server.js` | Local |
| Script `build` funcional | `npm run build` → `scripts/build-check.mjs` (sintaxis, dependencias de producción, la app carga) + imagen Docker | Local |
| CI existente (lint + test + build) | `.github/workflows/ci.yml`: `lint` ∥ `test` → `build` → `ci-ok` | ✔ [CI 40497219077](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497219077); los mismos comandos: Local |
| CD staging (`cd-staging.yml`) disparado al pasar CI en `main` | `on.workflow_run` de `CI`, solo `conclusion == success` y `event == push`; usa `workflow_run.head_sha` | ✔ [CD Staging 40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611) |
| Despliegue en plataforma elegida | **Render** (imagen de GHCR) vía `scripts/lib/render.mjs`, que usan los workflows a través de `scripts/cd-deploy.mjs` (`scripts/render-deploy.mjs` es la CLI independiente del mismo cliente, para un redeploy manual) | ✔ Render real (digest `@sha256`, deploy `live`): [40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611). Cliente: Local contra Render falso |
| Health check post-deploy (200 en `/health`) | `scripts/health-check.mjs` (exige además `commit == sha`) | Local |
| Environment `staging` | `deploy-staging` → `environment: staging` | ✔ [40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611) |
| CD production (`cd-production.yml`) manual | `workflow_dispatch` con `version` y `sha` | ✔ [v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499710888), [v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40503375451) |
| Aprobación manual (required reviewers) | `environment: production` + `scripts/setup-github.sh` | ✔ Revisor obligatorio y espera de 1 min; aprobó @zama2k en [40499710888](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499710888) |
| Health check con reintentos | `checkHealth`: 12 intentos, espera 5 s creciente hasta 30 s | Local |
| Environment `production` | `deploy-production` | ✔ [40499710888](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499710888) |
| Tokens como secrets, sin credenciales en el código | Solo `${{ secrets.* }}`; `.env.example` con nombres; sin ficheros `.env` | Local (revisión del repo) |
| Branch protection (checks de CI + 1 aprobación) | `scripts/setup-github.sh` (check `CI OK`, 1 aprobación, code owners) | ✔ Activa en `main` (`CI OK`, rama al día, 1 aprobación, code owners, `enforce_admins` desactivado); la PR #1 se mergeó con bypass de administrador |

## Nivel 2 (recomendado)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| Preview deploy por PR | Job `preview` de `ci.yml` (Vercel CLI `pull` → `build` → `deploy --prebuilt`) | ✔ [CI en PR 40500637595](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500637595) (3 previews en la [PR #1](https://github.com/zama2k/tema18-cd-pipeline/pull/1)). `vercel build` y el adaptador: Local |
| URL de la preview comentada en la PR | `scripts/pr-comment.mjs` (un comentario que se edita) | ✔ Un único comentario en la [PR #1](https://github.com/zama2k/tema18-cd-pipeline/pull/1) |
| Limpieza al cerrar la PR | `preview-cleanup.yml` + `scripts/vercel-cleanup.mjs` | ✔ [Preview cleanup 40500845098](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500845098) borró las 3 previews de la PR. Local contra Vercel falso |
| Smoke tests post-deploy (`/health` + un endpoint de la API) | `scripts/smoke.mjs`: `/`, `/health`, `/api/info`, `GET`/`POST` de `/api/items`, 404 | ✔ 7 de 7 en staging ([40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611)). Local contra el contenedor |
| Si fallan, el deploy se marca fallido | `cd-deploy.mjs` sale con código 1, estado `failure` en la API de Deployments | ✔ [40520189660](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520189660) en rojo con rollback. Local |
| Notificación de staging, producción y fallos (Discord) | `scripts/notify-discord.mjs`, job `notify` de cada CD | Jobs `Notify Discord` en success en todos los runs; recepción en `#deploys` verificada con captura aportada por el autor ([tabla](../evidencias/github/README.md#recepción-en-discord)). Local contra Discord falso |
| GitHub Release con SHA y quién despliega | Job `release` de `cd-production.yml` (`--target <sha>`, `triggering_actor`, aprobadores) | ✔ [v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.0.0) y [v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.1.0); desde la 1.1.0 solo lista a personas, no al bot del *wait timer* |

## Nivel 3 (bonus)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| Workflow de rollback por versión/tag | `rollback.yml` (`version`, `environment`, `reason`) | ✔ [40520184940](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520184940) (a v1.0.0) y [40521067970](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40521067970) (a v1.1.0). Lógica de redeploy y verificación: Local |
| Health check y notificación tras el rollback | `cd-deploy.mjs --mode rollback`, job `notify` | ✔ Health tras el rollback: commit `0da3939` y luego `9925d74`. Local |
| Múltiples plataformas | Vercel (previews) + Render (staging/producción), coordinadas en el mismo pipeline. Honestamente: no hay un frontend y un backend separados; son dos plataformas con papeles distintos. | ✔ Vercel (previews) y Render (staging/producción) ejecutadas de verdad |
| Concurrency: un deploy a la vez por entorno | `concurrency: deploy-<entorno>`, `cancel-in-progress: false` (semántica en `docs/operacion.md`) | Configurado; no se han provocado dos deploys simultáneos (No verificado) |
| Cancelar pendientes cuando llega uno nuevo | GitHub sustituye el run pendiente por el más reciente en el mismo grupo | No verificado (comportamiento documentado por GitHub) |
| Docker: build + push a GHCR | Job `build` de `ci.yml` (solo `push` a `main`; etiquetas `sha-<sha>` y `main`) | ✔ Push a GHCR en [CI 40497219077](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497219077). Imagen: Local |
| Deploy usando la imagen | `cd-deploy.mjs` despliega `ghcr.io/...@sha256:...` (o `render-deploy.mjs --image ...` a mano) | Local contra Render falso |
| Caché de capas con la caché de Actions | `cache-from/to: type=gha` | ✔ `--cache-from type=gha` en uso en el build de CI |
| `$GITHUB_STEP_SUMMARY` | `cd-deploy.mjs`, `smoke.mjs --summary`, jobs `build`, `test`, `release` | Local (se escribe a fichero) |
| Badges de staging y producción | `README.md` | ✔ Leen `/health` de los servicios de Render |
| `CODEOWNERS` | `.github/CODEOWNERS` | ✔ La protección de `main` exige la revisión de code owners |

## Estructura de ficheros pedida

El enunciado enumera `ci.yml`, `cd-staging.yml`, `cd-production.yml`, `rollback.yml`, `CODEOWNERS`,
`src/app.js`, `src/server.js`, `tests/app.test.js`, `package.json`, `.eslintrc.json`, `.gitignore` y
`README.md`. Todos existen, salvo que los tests viven en `tests/app/` (más `tests/scripts/` para el
pipeline) y se añaden `preview-cleanup.yml`, `Dockerfile`, `vercel.json`, `api/` y `scripts/`.

## Criterios de evaluación

| Criterio (puntos) | Dónde |
| --- | --- |
| CD staging funcional (20) | `cd-staging.yml` |
| CD production con approval (20) | `cd-production.yml` + entorno `production` |
| Health checks con retries (15) | `scripts/lib/health.mjs`, `tests/scripts/health-smoke.test.mjs` |
| Secrets bien gestionados (10) | `docs/setup.md`, secretos por entorno para Render, `.env.example` |
| Environments configurados (10) | `scripts/setup-github.sh` |
| Branch protection (5) | `scripts/setup-github.sh` |
| Preview deploys en PRs (10) | `ci.yml` job `preview`, `preview-cleanup.yml` |
| Notificaciones (5) | `scripts/notify-discord.mjs` |
| Release en producción (5) | job `release` |
| Bonus: rollback, Docker, concurrency | `rollback.yml`, job `build`, `concurrency:` |

## Diferencias deliberadas con el enunciado

- Slack → **Discord** (el enunciado permite "Slack o Discord"); secreto `DISCORD_WEBHOOK_URL`.
- Espera de producción: 1 minuto por defecto frente a 5 (configurable con `WAIT_TIMER_MINUTES`).
- Staging con `workflow_run` (la opción "más limpia" del enunciado), no con `push`.
- Los entornos `staging`/`production` llevan `RENDER_API_KEY`, `RENDER_SERVICE_ID` y `APP_URL`
  en lugar de `DATABASE_URL`/`API_URL`: la API no usa base de datos.

## Entregables

| Entregable | Estado |
| --- | --- |
| Repositorio público con workflows, entornos y protección | ✔ <https://github.com/zama2k/tema18-cd-pipeline> |
| Capturas (staging tras el merge, producción esperando aprobación, comentario de preview, notificación) | No incluidas. Los runs enlazados en [`evidencias/github/`](../evidencias/github/README.md) las sustituyen |
| URLs (repositorio, staging, producción) | ✔ <https://github.com/zama2k/tema18-cd-pipeline>, <https://tema18-cd-pipeline-staging.onrender.com>, <https://tema18-cd-pipeline-production.onrender.com> |
