# APIs de terceros: qué se consultó y qué implica

Todas las páginas se leyeron el 2026-10-27. Los clientes de `scripts/` se escribieron contra
estas descripciones y se prueban contra servidores falsos (`scripts/dev/fakes.mjs`). Después se
ejecutaron contra las plataformas reales ([evidencias](../evidencias/github/README.md)). Lo que la
documentación no dejaba claro se marcó como **sin verificar** y cada punto indica ahora qué pasó.

## Render

| Documento | URL |
| --- | --- |
| Crear un deploy | https://api-docs.render.com/reference/create-deploy |
| Consultar un deploy | https://api-docs.render.com/reference/retrieve-deploy |
| Servicios basados en imagen | https://render.com/docs/deploy-an-image |
| Deploys | https://render.com/docs/deploys |

Lo que usa `scripts/lib/render.mjs`:

- Autenticación: cabecera `Authorization: Bearer <RENDER_API_KEY>`. Base `https://api.render.com/v1`.
- `POST /services/{serviceId}/deploys` con `{ "imageUrl": "...", "clearCache": "do_not_clear" }`.
  Responde `201` con el objeto deploy (`id`, `status`, `image.ref`, `image.sha`...) o `202` sin
  cuerpo cuando queda en cola. Con `202` el cliente busca el deploy más reciente
  (`GET /services/{id}/deploys?limit=1`).
- `GET /services/{serviceId}/deploys/{deployId}`. Estados: `created`, `queued`, `build_in_progress`,
  `update_in_progress`, `live`, `deactivated`, `build_failed`, `update_failed`, `canceled`,
  `pre_deploy_in_progress`, `pre_deploy_failed`. El cliente espera a `live` y trata como fallo
  `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled` y `deactivated`.
- `imageUrl` debe coincidir en host, repositorio e imagen con la imagen configurada en el servicio;
  solo puede cambiar la etiqueta o el digest.
- Los servicios de imagen **no se redespliegan solos** al cambiar una etiqueta: hay que llamar a la
  API (es lo que hace el pipeline). Render no cachea imágenes: las baja del registro en cada
  deploy, reinicio o reprogramación. Por eso un rollback necesita que la imagen anterior siga en
  GHCR.
- Una imagen de GHCR privada necesita una credencial de registro con `read:packages`. Con un
  paquete público no hace falta.
- La imagen debe ser `linux/amd64` (el runner de GitHub y el `Dockerfile` lo cumplen).

**Verificado en la práctica**: la documentación dice que `Image URL` acepta "una etiqueta o un digest",
pero no muestra la sintaxis exacta. El pipeline usa la forma estándar
`ghcr.io/owner/repo@sha256:<digest>` y Render la aceptó: el deploy pasó a `live` y `/health`
devolvió el commit esperado ([CD Staging 40497439611](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40497439611)).

**Sin verificar del todo**: el formato de `image.sha` en la respuesta (con o sin prefijo `sha256:`,
mayúsculas, o incluso una referencia completa). La documentación solo lo declara como cadena. Por
eso el cliente lo **normaliza** (minúsculas, sin `sha256:`, sin la parte `imagen@`) y, si aun así no
coincide con el digest pedido, solo emite un `::warning::`: la comprobación fuerte de qué se está
ejecutando es `/health.commit`, que se verifica a continuación y sí bloquea. En los runs revisados no
apareció ningún aviso.

**Sin verificar del todo**: con `202` (deploy en cola, sin cuerpo) el cliente busca el deploy recién creado
entre los últimos de la lista, filtrando por `image.ref` igual al pedido y `createdAt` posterior a
la petición (con 10 s de tolerancia por desfase de relojes), y reintenta hasta que aparece. La
forma exacta de la lista (`[{ deploy, cursor }]`) y de `createdAt` sigue la referencia de
"list deploys". Los deploys reales se encontraron y esperaron sin incidencias, así que el camino
funciona; no hemos comprobado cuál de las dos respuestas (`201` o `202`) devolvió Render.

## Vercel

| Documento | URL |
| --- | --- |
| Express en Vercel | https://vercel.com/docs/frameworks/backend/express |
| `vercel deploy` | https://vercel.com/docs/cli/deploy |
| `vercel list` | https://vercel.com/docs/cli/list |
| `vercel remove` | https://vercel.com/docs/cli/remove |
| Protection Bypass for Automation | https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation |
| REST: listar deployments | https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments |
| REST: borrar un deployment | https://vercel.com/docs/rest-api/reference/endpoints/deployments/delete-a-deployment |

- Flujo de CLI usado: `vercel pull --yes --environment=preview` → `vercel build` →
  `vercel deploy --prebuilt --meta githubPrId=<n>`. La salida estándar de `deploy` es siempre la
  URL del deployment.
