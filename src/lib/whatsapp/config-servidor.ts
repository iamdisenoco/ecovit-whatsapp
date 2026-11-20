// ============================================================
// Lecturas de `whatsapp_config` con la clave de servicio, en el servidor.
//
// En la base de ECOVIT (migración 0110, B9) las llaves de `whatsapp_config`,
// `ai_configs` y `webhook_endpoints` no se leen con sesión, ni la dirección:
// `select *` da 42501 («permission denied»). Toda lectura de esas tablas pasa
// por aquí o por la clave de servicio, NOMBRANDO las columnas.
//
// Quien llama ya resolvió la cuenta con la sesión (`requireRole`), así que leer
// con la clave de servicio filtrando por `account_id` no le muestra a nadie una
// cuenta que no es la suya: ECOVIT tiene una sola. Solo servidor: usa la clave
// de servicio y descifra el token.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';

/** Las columnas que no son secretas (las mismas que la 0110 deja leer a la dirección). */
export const COLUMNAS_PUBLICAS_WHATSAPP_CONFIG =
  'id, user_id, phone_number_id, waba_id, status, connected_at, created_at, updated_at, registered_at, subscribed_apps_at, last_registration_error, account_id, mirror_inbound_media, proveedor, zernio_account_id, conectado_desde';

export interface ConfigWhatsAppPublica {
  id: string;
  user_id: string;
  phone_number_id: string;
  waba_id: string | null;
  status: 'connected' | 'disconnected';
  connected_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  account_id: string;
  mirror_inbound_media: boolean;
  /** 0115: 'meta' o 'zernio'. */
  proveedor: 'meta' | 'zernio';
  zernio_account_id: string | null;
  /** 0115: desde cuándo está conectado (obligatorio con Zernio). */
  conectado_desde: string | null;
}

export async function leerConfigWhatsApp(
  accountId: string
): Promise<ConfigWhatsAppPublica | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(COLUMNAS_PUBLICAS_WHATSAPP_CONFIG)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error)
    throw new Error(`No se pudo leer whatsapp_config: ${error.message}`);
  return (data as ConfigWhatsAppPublica | null) ?? null;
}

export interface CredencialesMeta {
  configId: string;
  phoneNumberId: string;
  wabaId: string | null;
  /** Ya descifrado. Nunca sale del servidor. */
  accessToken: string;
  status: string;
  userId: string;
}

/** Lo que necesita el adaptador de Meta. `null` si la cuenta no tiene número de Meta. */
export async function leerCredencialesMeta(
  accountId: string
): Promise<CredencialesMeta | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, phone_number_id, waba_id, access_token, status, user_id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error)
    throw new Error(`No se pudo leer whatsapp_config: ${error.message}`);
  if (!data || !data.access_token) return null;
  return {
    configId: data.id,
    phoneNumberId: data.phone_number_id,
    wabaId: data.waba_id ?? null,
    accessToken: decrypt(data.access_token),
    status: data.status,
    userId: data.user_id,
  };
}

/** Todas las columnas que usan las rutas de Meta, nombradas (con las secretas, cifradas). */
const COLUMNAS_FILA_META =
  'id, user_id, account_id, phone_number_id, waba_id, access_token, verify_token, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media';

export interface FilaWhatsAppConfig {
  id: string;
  user_id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  /** Cifrado, como está en la base: quien lo use lo descifra en el servidor. */
  access_token: string;
  verify_token: string | null;
  status: string;
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  mirror_inbound_media: boolean;
}

/**
 * La fila de `whatsapp_config` de la cuenta, con la clave de servicio, con la
 * misma forma `{ data, error }` que devolvía `.single()` con la sesión (que da
 * 42501). Sin fila, `error` dice que no hay configuración, como `.single()`.
 */
export async function leerFilaWhatsAppConfig(accountId: string): Promise<{
  data: FilaWhatsAppConfig | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(COLUMNAS_FILA_META)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) return { data: null, error: { message: error.message } };
  if (!data)
    return {
      data: null,
      error: { message: 'whatsapp_config sin fila para la cuenta' },
    };
  return { data: data as FilaWhatsAppConfig, error: null };
}
