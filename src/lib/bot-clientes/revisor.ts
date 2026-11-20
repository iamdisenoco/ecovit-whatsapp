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

// ── El criterio (tercera revisión): LISTA BLANCA, no lista negra ─────────────
// Una lista de formas de decir plata no se cierra nunca («9 con 900», «148
// lukas», «45 bucks»). Así que:
//  1. Todo número del texto del modelo, en dígitos o como cantidad en palabras,
//     pasa SOLO si aparece en lo que devolvieron las herramientas en este turno
//     (`permitidos`: códigos, existencias, medidas, unidades). Lo que dijo el
//     cliente NO cuenta: si contara, «¿me lo dejas en 120?» → «sí, en 120»
//     pasaría. Y `permitidos` es lo que vio el modelo, que no trae precios.
//  2. Freno absoluto, aunque el número esté permitido: monedas y símbolos de
//     plata, porcentajes y descuentos.
//  3. Una palabra numérica que no es cantidad no frena: «cien por cien
//     cerámica», «mil cosas», «dos modelos». Es cantidad si va pegada a otro
//     número («ciento cincuenta», «9 con 900», «doce mil»), detrás de una
//     palabra de precio («en mil», «vale veinte»), o si es de «cien» para
//     arriba (salvo «mil» suelto y el modismo «cien por cien»).
// El precio lo pone el código con T9, DESPUÉS de esto.

const MONEDA =
  /[$€£¥₡]|(?<!\p{L})(?:cop|usd|eur|euros?|d[oó]lares?|bucks?|pesos?|lucas?|lukas?|palos?|plata|precio\s+especial)(?!\p{L})/iu;
const PORCENTAJE = /%|(?<!\p{L})(?:por\s*ciento|porcentaje)(?!\p{L})/iu;
const DESCUENTO = /(?<!\p{L})(?:descuentos?|descontar|descuento|rebajas?|rebajar)(?!\p{L})/iu;
/** Dígitos con magnitud pegada: «150k», «2M», «12mil». */
const MAGNITUD = /\d(?:[.,]\d+)?\s*(?:k|m|mil|mill[oó]n(?:es)?|mill)(?!\p{L})/iu;

const PALABRAS_NUMERO = new Set(
  (
    'uno una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince ' +
    'dieciseis dieciséis diecisiete dieciocho diecinueve veinte veintiuno veintiuna veintidos veintidós ' +
    'veintitres veintitrés veinticuatro veinticinco veintiseis veintiséis veintisiete veintiocho veintinueve ' +
    'treinta cuarenta cincuenta sesenta setenta ochenta noventa cien ciento ' +
    'doscientos doscientas trescientos trescientas cuatrocientos cuatrocientas quinientos quinientas ' +
    'seiscientos seiscientas setecientos setecientas ochocientos ochocientas novecientos novecientas ' +
    'mil miles millon millón millones'
  ).split(' ')
);
/** Unen dos números en una cantidad: «ciento y pico», «9 con 900», «3 punto 5». */
const UNIONES = new Set(['y', 'con', 'punto', 'coma']);
/** Detrás de estas, una palabra numérica es una cantidad (de plata, casi siempre). */
const DE_PRECIO = new Set([
  'en', 'a', 'por', 'cuesta', 'cuestan', 'vale', 'valen', 'sale', 'salen', 'queda', 'quedan',
  'dejo', 'dejamos', 'deja', 'precio', 'valor', 'total', 'pagas', 'pagar', 'cobra', 'cobramos',
]);
/** Desde «cien» (sin «mil», que tiene «mil cosas»): siempre cantidad. */
const GRANDES = /^(?:cien|ciento|\p{L}*cient[oa]s|mill[oó]n|millones)$/u;
/** «un/una/uno» detrás de «en», «a», «por» es lenguaje corriente («en una semana»). */
const ARTICULOS = new Set(['un', 'uno', 'una']);
/** Frases hechas que no son cantidades. */
const MODISMOS = /(?<!\p{L})cien\s+por\s+cien(?!\p{L})/giu;

const DIGITOS = /\d+(?:[.,]\d+)*/g;

function normalizarNumero(n: string): string[] {
  // «1.020» y «1020» son el mismo número; «3.5» y «3,5» también.
  return [n, n.replace(/[.,]/g, ''), n.replace(',', '.')];
}

/** Los números (y palabras) que aparecen en lo que vio el modelo de las herramientas. */
export function listaBlanca(permitidos: string): { numeros: Set<string>; palabras: Set<string> } {
  const numeros = new Set<string>();
  for (const n of permitidos.match(DIGITOS) ?? []) for (const v of normalizarNumero(n)) numeros.add(v);
  // Cada tramo de dígitos suelto también («FX-1020/3» → 1020 y 3).
  for (const n of permitidos.match(/\d+/g) ?? []) numeros.add(n);
  const palabras = new Set((permitidos.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => PALABRAS_NUMERO.has(w)));
  return { numeros, palabras };
}

/** null si pasa; si no, por qué se frena. */
export function numeroNoPermitido(texto: string, permitidos: string): string | null {
  if (MONEDA.test(texto)) return 'moneda o símbolo de plata';
  if (PORCENTAJE.test(texto)) return 'porcentaje';
  if (DESCUENTO.test(texto)) return 'descuento';
  if (MAGNITUD.test(texto)) return 'cifra con magnitud';

  const blanca = listaBlanca(permitidos);
  for (const n of texto.match(DIGITOS) ?? []) {
    if (!normalizarNumero(n).some((v) => blanca.numeros.has(v))) {
      return `el número ${n} no lo devolvió el catálogo`;
    }
  }

  const tokens = (texto.replace(MODISMOS, ' ').toLowerCase().match(/\p{L}+|\d+(?:[.,]\d+)*/gu) ?? []);
  const esNumero = (t: string | undefined) => !!t && (/^\d/.test(t) || PALABRAS_NUMERO.has(t));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!PALABRAS_NUMERO.has(t) || blanca.palabras.has(t)) continue;
    const antes = tokens[i - 1];
    const despues = tokens[i + 1];
    const pegada =
      esNumero(antes) ||
      esNumero(despues) ||
      (UNIONES.has(antes ?? '') && esNumero(tokens[i - 2])) ||
      (UNIONES.has(despues ?? '') && esNumero(tokens[i + 2]));
    const detrasDePrecio = DE_PRECIO.has(antes ?? '') && !ARTICULOS.has(t);
    if (GRANDES.test(t) || pegada || detrasDePrecio) {
      return `la cantidad «${t}» no la devolvió el catálogo`;
    }
  }
  return null;
}

/** Compatibilidad: ¿hay algo de plata, sin nada permitido? */
export function pareceCifraDePlata(texto: string): boolean {
  return numeroNoPermitido(texto, '') !== null;
}

/**
 * `permitidos` es EXACTAMENTE lo que el modelo recibió de las herramientas en
 * este turno (sin precios). Los mensajes del cliente no entran.
 */
export function revisarRespuesta(
  texto: string,
  consultadas: Map<string, ReferenciaCatalogo>,
  permitidos = ''
): Revision {
  const limpio = texto.trim();
  if (!limpio) return { ok: false, motivo: 'respuesta vacía' };

  // Lo que escribió el modelo, sin las marcas de precio (esas las cambia el código).
  const suyo = limpio.replace(MARCA, ' ');
  const problema = numeroNoPermitido(suyo, permitidos);
  if (problema) return { ok: false, motivo: problema };

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
