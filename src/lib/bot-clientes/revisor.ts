// ============================================================
// «La IA extrae y el código confirma» (cruce-hu28.md). El precio NUNCA lo
// escribe el modelo: escribe la marca [[PRECIO:<código>]] y el código la cambia
// por T9 con el `precio_base` que devolvió `catalogo_cliente_wa` EN ESTE TURNO.
// Si la marca apunta a algo que no se consultó o que no tiene precio, o si
// queda en el texto algo que parece plata, la respuesta no sale: el chat pasa
// a una persona con T4 (antes pasar que adivinar).
// ============================================================

import { t9PrecioLista } from './textos';

export interface ReferenciaCatalogo {
  codigo: string;
  descripcion: string;
  unidad: string | null;
  precio_base: number | null;
  disponibilidad?: unknown;
  foto_path?: string | null;
}

export type Revision =
  | { ok: true; texto: string }
  | { ok: false; motivo: string };

const MARCA = /\[\[PRECIO:([^\]]+)\]\]/g;
/**
 * El modelo NO ve precios, así que su texto no lleva ninguna cifra de plata.
 * Se frena, con o sin moneda y con o sin separadores:
 *  · signo o moneda ($, COP, pesos, USD, dólares, lucas, palos);
 *  · «N mil», «N millón/millones», «N mill», «N k» («148 mil», «1.5 millones», «150k»);
 *  · cualquier número de 4 cifras o más («148000», «148.000», «148 000»).
 * Pasa: cantidades de hasta 3 cifras («200 unidades», «3 disponibles») y los
 * códigos de referencia (los consultados, y los que empiezan por letras como
 * «FX-1234»). Ante la duda, frena: el chat pasa a una persona.
 */
const MONEDA = /\$|\bcop\b|\bpesos?\b|\busd\b|\bd[oó]lares?\b|\blucas?\b|\bpalos?\b/i;
const MAGNITUD = /\d(?:[.,]\d+)?\s*(?:mil\b|mill[oó]n(?:es)?\b|mill\b|k\b)/i;
const CODIGO_CON_LETRAS = /\b[A-Za-zÁÉÍÓÚÑáéíóúñ]+[-_/.]?\d[\w./-]*/g;
const CUATRO_CIFRAS = /\d(?:[.,\s]?\d){3,}/;

export function pareceCifraDePlata(texto: string): boolean {
  if (MONEDA.test(texto) || MAGNITUD.test(texto)) return true;
  return CUATRO_CIFRAS.test(texto.replace(CODIGO_CON_LETRAS, ' '));
}

export function revisarRespuesta(
  texto: string,
  consultadas: Map<string, ReferenciaCatalogo>
): Revision {
  const limpio = texto.trim();
  if (!limpio) return { ok: false, motivo: 'respuesta vacía' };

  // Lo que escribió el modelo, sin las marcas y sin los códigos consultados
  // (un código puede tener números con puntos y no es plata).
  let suyo = limpio.replace(MARCA, ' ');
  for (const codigo of consultadas.keys()) suyo = suyo.split(codigo).join(' ');
  if (pareceCifraDePlata(suyo)) {
    return { ok: false, motivo: 'el modelo escribió una cifra de plata' };
  }

  let fallo: string | null = null;
  const final = limpio.replace(MARCA, (_, crudo: string) => {
    const ref = consultadas.get(crudo.trim());
    if (!ref) {
      fallo ??= `precio de una referencia no consultada (${crudo.trim()})`;
      return '';
    }
    if (ref.precio_base === null || !(ref.precio_base > 0)) {
      fallo ??= `la referencia ${ref.codigo} no tiene precio de lista`;
      return '';
    }
    return t9PrecioLista(ref.precio_base, ref.unidad);
  });
  if (fallo) return { ok: false, motivo: fallo };
  return { ok: true, texto: final.replace(/[ \t]+\n/g, '\n').trim() };
}
