# Evidencias en GitHub, Render y Vercel

Ejecuciones reales, comprobadas el 2026-10-27. Las salidas locales siguen en [`../local/`](../local/).

- Repositorio: <https://github.com/zama2k/tema18-cd-pipeline>
- Producción: <https://tema18-cd-pipeline-production.onrender.com/health>
- Staging: <https://tema18-cd-pipeline-staging.onrender.com/health>

Estado final: producción y staging sirven la versión **1.1.0**, commit `9925d74`.

## Línea de tiempo

| # | Qué se demuestra | Ejecución | Commit desplegado o probado | Resultado |
|---|---|---|---|---|
| 1 | CI en `main`: lint, tests, build y push de la imagen a GHCR | [CI 40497219077](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497219077) | `0da3939` | success (la preview se salta: no es una PR) |
| 2 | CD Staging automático tras el CI (digest, Render, health con commit, 7 smoke tests, Discord) | [CD Staging 40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611) | `0da3939` | success |
| 3 | CD Production manual con aprobación, release y notificación | [CD Production 40499710888](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499710888) | `0da3939` | success; release [v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.0.0) |
| 4 | PR con preview en Vercel (3 pushes) | CI en PR: [40499893545](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40499893545), [40500271664](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500271664), [40500637595](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500637595) | `e56cd6b`, `675519c`, `ffbb6c8` | success en los tres |
| 5 | Limpieza de la preview al cerrar la PR | [Preview cleanup 40500845098](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500845098) | `ffbb6c8` | success: borró las 3 previews de la PR #1 |
| 6 | CD Staging de la 1.1.0: **fallo real de plataforma y rollback automático**, y reintento | [CD Staging 40501012364](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40501012364) | `9925d74` | intento 1: failure con rollback a `0da3939`; intento 2: success |
| 7 | CD Production de la 1.1.0 | [CD Production 40503375451](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40503375451) | `9925d74` | success; release [v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.1.0) |
| 8 | Rollback automático **provocado**: `simulate_failure` | [CD Staging 40520189660](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520189660) | `9925d74` | **failure a propósito** |
| 9 | Rollback manual de producción a v1.0.0 | [Rollback 40520184940](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520184940) | `0da3939` | success |
| 10 | Roll forward de producción a v1.1.0 | [Rollback 40521067970](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40521067970) | `9925d74` | success |

La PR es la [#1](https://github.com/zama2k/tema18-cd-pipeline/pull/1) (`feat(api): add GET /api/items/:id and release 1.1.0`), mergeada a `main` como `9925d74` con bypass de administrador.

## Detalle por prueba

### Staging y producción (filas 1 a 3)

| Comprobación | Resultado |
|---|---|
| Un solo build | La imagen se publicó en CI y el CD usó su **digest** (`ghcr.io/zama2k/tema18-cd-pipeline@sha256:ee8fd71d...`) |
| Render acepta el digest | `imageUrl` con `@sha256:...` desplegó sin error; el deploy pasó a `live` |
| Health check exigente | `/health` devolvió el commit esperado (`0da3939`), versión 1.0.0 |
| Smoke tests | 7 de 7 en staging |
| Aprobación de producción | Revisor obligatorio + espera de 1 minuto; aprobó @zama2k |
| Release | v1.0.0 con commit, digest de la imagen, quién despliega, quién aprueba y enlace al run |

### Preview por PR (filas 4 y 5)

| Comprobación | Resultado |
|---|---|
| Preview en Vercel | Job `Vercel preview` en success en las 3 ejecuciones de la PR |
| Smoke contra la preview | Usa la cabecera de bypass de *Deployment Protection* |
| La preview sirve el commit de la PR | `GIT_SHA` se inyecta con `vercel deploy --prebuilt --env`; el health check exige ese commit |
| Comentario | Un único comentario que se edita (marcador `cd-pipeline:preview`) |
| Cierre de la PR | La limpieza borró las 3 previews (filtradas por `githubPrId`) y dejó el comentario en *Preview removed* |

### Rollback automático por plataforma (fila 6)

| | |
|---|---|
| Qué pasó | Render dejó el deploy de `9925d74` en `update_in_progress` y el pipeline abortó a los **600 s** (`Timed out after 600s waiting for deploy`) |
| Qué hizo el pipeline | Rollback automático a `0da3939`, job en rojo y aviso a Discord con estado `rolled_back` |
| Causa | Fallo de la plataforma (plan gratuito de Render), no de la imagen, que se verificó correcta |
| Reintento | El *re-run* terminó en success en segundos: v1.1.0 en staging |

### Fallo provocado (fila 8)

`CD Staging` lanzado a mano con `simulate_failure=true`: el health check espera un commit imposible (`0000...`), falla en 2 de 2 intentos, el pipeline revierte al commit anterior y el run queda **en rojo a propósito** con aviso `rolled_back` en Discord. Staging siguió sirviendo la 1.1.0.

### Rollback manual y roll forward (filas 9 y 10)

| | Rollback | Roll forward |
|---|---|---|
| Run | [40520184940](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520184940) | [40521067970](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40521067970) |
| Entrada | `version=v1.0.0`, `environment=production` | `version=v1.1.0`, `environment=production` |
| Motivo registrado | Simulacro: restaurar v1.0.0 en producción | Volver a v1.1.0 tras el simulacro |
| Aprobación | @zama2k | @zama2k |
| Comprobación | Health: commit `0da3939`, versión 1.0.0 | Health: commit `9925d74`, versión 1.1.0 |

**Decisión:** `cd-production` exige un tag nuevo, así que volver a una versión ya publicada se hace con `rollback.yml`. No se creó una v1.1.1 vacía ni se reescribió ningún tag.

## Hallazgos reales

| Hallazgo | Dónde se ve | Corrección |
|---|---|---|
| El *wait timer* del environment se registra como aprobación del bot `github-actions[bot]`, y la release v1.0.0 lo listó como aprobador | [v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.0.0): "Approved by @github-actions[bot], @zama2k" | PR #1 filtra `.user.type != "Bot"`; [v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/releases/tag/v1.1.0) dice solo "@zama2k". v1.0.0 se deja como estaba |
| Render free tier: arranques lentos y algún deploy colgado | Fila 6 | El pipeline lo trata como fallo y revierte; el reintento funciona |
| Con un solo usuario nadie puede aprobar la PR | PR #1 | Merge con `gh pr merge --admin` (`enforce_admins` desactivado a propósito) |

## Configuración comprobada

| Elemento | Valor |
|---|---|
| Protección de `main` | Check requerido `CI OK`, rama al día, 1 aprobación, code owners, `enforce_admins` desactivado |
| Environments | `preview`; `staging` (solo `main`); `production` (revisor obligatorio, espera de 1 min, solo `main`) |

## Qué no hemos verificado

| Punto | Estado |
|---|---|
| Recepción en Discord | Los jobs `Notify Discord` terminaron en success, pero no hemos visto los mensajes en el canal |
| Capturas de pantalla | No incluidas |
