# tema18-cd-pipeline

[![CI](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/ci.yml)
[![CD Staging](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/cd-staging.yml/badge.svg)](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/cd-staging.yml)
[![CD Production](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/cd-production.yml/badge.svg)](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/cd-production.yml)
[![Rollback](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/rollback.yml/badge.svg)](https://github.com/zama2k/tema18-cd-pipeline/actions/workflows/rollback.yml)
![Staging version](https://img.shields.io/badge/dynamic/json?url=https://tema18-cd-pipeline-staging.onrender.com/health&query=%24.version&label=staging&cacheSeconds=300)
![Production version](https://img.shields.io/badge/dynamic/json?url=https://tema18-cd-pipeline-production.onrender.com/health&query=%24.version&label=production&cacheSeconds=300)

Reto del Tema 18 (CI/CD y monitorización en producción): un pipeline de **Continuous Deployment**
con GitHub Actions que construye una imagen Docker una sola vez y la promociona de staging a
producción, con aprobación manual, comprobaciones post-deploy, rollback automático y manual,
previews por PR y avisos a Discord.

> Los badges de versión leen `/health` de Render: si el servicio está dormido (plan gratuito) el
> primer acceso tarda por el arranque en frío y el badge puede mostrar "inaccessible" un momento.

## Nota para la corrección

Todo se ha ejecutado de verdad en GitHub Actions, Render y Vercel el 2026-10-27. Tabla completa con
enlaces a cada run: [`evidencias/github/README.md`](evidencias/github/README.md).

| Comprobado | Evidencia |
| --- | --- |
| CI en `main` y CD Staging automático (digest, health con commit, 7 smoke tests) | [CI 40497219077](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497219077), [CD Staging 40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611) |
| CD Production con aprobación manual y release | [CD Production 40499710888](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499710888) → [v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.0.0); [40503375451](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40503375451) → [v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.1.0) |
| Preview por PR en Vercel, smoke con bypass, comentario único y limpieza al cerrar | [PR #1](https://github.com/zama2k/tema18-cd-pipeline/pull/1); CI en PR [40500637595](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500637595); [Preview cleanup 40500845098](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500845098) |
| Rollback automático por fallo real de Render (timeout de 600 s) | [CD Staging 40501012364](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40501012364), intento 1 |
| Rollback automático provocado (`simulate_failure`), run en rojo a propósito | [CD Staging 40520189660](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520189660) |
| Rollback manual de producción y vuelta a la versión nueva | [Rollback 40520184940](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520184940), [40521067970](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40521067970) |
| Entornos, aprobación y protección de `main` configurados en GitHub | `main`: check `CI OK`, 1 aprobación, code owners; `production`: revisor y espera de 1 min |

Estado final: [producción](https://tema18-cd-pipeline-production.onrender.com/health) y
[staging](https://tema18-cd-pipeline-staging.onrender.com/health) sirven la **1.1.0** (`9925d74`).

**No verificado por nosotros:** la recepción de los mensajes de Discord. Los jobs `Notify Discord`
terminaron en success, pero no hemos visto los mensajes en el canal. No hay capturas de pantalla.

Antes de publicar, el repositorio se había verificado en local (salidas en `evidencias/local/`):
instalación limpia, lint, tests con cobertura y umbral, build, imagen Docker (arranque, `/health`,
smoke tests, apagado ordenado), `vercel build`, `actionlint`, `shellcheck` y un ensayo completo del
flujo de CD con contenedores reales y APIs de Render/GitHub/Discord simuladas.

## Arquitectura

```
 Pull request ─► CI ─► lint ┐
                       test ┤─► build (imagen, sin push)
                            └─► preview (solo PR del repo) ─► Vercel ─► comentario en la PR
                                  │
 merge a main ─► CI ─► build imagen ─► push a GHCR ─► artefacto image-digest
                                  │                    ghcr.io/<repo>:sha-<sha>  (+ digest)
                                  ▼ workflow_run (head_sha)
              ┌──────────────────────────────────────────────────────────────────────┐
              │ CD Staging  (entorno staging, automático)                            │
              │  prepare ─► deploy: Render(digest) ─► health(commit == sha) ─► smoke │
              │                      └─ si falla: rollback al digest anterior        │
              │  notify ─► Discord                                                   │
              └───────────────────────────────┬──────────────────────────────────────┘
                                              │ manual: version vX.Y.Z (+ sha opcional)
              ┌───────────────────────────────▼──────────────────────────────────────┐
              │ CD Production  (entorno production, con aprobación)                  │
              │  validate (pasó por staging, tag libre, imagen en GHCR, mismo digest)│
              │  deploy: Render(mismo digest) ─► health ─► smoke de solo lectura     │
              │          └─ si falla: rollback al digest anterior de producción      │
              │  release (tag + GitHub Release) ─► notify ─► Discord                 │
              └──────────────────────────────────────────────────────────────────────┘
 Rollback (manual, staging|production): tag ─► sha ─► imagen sha-<sha> ─► deploy ─► health ─► Discord
```

Historial de despliegues: cada deploy se registra en la **API de Deployments de GitHub** (con sha,
imagen y digest). De ahí salen "la última deployment correcta" (rollback automático y sha por
defecto de producción) y "este sha pasó por staging".

## Ejecutar en local

Requisitos: Node 22 o superior (probado con 24) y Docker.

```bash
npm ci
npm run lint
npm run test:ci          # Jest (app) + node:test (scripts del pipeline), con umbrales
npm run build
npm start                # http://localhost:3000

docker build -t demo --build-arg GIT_SHA=$(git rev-parse HEAD) .
docker run --rm -p 3000:3000 demo
node scripts/health-check.mjs --url http://localhost:3000 --expected-commit $(git rev-parse HEAD)
node scripts/smoke.mjs --url http://localhost:3000

node scripts/dev/local-e2e.mjs   # ensayo completo del CD (usa los puertos 3201-3205)
```

Endpoints: `GET /`, `GET /health` (estado, versión, **commit**, entorno, uptime), `GET /api/info`,
`GET`/`POST /api/items` (valida y responde 400) y `GET /api/items/:id` (400 si el id no es un entero positivo, 404 si no existe; desde la v1.1.0).

## Cómo funciona el pipeline

| Workflow | Cuándo | Jobs |
| --- | --- | --- |
| `ci.yml` (**CI**) | push y PR a `main` | `lint` (ESLint, actionlint, shellcheck) ∥ `test` (cobertura) → `build` (imagen con caché de capas, contenedor + health + smoke, push a GHCR solo en `main`) · `preview` (solo PR del mismo repo) · `ci-ok` (check agregado) |
| `preview-cleanup.yml` | PR cerrada | `cleanup`: borra las previews de Vercel de esa PR y actualiza el comentario |
| `cd-staging.yml` (**CD Staging**) | CI correcto en `main` (push) o manual con `simulate_failure` | `prepare` (digest + comprobaciones) → `deploy-staging` → `notify` |
| `cd-production.yml` (**CD Production**) | manual: `version`, `sha` opcional | `validate` → `deploy-production` (aprobación) → `release` → `notify` |
| `rollback.yml` (**Rollback**) | manual: `version`, `environment`, `reason` | `prepare` → `rollback` → `notify` |

Todos los workflows declaran `permissions: contents: read` y amplían por job, tienen
`timeout-minutes`, fijan las acciones por SHA y pasan las entradas por `env:`. Detalle de cada
decisión en [`docs/decisiones.md`](docs/decisiones.md).

### Entornos

| Entorno | Quién despliega | Protección | Secretos / variables | Plataforma |
| --- | --- | --- | --- | --- |
| `preview` | cada PR del repo | ninguna | secretos de repo de Vercel | Vercel |
| `staging` | automático tras CI en `main` | solo rama `main` | `RENDER_API_KEY`; `RENDER_SERVICE_ID`, `APP_URL` | Render |
| `production` | manual | revisor obligatorio, espera de 1 min, solo `main` | idem, valores propios | Render |

Lista completa de secretos y variables en [`docs/setup.md`](docs/setup.md).

### Desplegar a producción

*Actions → CD Production → Run workflow* con `version` (`v1.2.3`). Sin `sha`, promociona la última
deployment correcta de staging. Aprueba el despliegue en la pantalla del run. Más detalle,
rollback y concurrencia en [`docs/operacion.md`](docs/operacion.md).

### Rollback

*Actions → Rollback → Run workflow*: `version` de una Release existente, entorno y motivo. Además,
**cada deploy** vuelve solo al digest anterior si falla el health check o un smoke test.
`CD Staging` con `simulate_failure` provoca ese camino a propósito para demostrarlo.

## En qué mejora a lo habitual

- **Un solo build, mismo digest en todos los entornos**; producción exige que sea el que pasó por
  staging.
- **Se despliega el commit que pasó CI** (`workflow_run.head_sha`), y el health check exige que
  `/health` devuelva ese commit: un `200` de la versión anterior no cuenta.
- **Rollback automático real**, verificado con el mismo health check, y registro del historial en la
  API de Deployments.
- **Smoke tests contra la URL desplegada** (de solo lectura en producción) y no contra `localhost`.
- **Seguridad de workflows**: permisos mínimos, acciones por SHA, entradas por `env:`, previews
  nunca desde forks, secretos que faltan = aviso claro, nunca fallo en silencio.
- **Scripts propios con tests** y servidores falsos en lugar de bloques `run:` imposibles de
  probar: el rollback se ha ejecutado de verdad en local.
- Sin `actions/create-release` (archivada), sin caché de `node_modules`, sin `cancel-in-progress`
  en deploys, con el `coverageThreshold` de Jest escrito en singular (la clave plural se ignora).

## Verificación local (medida)

| Qué | Resultado |
| --- | --- |
| Tests de la app (Jest + supertest) | 26 tests, cobertura 97,22 % sentencias / 94,44 % ramas / 94,44 % funciones / 100 % líneas; umbral global 80 % |
| El umbral realmente bloquea | con un umbral de ramas del 99 % Jest sale con código 1 (`04-jest-umbral-incumplido.txt`) |
| Tests de los scripts del pipeline (node:test) | 121 tests, 97,28 % líneas / 92,40 % ramas / 89,92 % funciones; umbral de líneas 80 % |
| Lint | ESLint 10 con `.eslintrc.json` vía `FlatCompat`: sin errores |
| `actionlint` 1.7.12 sobre los 5 workflows | sin avisos |
| `shellcheck` 0.11.0 sobre `scripts/setup-github.sh` | sin avisos |
| Imagen Docker | 248,8 MB, usuario `node`, `HEALTHCHECK` en estado `healthy`, `/health` con el commit correcto, 7 smoke tests, `SIGTERM` → salida 0 en ~1,1 s |
| `vercel build` (CLI 65.4.0) | correcto; el manejador generado pasa los 7 smoke tests |
| Ensayo completo del CD (`local-e2e.mjs`) | 16 comprobaciones correctas: deploy, health, smoke, rollback simulado y real, promoción, rollback manual, el rollback no es candidato a promoción |

## Limitaciones honestas

- **Discord:** los avisos se enviaron (jobs en success), pero no hemos visto su recepción en el canal.
- Los clientes de Render, GitHub y Vercel se escribieron leyendo la documentación oficial
  ([`docs/plataformas.md`](docs/plataformas.md)) y la primera ejecución real confirmó los puntos que
  estaban sin verificar: Render acepta `imageUrl` con `@sha256:...`, GitHub acepta un sha como `ref`
  de un deployment y los `--meta` de Vercel aparecen en `GET /v7/deployments` (la limpieza borró las
  3 previews de la PR #1).
- La API guarda los *items* **en memoria** (máximo 100): se pierden al reiniciar. No hay base de
  datos.
- El plan gratuito de Render duerme el servicio: el primer acceso tras un rato es lento. El health
  check con reintentos lo absorbe (unos 4 minutos de margen).
- **Fallo real de Render:** en el [CD Staging 40501012364](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40501012364)
  un deploy se quedó en `update_in_progress` durante 600 s (la imagen era correcta). El pipeline lo
  trata como fallo y revierte al commit anterior; el reintento funcionó en segundos.
- Con una sola cuenta nadie puede aprobar tu PR: el merge usa el bypass de administrador
  (`gh pr merge --admin`, `enforce_admins` desactivado a propósito) y el revisor de `production` eres
  tú mismo. El *wait timer* del entorno aparece como aprobación de `github-actions[bot]`; desde la
  v1.1.0 la release solo lista a las personas. La v1.0.0 conserva el listado anterior como evidencia.
- Volver a una versión ya publicada se hace con `rollback.yml`, no con `cd-production`, que exige un
  tag nuevo (no se crea una v1.1.1 vacía ni se reescribe un tag).
- El paquete de GHCR hay que hacerlo **público** (o dar a Render una credencial) la primera vez.
- El rollback depende de que la imagen anterior siga en GHCR; Render no guarda copias.
- Un `vercel build` local en Windows reescribe `package-lock.json`; descarta el cambio con
  `git checkout package-lock.json`.
- "Múltiples plataformas": Vercel (previews) y Render (staging/producción) están coordinadas en el
  mismo pipeline, pero no existe un frontend y un backend separados: son dos papeles distintos para
  la misma API.

## Estructura

```
.github/workflows/   ci, preview-cleanup, cd-staging, cd-production, rollback
.github/CODEOWNERS · dependabot.yml
src/ · api/ · vercel.json · public/        app Express y adaptador de Vercel
Dockerfile · .dockerignore                 imagen multi-stage, no root, HEALTHCHECK
scripts/                                   cd-deploy (lo usan los workflows), render-deploy (CLI manual del mismo
                                           cliente), health-check, smoke, resolve-image,
                                           deployments, notify-discord, pr-comment, vercel-cleanup,
                                           build-check, setup-github.sh
scripts/lib/ · scripts/dev/                librerías; servidores falsos, ensayo local, recolector de evidencias
tests/app/ · tests/scripts/                Jest (app) y node:test (pipeline)
docs/                                      enunciado, setup, operacion, plataformas, decisiones
evidencias/github/                         ejecuciones reales (enlaces a cada run)
evidencias/local/                          salidas reales de las comprobaciones locales
```

## Documentación

- [`docs/enunciado.md`](docs/enunciado.md): requisito del enunciado → dónde se cumple.
- [`docs/setup.md`](docs/setup.md): puesta en marcha paso a paso, secretos y variables.
- [`docs/operacion.md`](docs/operacion.md): desplegar, rollback, fallos y concurrencia.
- [`docs/decisiones.md`](docs/decisiones.md): decisiones de diseño.
- [`docs/plataformas.md`](docs/plataformas.md): APIs consultadas (URL y fecha) y lo que queda sin verificar.
