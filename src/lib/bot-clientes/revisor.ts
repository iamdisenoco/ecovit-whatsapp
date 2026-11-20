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
 *  · cualquier número de 4 cifras o más («148000», «148.000», «148 000»);
 *  · cifras en palabras desde «cien» («ciento cincuenta mil», «novecientos»);
 *  · porcentajes («10%», «quince por ciento») y cualquier mención de descuento;
 *  · un número, aunque sea chico, pegado a cuesta, vale, precio, cada uno, la
 *    unidad o c/u («Cuesta 950», «850 cada uno»).
 * Pasa: cantidades de hasta 3 cifras («200 unidades», «3 disponibles») y los
 * códigos de referencia (los consultados, y los que empiezan por letras como
 * «FX-1234»). Ante la duda, frena: el chat pasa a una persona.
 */
// `\b` de JS no conoce las tildes: los bordes de palabra van a mano.
const L = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const palabra = (alternativas: string) =>
  new RegExp(`(?<![${L}])(?:${alternativas})(?![${L}])`, 'i');

const MONEDA = palabra('cop|pesos?|usd|d[oó]lares?|lucas?|palos?');
const MAGNITUD = /\d(?:[.,]\d+)?\s*(?:mil|mill[oó]n(?:es)?|mill|k)(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/i;
/** Cifras en palabras desde «cien» para arriba (y «mil», «millones» solos). */
const CIFRA_EN_PALABRAS = palabra(
  'cien|cientos?|doscient[oa]s|trescient[oa]s|cuatrocient[oa]s|quinient[oa]s|seiscient[oa]s|setecient[oa]s|ochocient[oa]s|novecient[oa]s|mil|miles|mill[oó]n|millones|millardos?|bill[oó]n|billones'
);
/** Porcentajes y descuentos: el bot no negocia (T5 lo dice el código). */
const PORCENTAJE = /%|(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])por\s*ciento(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/i;
const DESCUENTO = palabra('descuentos?|rebajas?|promoci[oó]n(?:es)?|oferta');
/** Un número (aunque sea chico) pegado a una palabra de precio. */
const NUMERO_CON_PRECIO = new RegExp(
  `(?<![${L}])(?:cuestan?|valen?|precio|valor|sale[n]?\\s+(?:en|a)|a\\s+solo)(?![${L}])[^\\d\\n]{0,15}\\d` +
    `|\\d[\\d.,]*\\s*(?:c\\s*/\\s*u|cada\\s+un[oa]|la\\s+unidad|por\\s+unidad|x\\s+unidad|el\\s+metro|la\\s+caja)(?![${L}])`,
  'i'
);
const CODIGO_CON_LETRAS = /\b[A-Za-zÁÉÍÓÚÑáéíóúñ]+[-_/.]?\d[\w./-]*/g;
const CUATRO_CIFRAS = /\d(?:[.,\s]?\d){3,}/;

/**
 * Ante la duda, frena: el texto pasa a una persona. Mejor un falso positivo
 * (un chat que atiende un vendedor) que una cifra de plata dicha por la IA.
 */
export function pareceCifraDePlata(texto: string): boolean {
  if (texto.includes('$')) return true;
  if (
    MONEDA.test(texto) ||
    MAGNITUD.test(texto) ||
    CIFRA_EN_PALABRAS.test(texto) ||
    PORCENTAJE.test(texto) ||
    DESCUENTO.test(texto) ||
    NUMERO_CON_PRECIO.test(texto)
  ) {
    return true;
  }
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
