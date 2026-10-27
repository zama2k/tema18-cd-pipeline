# Requisito del enunciado → dónde se cumple

Leyenda de estado: **Local** = comprobado ejecutándolo en este ordenador (ver `evidencias/local/`);
**Pendiente GitHub** = solo se puede comprobar con el repositorio publicado y las cuentas
creadas (ver "Nota para la corrección" del README).

## Nivel 1 (obligatorio)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| API Express con `/` y `/health` | `src/app.js`, `src/server.js` | Local |
| Script `build` funcional | `npm run build` → `scripts/build-check.mjs` (sintaxis, dependencias de producción, la app carga) + imagen Docker | Local |
| CI existente (lint + test + build) | `.github/workflows/ci.yml`: `lint` ∥ `test` → `build` → `ci-ok` | Pendiente GitHub (los mismos comandos: Local) |
| CD staging (`cd-staging.yml`) disparado al pasar CI en `main` | `on.workflow_run` de `CI`, solo `conclusion == success` y `event == push`; usa `workflow_run.head_sha` | Pendiente GitHub |
| Despliegue en plataforma elegida | **Render** (imagen de GHCR) vía `scripts/render-deploy.mjs` | Cliente: Local contra Render falso. Render real: Pendiente |
| Health check post-deploy (200 en `/health`) | `scripts/health-check.mjs` (exige además `commit == sha`) | Local |
| Environment `staging` | `deploy-staging` → `environment: staging` | Pendiente GitHub |
| CD production (`cd-production.yml`) manual | `workflow_dispatch` con `version` y `sha` | Pendiente GitHub |
| Aprobación manual (required reviewers) | `environment: production` + `scripts/setup-github.sh` | Pendiente GitHub |
| Health check con reintentos | `checkHealth`: 12 intentos, espera 5 s creciente hasta 30 s | Local |
| Environment `production` | `deploy-production` | Pendiente GitHub |
| Tokens como secrets, sin credenciales en el código | Solo `${{ secrets.* }}`; `.env.example` con nombres; sin ficheros `.env` | Local (revisión del repo) |
| Branch protection (checks de CI + 1 aprobación) | `scripts/setup-github.sh` (check `CI OK`, 1 aprobación, code owners) | Script probado con `gh` falso; aplicación real: Pendiente |

## Nivel 2 (recomendado)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| Preview deploy por PR | Job `preview` de `ci.yml` (Vercel CLI `pull` → `build` → `deploy --prebuilt`) | `vercel build` y el adaptador: Local. Despliegue: Pendiente |
| URL de la preview comentada en la PR | `scripts/pr-comment.mjs` (un comentario que se edita) | Local contra GitHub falso |
| Limpieza al cerrar la PR | `preview-cleanup.yml` + `scripts/vercel-cleanup.mjs` | Local contra Vercel falso |
| Smoke tests post-deploy (`/health` + un endpoint de la API) | `scripts/smoke.mjs`: `/`, `/health`, `/api/info`, `GET`/`POST` de `/api/items`, 404 | Local contra el contenedor |
| Si fallan, el deploy se marca fallido | `cd-deploy.mjs` sale con código 1, estado `failure` en la API de Deployments | Local |
| Notificación de staging, producción y fallos (Discord) | `scripts/notify-discord.mjs`, job `notify` de cada CD | Local contra Discord falso. Discord real: Pendiente |
| GitHub Release con SHA y quién despliega | Job `release` de `cd-production.yml` (`--target <sha>`, `triggering_actor`, aprobadores) | Pendiente GitHub |

## Nivel 3 (bonus)

| Requisito | Dónde | Estado |
| --- | --- | --- |
| Workflow de rollback por versión/tag | `rollback.yml` (`version`, `environment`, `reason`) | Pendiente GitHub; la lógica de redeploy y verificación: Local |
| Health check y notificación tras el rollback | `cd-deploy.mjs --mode rollback`, job `notify` | Local |
| Múltiples plataformas | Vercel (previews) + Render (staging/producción), coordinadas en el mismo pipeline. Honestamente: no hay un frontend y un backend separados; son dos plataformas con papeles distintos. | Pendiente |
| Concurrency: un deploy a la vez por entorno | `concurrency: deploy-<entorno>`, `cancel-in-progress: false` (semántica en `docs/operacion.md`) | Pendiente GitHub |
| Cancelar pendientes cuando llega uno nuevo | GitHub sustituye el run pendiente por el más reciente en el mismo grupo | Pendiente GitHub |
| Docker: build + push a GHCR | Job `build` de `ci.yml` (solo `push` a `main`; etiquetas `sha-<sha>` y `main`) | Imagen: Local. Push: Pendiente |
| Deploy usando la imagen | `render-deploy.mjs --image ghcr.io/...@sha256:...` | Local contra Render falso |
| Caché de capas con la caché de Actions | `cache-from/to: type=gha` | Pendiente GitHub (la caché de capas local sí funciona) |
| `$GITHUB_STEP_SUMMARY` | `cd-deploy.mjs`, `smoke.mjs --summary`, jobs `build`, `test`, `release` | Local (se escribe a fichero) |
| Badges de staging y producción | `README.md` | Pendiente GitHub |
| `CODEOWNERS` | `.github/CODEOWNERS` | Pendiente GitHub |

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
| Repositorio público con workflows, entornos y protección | Pendiente: publicar el repositorio y ejecutar `scripts/setup-github.sh` |
| Capturas (staging tras el merge, producción esperando aprobación, comentario de preview, notificación) | Pendiente: requieren GitHub, Render, Vercel y Discord reales |
| URLs (repositorio, staging, producción) | Pendiente |
