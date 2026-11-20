// ============================================================
// Lo que cuesta cada llamada del bot a Claude (RF-M03.11), con los tokens
// reales que devuelve la API (`usage`). La 0114 guarda aparte el caché
// (`cache_lectura_tokens`, `cache_escritura_tokens`) y el costo en USD.
//
// En la API de Anthropic `input_tokens` NO incluye el caché: son tres cifras
// separadas, cada una con su tarifa. Sonnet 5.5, en USD por millón de tokens:
//   entrada 2 · salida 10 · caché leído 0,10 · caché escrito (5 min) 2,50
// (escribir el caché cuesta 1,25 veces la entrada). Si cambian las tarifas,
// cambian aquí y en ningún otro lado.
// ============================================================

export const MODELO_BOT = 'claude-sonnet-5-5';

export const TARIFA_USD_POR_MILLON = {
  entrada: 2,
  salida: 10,
  cacheLectura: 0.1,
  cacheEscritura: 2.5,
} as const;

export interface UsoClaude {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

/** El `usage` de la respuesta, tolerante a campos que falten. */
export function leerUso(usage: unknown): UsoClaude {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    entrada: n(u.input_tokens),
    salida: n(u.output_tokens),
    cacheLectura: n(u.cache_read_input_tokens),
    cacheEscritura: n(u.cache_creation_input_tokens),
  };
}

/** En USD, redondeado a la escala de `ai_usage_log.costo_usd` (numeric(10,6)). */
export function costoUsd(uso: UsoClaude): number {
  const t = TARIFA_USD_POR_MILLON;
  const bruto =
    (uso.entrada * t.entrada +
      uso.salida * t.salida +
      uso.cacheLectura * t.cacheLectura +
      uso.cacheEscritura * t.cacheEscritura) /
    1_000_000;
  return Math.round(bruto * 1_000_000) / 1_000_000;
}

export function sumarUso(a: UsoClaude, b: UsoClaude): UsoClaude {
  return {
    entrada: a.entrada + b.entrada,
    salida: a.salida + b.salida,
    cacheLectura: a.cacheLectura + b.cacheLectura,
    cacheEscritura: a.cacheEscritura + b.cacheEscritura,
  };
}
