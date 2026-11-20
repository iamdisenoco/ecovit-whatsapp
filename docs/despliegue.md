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

## Demo sin base

Para enseñar la bandeja sin Supabase, sin Zernio y sin la IA: la app entera corre con datos
ficticios (constructoras inventadas) en la memoria del navegador. Se puede abrir chats, tomarlos,
asignarlos, pausar y retomar el bot, contestar y mirar el gasto de IA. Nada se guarda ni sale por
la red; recargar la página vuelve a los datos de arranque.

- **Variable:** `NEXT_PUBLIC_MODO_MUESTRA=1` (no es secreta). Tiene que estar puesta **antes del
  build**, porque Next la escribe en el código al compilar. Con el modo prendido no hace falta
  ninguna variable de Supabase, y las que haya se ignoran.
- **Entrada:** `/muestra`, que lleva a la bandeja (`/inbox`). Arriba sale la marca «Demostración».
- **Sin la variable** (o con otro valor que no sea `1`), `/muestra` da 404 y la app es la de
  siempre.
- En el modo muestra las rutas `/api` responden 404: la demostración no las usa, y así ni el cron
  ni los webhooks hacen nada.
- Los enlaces del panel del cliente a ECOVIT solo aparecen si además está
  `NEXT_PUBLIC_ECOVIT_URL`; sin ella el panel dice que falta (los clientes de la demo no existen
  en ECOVIT).
- En Vercel, la rama `claude/muestra-panel` trae en `vercel.json` los despliegues automáticos
  prendidos solo para ella. La variable se pone en Vercel para ese entorno (Preview, rama
  `claude/muestra-panel`).
- Para ver la demo en local: `NEXT_PUBLIC_MODO_MUESTRA=1 npm run build && NEXT_PUBLIC_MODO_MUESTRA=1
  npx next start`, y abrir `http://localhost:3000/muestra`. `scripts/capturas-muestra.mjs` saca
  las capturas de `docs/capturas/panel/` y recorre los clics.
