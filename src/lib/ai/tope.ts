// ============================================================
// ECOVIT · RF-M03.11: el tope mensual de gasto en la IA vale para todo lo que
// llama a Claude con la llave de la empresa: el bot (lo mira la base,
// `bot_puede_contestar_wa`), el borrador y el playground (lo mira esto, ANTES
// de gastar). La misma regla que `_gasto_ia_wa_mes` (0114): mes de Bogotá con
// sus dos bordes, `>=` contra el tope, y sin tope definido no se gasta.
// `_gasto_ia_wa_mes` no se puede llamar desde la app (ni con `service_role`),
// así que se suma aquí.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/supabase/paged-query';
import { mesBogota, sumarUsd } from './gasto';

export type EstadoTope =
  | { ok: true; gastadoUsd: number; topeUsd: number }
  | { ok: false; motivo: 'tope_sin_definir' | 'tope_alcanzado' | 'error'; mensaje: string };

export async function revisarTopeMensual(
  admin: SupabaseClient,
  accountId: string,
  ahora: Date = new Date()
): Promise<EstadoTope> {
  try {
    const { data: param, error } = await admin
      .from('parametros')
      .select('valor, definido')
      .eq('clave', 'bot_wa_tope_usd_mes')
      .maybeSingle();
    if (error) throw new Error(error.message);
    const p = param as { valor: string | null; definido: boolean } | null;
    const tope = p?.definido && p.valor ? Number(String(p.valor).replace(',', '.')) : NaN;
    if (!Number.isFinite(tope)) {
      return {
        ok: false,
        motivo: 'tope_sin_definir',
        mensaje:
          'La IA no está disponible: falta definir el tope de gasto mensual (Ajustes de ECOVIT, «Tope mensual del bot de WhatsApp»).',
      };
    }
    const mes = mesBogota(ahora);
    const filas = await fetchAllPages<{ costo_usd: number | string | null }>((from, to) =>
      admin
        .from('ai_usage_log')
        .select('costo_usd')
        .eq('account_id', accountId)
        .gte('created_at', mes.desde)
        .lt('created_at', mes.hasta)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
    );
    const gastado = sumarUsd(filas);
    if (gastado >= tope) {
      return {
        ok: false,
        motivo: 'tope_alcanzado',
        mensaje: `Se llegó al tope de gasto de la IA de este mes (USD ${tope}). Vuelve a estar disponible el mes que viene o si la dirección sube el tope.`,
      };
    }
    return { ok: true, gastadoUsd: gastado, topeUsd: tope };
  } catch (err) {
    // Ante la duda, no se gasta.
    console.error('[ai/tope] no se pudo revisar el tope:', err instanceof Error ? err.message : err);
    return {
      ok: false,
      motivo: 'error',
      mensaje: 'No se pudo revisar el tope de gasto de la IA. Inténtalo en un momento.',
    };
  }
}
