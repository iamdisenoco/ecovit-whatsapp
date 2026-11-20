import { getRequestConfig } from 'next-intl/server';

const SUPPORTED_LOCALES = ['en', 'pt', 'es', 'ko'] as const;

export default getRequestConfig(async () => {
  // ECOVIT: español fijo. Sin la variable (o con un valor desconocido) va
  // `es`, no `en` como en wacrm. Tiene que coincidir con el alias del
  // catálogo en next.config.ts: next-intl usa el locale también para fechas.
  const requestedLocale = process.env.NEXT_PUBLIC_APP_LOCALE;
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(
    requestedLocale ?? ''
  )
    ? (requestedLocale as (typeof SUPPORTED_LOCALES)[number])
    : 'es';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Si faltara el catálogo pedido, el español.
    messages = (await import(`../../messages/es.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
