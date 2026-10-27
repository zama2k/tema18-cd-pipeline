# Puesta en marcha (una sola vez)

Orden recomendado. Cada paso indica qué comprueba que ha ido bien.

## 1. Sustituir los marcadores

El repositorio usa marcadores que se cambian de una vez cuando conozcas tu usuario y tus URLs:

```bash
sd '__GH_OWNER__' 'tu-usuario-de-github' README.md docs .github
sd '__STAGING_URL__' 'https://tu-staging.onrender.com' README.md
sd '__PRODUCTION_URL__' 'https://tu-produccion.onrender.com' README.md
```

(`sd` es opcional: con `sed -i` o el buscar-y-reemplazar de tu editor es lo mismo.)

## 2. Crear el repositorio público y subir `main`

```bash
git remote add origin https://github.com/<usuario>/tema18-cd-pipeline.git
git push -u origin main
```

Comprobación: la pestaña *Actions* muestra el workflow **CI**. Con `main` ya subido, CI construye y
publica la imagen en GHCR (job *Build image*). Hasta que no configures nada más, `preview` se salta
con un aviso y los CD se saltan el paso de Render con un aviso: no fallan.

## 3. Entornos, variables y protección de `main`

```bash
gh auth login
STAGING_APP_URL=https://tu-staging.onrender.com \
STAGING_RENDER_SERVICE_ID=srv-xxxxxxxx \
PRODUCTION_APP_URL=https://tu-produccion.onrender.com \
PRODUCTION_RENDER_SERVICE_ID=srv-yyyyyyyy \
scripts/setup-github.sh
```

El script es idempotente (puedes repetirlo) y con `DRY_RUN=1` solo imprime lo que haría. Crea:

- Entornos `preview`, `staging` (solo rama `main`, sin revisores) y `production` (solo `main`,
  tú como revisor obligatorio, espera de 1 minuto: `WAIT_TIMER_MINUTES=5` para los 5 del
  enunciado, y sin impedir la auto-aprobación porque solo hay una cuenta).
- Variables `APP_URL`, `NODE_ENV` y `RENDER_SERVICE_ID` en `staging` y `production`.
- Permisos por defecto del `GITHUB_TOKEN` en solo lectura.
- Protección de `main`: PR obligatorio, 1 aprobación, code owners, check requerido **CI OK**,
  rama al día, conversaciones resueltas, sin force-push. `enforce_admins` está desactivado a
  propósito: con una sola cuenta, el merge se hace con "bypass" de administrador.

Si todavía no tienes las URLs, ejecútalo igualmente y repítelo después: las variables sin valor se
avisan, no se crean vacías. Los *required reviewers* en repositorios privados exigen un plan de
pago; en un repositorio público funcionan en el plan gratuito.

## 4. Secretos

El script no los crea (los valores no deben pasar por él):

```bash
gh secret set DISCORD_WEBHOOK_URL
gh secret set VERCEL_TOKEN
gh secret set VERCEL_ORG_ID
gh secret set VERCEL_PROJECT_ID
gh secret set VERCEL_AUTOMATION_BYPASS_SECRET
gh secret set RENDER_API_KEY --env staging
gh secret set RENDER_API_KEY --env production
```

| Nombre | Ámbito | Para qué | De dónde sale |
| --- | --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | repositorio | notificaciones | Discord: *Ajustes del canal → Integraciones → Webhooks* |
| `VERCEL_TOKEN` | repositorio | CLI de Vercel en previews | vercel.com/account/tokens |
| `VERCEL_ORG_ID` | repositorio | idem | `.vercel/project.json` tras `vercel link` (`orgId`) |
| `VERCEL_PROJECT_ID` | repositorio | idem | `.vercel/project.json` (`projectId`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | repositorio | smoke test de la preview | Vercel: *Settings → Deployment Protection → Protection Bypass for Automation* |
| `RENDER_API_KEY` | entorno `staging` | desplegar en Render | Render: *Account Settings → API Keys* |
| `RENDER_API_KEY` | entorno `production` | idem (puedes usar otra clave) | idem |
| `GITHUB_TOKEN` | automático | GHCR, deployments, comentarios, releases | no hay que crearlo |

| Variable | Ámbito | Valor |
| --- | --- | --- |
| `RENDER_SERVICE_ID` | `staging` y `production` | `srv-...`, aparece en la URL del servicio en Render |
| `APP_URL` | `staging` y `production` | URL pública del servicio, sin barra final |
| `NODE_ENV` | `staging` y `production` | `staging` / `production`, como pide el enunciado (referencia: el pipeline no lo lee) |

## 5. Render (dos servicios de imagen)

Hazlo después de que CI haya publicado la primera imagen.

1. *New → Web Service → Existing Image* con `ghcr.io/<usuario>/tema18-cd-pipeline:main`.
2. **Haz público el paquete** en GitHub (*Packages → tema18-cd-pipeline → Package settings →
   Change visibility*), o añade en Render una credencial de registro con `read:packages`. Sin una
   de las dos cosas Render no puede bajar la imagen.
3. *Health Check Path*: `/health`. Variables del servicio: `APP_ENV=staging` (o `production`) y
   `NODE_ENV=production` (en el servicio de Render se deja `production` también en staging: es lo
   que espera Express; la etiqueta del entorno la da `APP_ENV`). Render inyecta `PORT`.
4. Repite para producción. Anota ambos `srv-...` y URLs para el paso 3.
5. El plan gratuito duerme el servicio tras un rato sin tráfico: el primer acceso tarda (arranque en
   frío). El health check con reintentos del pipeline lo tolera; el badge de versión desplegada
   puede tardar en cargar.

## 6. Vercel (solo previews)

1. Crea el proyecto con `vercel link` **sin conectar el repositorio de Git** (si lo conectas,
   Vercel desplegará por su cuenta además del workflow y tendrás dos previews por PR).
2. Framework preset: *Other*. El `vercel.json` del repositorio ya fija la configuración.
3. Activa *Protection Bypass for Automation* y copia el secreto.

## 7. Primer ciclo completo

1. Abre una PR → CI → comentario con la preview.
2. Haz el merge (bypass de administrador) → CI publica la imagen → **CD Staging** despliega.
3. Prueba el camino de fallo: *Actions → CD Staging → Run workflow* con `simulate_failure`.
4. *Actions → CD Production → Run workflow* con `version` `v1.0.0` → aprueba el despliegue en la
   pantalla del run → se crea la Release.
