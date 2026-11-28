// ============================================================
// El cliente con clave de servicio del webhook, con tiempo máximo por llamada.
//
// Zernio pide respuesta en < 5 s. Sin tope, una base lenta tenía al webhook 7 s
// en fallar (medido con `next dev` y una base inexistente). Cada llamada a
// Supabase se corta a los 1,5 s; el presupuesto total del webhook (3,5 s) está
// en `manejador.ts`.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const TIEMPO_POR_LLAMADA_MS = 1500;

let cliente: SupabaseClient | null = null;

/** `fetch` con corte: el del llamador (si trae) y el nuestro, el que llegue primero. */
export function fetchConTope(
  ms: number,
  base: typeof fetch = fetch
): typeof fetch {
  return (entrada, init = {}) => {
    const tope = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, tope]) : tope;
    return base(entrada, { ...init, signal });
  };
}

export function clienteServicioWebhook(): SupabaseClient {
  cliente ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchConTope(TIEMPO_POR_LLAMADA_MS) },
    }
  );
  return cliente;
}

/** Lo que sube el historial a Storage: un archivo de 16 MB no puede colgar el tramo. */
export const TIEMPO_SUBIDA_HISTORIAL_MS = 15_000;

let clienteHistorial: SupabaseClient | null = null;

/** El cliente con clave de servicio para Storage del historial, con tope por llamada. */
export function clienteServicioHistorial(): SupabaseClient {
  clienteHistorial ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchConTope(TIEMPO_SUBIDA_HISTORIAL_MS) },
    }
  );
  return clienteHistorial;
}