- Express tiene "zero configuration" (un fichero que exporte la app), pero nuestro `src/app.js`
  exporta una factoría. Por eso se usa el adaptador `api/index.js` + `vercel.json` con una
  reescritura a `/api`.
- Cabecera de bypass para la protección de despliegues: `x-vercel-protection-bypass: <secreto>`
  (también existe como parámetro de query; se prefiere la cabecera). El secreto se genera en el
  proyecto de Vercel (*Settings → Deployment Protection → Protection Bypass for Automation*).
- Limpieza: `GET /v7/deployments?projectId=...` no documenta ningún filtro por metadatos
  (`vercel list --meta` sí existe en la CLI, pero no tiene salida JSON). El cliente lista por
  proyecto, pagina con `until` y **filtra en local** por `meta.githubPrId`. Luego
  `DELETE /v13/deployments/{id}`.
- **Verificado en la práctica**: los valores de `--meta` de la CLI aparecen en `meta` de la respuesta de
  `GET /v7/deployments`: [Preview cleanup 40500845098](https://github.com/zama2k/tema18-cd-pipeline/actions/runs/40500845098) borró las 3
  previews de la PR #1 filtrando por `githubPrId`.

### Hallazgos de la prueba local de `vercel build`

Con `vercel@65.4.0` y un `.vercel/project.json` con identificadores de relleno (no hace falta
cuenta para construir):

1. Sin `public/`, el build falla con `No Output Directory named "public" found`: Vercel trata el
   `npm run build` del `package.json` como un build estático. Por eso existe `public/` (vacío
   salvo un README) y `vercel.json` fija `"framework": null`.
2. La salida (`.vercel/output/functions/api/index.func`) contiene `api/`, `src/` y las
   dependencias de producción. El manejador servido en un puerto local pasa los 7 smoke tests.
3. En Windows, `vercel build` ejecuta `npm install` y **reescribe `package-lock.json`** (quita
   dependencias opcionales de otras plataformas). `vercel.json` fuerza `npm ci`, pero Vercel
   instala además sus propios paquetes con `npm install`. Si lo ejecutas en local, descarta el
   cambio con `git checkout package-lock.json`. En el runner de Linux no ocurre.

## GitHub

| Documento | URL |
| --- | --- |
| Deployments | https://docs.github.com/en/rest/deployments/deployments |
| Estados de un deployment | https://docs.github.com/en/rest/deployments/statuses |
| Revisiones de un run (approvals) | https://docs.github.com/en/rest/actions/workflow-runs |
| `gh release create` | https://cli.github.com/manual/gh_release_create |

- El pipeline **crea sus propios registros** de deployment (`task: "deploy-image"`) con el
  `payload` `{ sha, image, digest }`. Los jobs con `environment:` también generan un registro
  automático, pero sin digest y, con `workflow_run`, con el sha equivocado (el de la punta de
  `main`). Se distinguen por `task`.
- `POST /deployments` con `auto_merge: false` y `required_contexts: []` (si no, GitHub intenta
  fusionar la rama por defecto o exige estados de commit). `201` = creado; `409`/`422` = error.
- Al marcar un deployment como `success`, GitHub añade un estado `inactive` a los anteriores del
  mismo entorno (`auto_inactive` por defecto). Por eso "última deployment correcta" significa
  "tiene un `success` y ningún `failure`/`error`", no "su último estado es `success`".
- La documentación no dice en qué orden devuelve la lista; el código ordena por `id` descendente.
- **Verificado en la práctica**: la política de ramas del entorno aceptó `ref` = sha (los registros
  `deploy-image` de staging y producción tienen el sha como `ref`). El reintento con la rama por
  defecto ante un `422` queda como red de seguridad.
- Approvals: `GET /repos/{o}/{r}/actions/runs/{run_id}/approvals` devuelve `state`
  (`approved`/`rejected`/`pending`), `user.login` y `comment`. Lo usa el job `release`.
- `gh release create --generate-notes --notes-file f`: el texto propio se antepone a las notas
  generadas.

## Discord

| Documento | URL |
| --- | --- |
| Execute Webhook | https://docs.discord.com/developers/resources/webhook |
| Embeds y límites | https://docs.discord.com/developers/resources/message |

- `POST` al webhook con `{ username, allowed_mentions, embeds }`. Sin `?wait=true` responde `204`.
- Límites que respeta `scripts/lib/discord.mjs`: título 256, descripción 4096, valor de campo 1024,
  25 campos, 6000 caracteres en total. `color` es un entero.
- Un `429` se reintenta una vez respetando `retry_after` (el 429 no está en esa página; viene de la
  documentación general de límites de Discord, **sin verificar** aquí). Los avisos reales no
  devolvieron error y su recepción está verificada con la captura del canal `#deploys` aportada por
  el autor (ver `evidencias/github/README.md`).
- La URL del webhook contiene el token: nunca se imprime ni aparece en los mensajes de error.
