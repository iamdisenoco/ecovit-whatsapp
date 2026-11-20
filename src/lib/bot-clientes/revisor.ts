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
/** Lo que parece plata: signo, moneda o un número con separador de miles. */
const PARECE_PLATA = /\$|\bcop\b|\bpesos?\b|\busd\b|\bd[oó]lares?\b|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b/i;

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
  if (PARECE_PLATA.test(suyo)) {
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
