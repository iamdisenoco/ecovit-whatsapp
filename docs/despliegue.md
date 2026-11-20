# Despliegue de ECOVIT · Conversaciones

Lo que hay que crear a mano antes del primer despliegue. Esta app usa la misma base de Supabase
de ECOVIT. Las migraciones están en el repo `ecovit-comercial` (0110 a 0115) y se aplican allá,
**antes** de desplegar esta app con Zernio prendido.

## 1. Vercel: proyecto nuevo

- Importar `iamdisenoco/ecovit-whatsapp` (framework Next.js, rama `main`).
- **Despliegues automáticos:** `vercel.json` trae `"git": { "deploymentEnabled": false }` para que
  no salga nada antes de tiempo. Se pasa a `true` en un PR cuando las variables estén puestas.
- **Plan:** el cron `/api/whatsapp/cron` corre cada 5 minutos. En Hobby, Vercel solo permite crons
  diarios: con Hobby hay que cambiarlo a una vez al día (los envíos dudosos tardan más en marcarse).
- **Dominio propio** (necesita el «confirmo» de Jon): un subdominio del mismo dominio de ECOVIT,
  por ejemplo `whatsapp.<dominio>`. Sin dominio compartido la sesión de ECOVIT no sirve acá.

## 2. Vercel: variables de entorno (Production)

| Variable | Valor | Secreta |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | la misma de ECOVIT | no |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | la misma de ECOVIT | no |
| `SUPABASE_SERVICE_ROLE_KEY` | la clave de servicio de ECOVIT | **sí** |
| `NEXT_PUBLIC_ECOVIT_URL` | raíz de la app comercial, sin barra final | no |
| `NEXT_PUBLIC_COOKIE_DOMAIN` | `.<dominio>`, igual en ECOVIT | no |
| `NEXT_PUBLIC_APP_LOCALE` | `es` | no |
| `NEXT_PUBLIC_SITE_URL` | la URL pública de esta app | no |
| `ENCRYPTION_KEY` | 64 caracteres hex (`openssl rand -hex 32`) | **sí** |
| `CRON_SECRET` | cadena larga al azar | **sí** |
| `AUTOMATION_CRON_SECRET` | cadena larga al azar (esperas de automatizaciones) | **sí** |
| `WHATSAPP_PROVEEDOR` | `zernio` | no |
| `ZERNIO_API_KEY` | la llave de la API de Zernio | **sí** |
| `ZERNIO_ACCOUNT_ID` | el id de la cuenta de WhatsApp conectada en Zernio | no |
| `ZERNIO_WEBHOOK_SECRET` | el secreto de firma del webhook de Zernio | **sí** |
| `META_APP_SECRET` | solo si se usa Meta directo; con Zernio puede quedar vacía | **sí** |

**En la app de ECOVIT** (producción, con el «confirmo» de Jon) hay que poner los mismos
`NEXT_PUBLIC_COOKIE_DOMAIN` y `ORIGENES_VOLVER_PERMITIDOS=https://whatsapp.<dominio>`.

## 3. Zernio

1. Conectar el número de ECOVIT en **coexistencia** (guía:
   `ecovit-comercial/docs/guias/whatsapp-zernio.md`). Sale el `ZERNIO_ACCOUNT_ID`.
2. Crear la llave de la API, que va en `ZERNIO_API_KEY`.
3. Crear el webhook con la URL `https://whatsapp.<dominio>/api/whatsapp/webhook`, los eventos de
   mensajes (entrantes, enviados y estados) y un secreto de firma, que va en
   `ZERNIO_WEBHOOK_SECRET`.

## 4. El bot (después, con su propio «confirmo»)

- La llave de Claude **no va en Vercel**: se guarda cifrada en Ajustes → IA (`ai_configs`), con
  proveedor `anthropic`.
- Para prenderlo hacen falta tres decisiones de Jon:
  - la cifra del tope mensual (`bot_wa_tope_usd_mes`);
  - los textos aprobados;
  - la lista blanca (`agregar_lista_blanca_wa`).
- Mientras el tope no esté definido, el bot, la respuesta sugerida y el playground no gastan.
