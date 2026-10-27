# Operación diaria

## Desplegar a producción

*Actions → CD Production → Run workflow* (desde `main`):

| Entrada | Obligatoria | Significado |
| --- | --- | --- |
| `version` | sí | `vX.Y.Z`. No puede existir ya ese tag. |
| `sha` | no | Commit completo (40 caracteres). Vacío = la última deployment **correcta** de staging; tras un rollback de staging no hay valor por defecto y hay que indicarlo (ver abajo). |

1. **Validate** comprueba el formato, que el tag esté libre, que ese commit pasó por staging
   (API de Deployments) y que la imagen `sha-<sha>` existe en GHCR con el **mismo digest** que
   ejecutó staging.
2. **Deploy to production** espera la aprobación del entorno `production`. Aprueba en la pantalla
   del run (*Review deployments*). Después despliega el digest, comprueba `/health.commit`, ejecuta
   smoke tests de **solo lectura** y, si algo falla, vuelve al digest anterior de producción.
3. **Create GitHub Release** crea el tag sobre ese commit y la Release con notas generadas, más
   commit, digest, quién la lanzó, quién la aprobó, URL y fecha.
4. **Notify Discord** avisa del resultado (éxito, fallo o fallo con rollback).

## Rollback manual

*Actions → Rollback → Run workflow*: `version` (un tag existente), `environment`
(`staging`/`production`) y `reason`. Resuelve el tag a su commit, exige que la imagen exista,
despliega ese digest (producción pide aprobación), verifica `/health.commit` y avisa a Discord.
Si el propio rollback falla no se intenta otro rollback: necesita una persona.

`CD Production` exige un tag nuevo. Para volver a una versión ya publicada (por ejemplo, restaurar la
v1.1.0 tras un rollback a la v1.0.0) se usa este mismo workflow, no una v1.1.1 vacía ni un tag
reescrito. Ejecuciones reales: [a v1.0.0](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40520184940) y [de vuelta a v1.1.0](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40521067970).

Los rollbacks se registran en la API de Deployments con `mode: "rollback"`. Sirven para saber qué
ejecuta el entorno ahora (un deploy posterior que falle volvería a esa versión), pero **nunca**
se ofrecen como candidato a producción: tras un rollback de staging, `CD Production` sin `sha`
falla con un mensaje claro (la versión anterior al rollback es la que se descartó y la versión
restaurada ya tuvo su release). Indica el `sha` explícitamente, o despliega algo nuevo en staging.

## Qué hace el pipeline cuando algo falla

| Situación | Resultado |
| --- | --- |
| Falla Render, el health check o un smoke test | Rollback automático al digest anterior del entorno, job en rojo, Discord "rolled back". |
| Render se queda en `update_in_progress` más de 600 s | Igual que arriba. Pasó de verdad en el [CD Staging 40501012364](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40501012364); el *re-run* funcionó. |
| No había deployment anterior (primer despliegue) | Job en rojo, sin rollback posible, Discord "failed". |
| Falla también el rollback | Job en rojo, resultado `rollback_failed`: hay que intervenir a mano (ver abajo). |
| Falta `RENDER_API_KEY`, `RENDER_SERVICE_ID` o `APP_URL` | Se salta el despliegue con `::notice::` y un resumen; no falla. |
| Falta `DISCORD_WEBHOOK_URL` | Se salta la notificación con `::notice::`. Una notificación fallida nunca rompe el pipeline. |
| Un commit más nuevo ya está en `main` | CD Staging salta el commit antiguo ("superseded"); lo despliega su sucesor. |

### Por qué el job de despliegue tiene 45 minutos

Peor caso de un deploy que falla al final y obliga a revertir (valores por defecto de
`cd-deploy.mjs`; la espera de aprobación del entorno no cuenta):

| Fase | Cálculo | Peor caso |
| --- | --- | --- |
| Deploy en Render | `--render-timeout` 600 s + un intervalo de sondeo (5 s) | ~605 s |
| Health check | 12 intentos × 10 s de timeout + esperas 5, 7,5, 11, 17, 25 y 5 × 30 s | ~366 s |
| Smoke tests | 7 comprobaciones × 15 s de timeout | ~105 s |
| Rollback: deploy + health check | ~605 s + ~366 s | ~971 s |
| Búsqueda del deploy tras un `202` (dos veces) | 10 intentos × 2 s, por deploy | ~40 s |
| **Total** | | **~2.090 s ≈ 35 min** (+ ~1 min de checkout y setup) |

Con 30 minutos el runner habría matado el job en pleno rollback. 45 deja ~9 minutos de margen. Si
reduces `--render-timeout` a 300 s el peor caso baja a ~25 min.

Si el rollback automático falla: abre el servicio en Render, *Events → Rollback* a un deploy
anterior, y después usa el workflow **Rollback** para dejar el historial de GitHub coherente.

## Concurrencia: qué significa de verdad

`cancel-in-progress: false` impide que un deploy en curso sea cancelado. Pero GitHub solo guarda
**un** run pendiente por grupo: si llegan tres commits seguidos, el primero se despliega, el
segundo pendiente es **sustituido** por el tercero (cancelado) y el tercero se despliega después.
Es lo que pide el enunciado ("cancelar deploys pendientes cuando uno nuevo llega") sin matar nunca
uno a medias. `cd-staging.yml`, `cd-production.yml` y `rollback.yml` comparten el grupo
`deploy-<entorno>`, así que nunca se pisan. Consecuencia: un run de producción que espera
aprobación mantiene el candado; un rollback de producción lanzado entonces queda pendiente hasta
que se apruebe o se rechace.

## Previews

Cada PR del propio repositorio (nunca de forks) despliega una preview en Vercel con
`--meta githubPrId=<n>`, hace un smoke test usando el secreto de bypass y escribe **un solo**
comentario, que se edita en cada push. Al cerrar la PR, `preview-cleanup.yml` borra los
deployments de esa PR y cambia el comentario a "Preview removed".

## Probar todo en local (sin cuentas)

```bash
npm ci
npm run lint && npm run test:ci && npm run build
node scripts/dev/local-e2e.mjs      # contenedores reales + Render/GitHub/Discord/registro falsos
node scripts/dev/collect-evidence.mjs   # regenera evidencias/local/
```

`local-e2e.mjs` usa los puertos 3201 (app) y 3202-3205 (servidores falsos) y limpia sus contenedores
e imágenes `t18reto-*`.
