// ============================================================
// ECOVIT · bloque 5: el barrido periódico de WhatsApp (0115).
//   · `marcar_envios_inciertos_wa`: un envío que quedó en `sending` sin wamid
//     (el proveedor no respondió) pasa a `incierto` a los N minutos, en vez de
//     decir «enviando» para siempre;
//   · `limpiar_eventos_wa`: los eventos ya procesados de más de 7 días;
//   · `limpiar_estados_pendientes_wa`: el búfer de estados que nunca encontró
//     su mensaje.
// Las tres son solo de `service_role`. Una que falla no tumba a las otras.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** 503 sin secreto configurado; 401 con uno que no coincide; null si pasa. */
export function revisarSecretoCron(
  autorizacion: string | null,
  esperado: string | undefined
): { status: 503 | 401; error: string } | null {
  if (!esperado) return { status: 503, error: 'El cron no está configurado (falta CRON_SECRET).' };
  const dado = Buffer.from(autorizacion ?? '');
  const debe = Buffer.from(`Bearer ${esperado}`);
  if (dado.length !== debe.length || !timingSafeEqual(dado, debe)) {
    return { status: 401, error: 'No autorizado' };
  }
  return null;
}

const TAREAS = [
  ['inciertos', 'marcar_envios_inciertos_wa', { p_minutos: 2 }],
  ['eventos', 'limpiar_eventos_wa', { p_dias: 7 }],
  ['estados_pendientes', 'limpiar_estados_pendientes_wa', { p_dias: 7 }],
] as const;

export async function barrerWhatsApp(
  db: SupabaseClient
): Promise<{ resultado: Record<string, number | null>; errores: string[] }> {
  const resultado: Record<string, number | null> = {};
  const errores: string[] = [];
  for (const [nombre, fn, args] of TAREAS) {
    const { data, error } = await db.rpc(fn, args);
    if (error) {
      resultado[nombre] = null;
      errores.push(`${fn}: ${error.message}`);
    } else {
      resultado[nombre] = typeof data === 'number' ? data : null;
    }
  }
  return { resultado, errores };
}
