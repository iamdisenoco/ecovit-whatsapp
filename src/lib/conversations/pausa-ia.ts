// ============================================================
// ECOVIT · bloque 4: «Tomar el control» y «Retomar IA» por función.
//
// Desde la 0113 `authenticated` no escribe `ai_autoreply_disabled`,
// `ai_reply_count` ni `ai_handoff_summary` (con el `update` abierto un
// vendedor ponía en cero el cupo de respuestas, que es un control de gasto).
// Todo va por las funciones:
//   · tomar     → `tomar_conversacion` (si el chat no tiene dueño) y
//                 `pausar_ia_conversacion`;
//   · retomar   → `reanudar_ia_conversacion`, que SUELTA el chat y le devuelve
//                 la conversación al bot (y reinicia el cupo solo si el bot la
//                 había pasado a una persona).
//
// `visto` es la marca `actualizado_en` de la MISMA lectura que la pantalla
// mostró (la conversación con su asignado), no una lectura nueva del servidor:
// releerla aquí haría que la condición de versión pase siempre.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type AccionPausaIa =
  | { accion: 'tomar'; visto: string; asignadoVisto: string | null }
  | { accion: 'retomar'; visto: string };

export type ResultadoPausaIa =
  | {
      ok: true;
      pausada: boolean;
      /** Lo que quedó: el asignado y su marca (para la próxima acción). */
      asignado: string | null;
      actualizadoEn: string | null;
    }
  | { ok: false; status: number; error: string };

/** Lee el cuerpo de la petición. `null` si no sirve. */
export function leerAccionPausaIa(body: unknown): AccionPausaIa | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const visto = typeof b.visto === 'string' && b.visto ? b.visto : null;
  if (!visto) return null;
  if (b.accion === 'tomar') {
    const asignado =
      typeof b.asignado_visto === 'string' && b.asignado_visto
        ? b.asignado_visto
        : null;
    return { accion: 'tomar', visto, asignadoVisto: asignado };
  }
  if (b.accion === 'retomar') return { accion: 'retomar', visto };
  return null;
}

export async function ejecutarPausaIa(
  db: SupabaseClient,
  conversationId: string,
  userId: string,
  pedido: AccionPausaIa
): Promise<ResultadoPausaIa> {
  if (pedido.accion === 'retomar') {
    const { data, error } = await db.rpc('reanudar_ia_conversacion', {
      p_conversacion: conversationId,
      p_visto: pedido.visto,
    });
    if (error) return { ok: false, status: 409, error: error.message };
    return {
      ok: true,
      pausada: false,
      asignado: null,
      actualizadoEn: (data as string | null) ?? null,
    };
  }

  // Tomar primero: si otra persona lo tomó en el medio, la función lo dice y
  // no se pausa nada. Si ya tenía dueño en la pantalla, no se toma: se pausa.
  let asignado = pedido.asignadoVisto;
  let marca: string | null = pedido.visto;
  if (!asignado) {
    const { data, error } = await db.rpc('tomar_conversacion', {
      p_conversacion: conversationId,
      p_visto: pedido.visto,
    });
    if (error) return { ok: false, status: 409, error: error.message };
    asignado = userId;
    marca = (data as string | null) ?? marca;
  }

  const { error: pausaErr } = await db.rpc('pausar_ia_conversacion', {
    p_conversacion: conversationId,
  });
  if (pausaErr) {
    // El chat ya quedó tomado: se dice, para que la pantalla no mienta.
    return {
      ok: false,
      status: 409,
      error: `Tomaste el chat, pero la IA no se pausó: ${pausaErr.message}`,
    };
  }
  return { ok: true, pausada: true, asignado, actualizadoEn: marca };
}
