// ============================================================
// ECOVIT · bloque 4: cómo asigna un chat un motor (automatización, flujo o
// la IA). Con la clave de servicio, pero por `asignar_conversacion_motor`
// (0113): la reja `zy_asignado_solo_por_funcion` rechaza el `update` directo
// del asignado, y la función anota en `bitacora` y deja el aviso para Gota.
//
// `p_dueno_visto` va en null: el motor solo asigna chats SIN dueño (o que ya
// tiene ese mismo agente). Si una persona lo tiene, no se lo quita y devuelve
// `false`. No es un error: el motor sigue con lo suyo.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type OrigenMotor = 'automatizacion' | 'flujo' | 'ia';

/** `true` si el chat quedó con ese agente; `false` si no (o si falló, que se anota). */
export async function asignarPorMotor(
  db: SupabaseClient,
  conversationId: string,
  agenteAuthId: string,
  origen: OrigenMotor
): Promise<boolean> {
  const { data, error } = await db.rpc('asignar_conversacion_motor', {
    p_conversacion: conversationId,
    p_agente: agenteAuthId,
    p_origen: origen,
    p_dueno_visto: null,
  });
  if (error) {
    console.error(
      `[motores] no se pudo asignar el chat ${conversationId} (${origen}):`,
      error.message
    );
    return false;
  }
  return data === true;
}
