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
//     (`permitidos`: códigos, existencias, medidas, unidades), que no trae
//     precios. Un número que dijo el cliente pasa SOLO como cantidad («los 20
//     te alcanzan»); como precio no: «¿me lo dejas en 120?» → «sí, en 120» frena.
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
export function listaBlanca(permitidos: string): { numeros: Set<string> } {
  const numeros = new Set<string>();
  for (const n of permitidos.match(DIGITOS) ?? []) for (const v of normalizarNumero(n)) numeros.add(v);
  // Cada tramo de dígitos suelto también («FX-1020/3» → 1020 y 3).
  for (const n of permitidos.match(/\d+/g) ?? []) numeros.add(n);
  return { numeros };
}

/** null si pasa; si no, por qué se frena. */
/**
 * Un número que dijo el CLIENTE pasa solo usado como cantidad: «los 20»,
 * «20 unidades/piezas/cajas/metros», «20 te alcanzan». Nunca como precio («sí,
 * en 120»): para eso no hay forma permitida. Lo que el modelo calculó (un
 * total, una suma) no lo dijo nadie y frena.
 */
const CANTIDAD_DESPUES =
  /^\s*(?:unidades?|und|uds?|piezas?|pzas?|cajas?|metros?|mts?|rollos?|juegos?|(?:te\s+|les?\s+)?(?:(?:s[ií]|ya|no)\s+)?(?:te\s+|les?\s+)?(?:alcanzan?|sirven?))(?!\p{L})/iu;
const CANTIDAD_ANTES = /(?<!\p{L})(?:los|las)\s*$/iu;

function comoCantidad(texto: string, inicio: number, fin: number): boolean {
  return CANTIDAD_DESPUES.test(texto.slice(fin)) || CANTIDAD_ANTES.test(texto.slice(0, inicio));
}

/** En el mensaje del CLIENTE, el número es una cantidad pedida: «¿tienen 20?», «necesito 20». */
const PIDE_CANTIDAD =
  /(?<!\p{L})(?:tienen|tienes|tiene|hay|necesito|necesitamos|necesita|quiero|queremos|requiero|requerimos|pido|pedimos|llevo|llevamos|compro|compramos|cotizar|cotizame|cotízame)\s+(?:unos\s+|unas\s+|como\s+|de\s+)?$/iu;
/** En el mensaje del cliente, el número está en una frase de precio: no da permiso. */
const PRECIO_ANTES =
  /(?<!\p{L})(?:en|a|por|cu[aá]nto|precio|vale|valen|cuesta|cuestan|valor|dejas|deja|dejan|sale|salen|queda|quedan|pago|pagar|ofrezco)\s+(?:los\s+|las\s+|el\s+|unos\s+|solo\s+)?$|[$€]\s*$/iu;
const PRECIO_DESPUES = /^\s*(?:mil|k|millones?|mill[oó]n|pesos?|lucas?|lukas?|palos?|d[oó]lares?|euros?|cada|c\s*\/\s*u|la\s+unidad)(?!\p{L})/iu;

/**
 * Los números que el cliente pidió COMO CANTIDAD, y nunca dentro de una frase
 * de precio. Si el mismo número aparece una vez como precio («¿me lo dejas en
 * 120?»), no da permiso aunque en otro lado parezca cantidad.
 */
/**
 * El cliente habla de plata en algún mensaje, aunque sin repetir el número
 * («¿me los dejas a ese mismo número cada uno?», «de pesos digo jaja»). No se
 * sabe a cuál de sus números se refiere: ante la duda, ninguno da permiso.
 */
const CLIENTE_HABLA_DE_PRECIO =
  /(?<!\p{L})(?:pesos?|plata|lucas?|lukas?|palos?|d[oó]lares?|euros?|precios?|valor|cu[aá]nto|cuesta|cuestan|vale|valen|descuentos?|dejas|dejan|rebaja|cada\s+un[oa]\s+a|a\s+ese\s+(?:mismo\s+)?(?:n[uú]mero|valor|precio))(?!\p{L})|[$€%]/iu;

export function cantidadesDelCliente(delCliente: string): Set<string> {
  if (CLIENTE_HABLA_DE_PRECIO.test(delCliente)) return new Set();
  const cantidad = new Set<string>();
  const precio = new Set<string>();
  for (const m of delCliente.matchAll(DIGITOS)) {
    const n = m[0];
    const inicio = m.index ?? 0;
    const antes = delCliente.slice(0, inicio);
    const despues = delCliente.slice(inicio + n.length);
    const variantes = normalizarNumero(n);
    if (PRECIO_ANTES.test(antes) || PRECIO_DESPUES.test(despues)) {
      for (const v of variantes) precio.add(v);
    } else if (PIDE_CANTIDAD.test(antes) || CANTIDAD_DESPUES.test(despues)) {
      for (const v of variantes) cantidad.add(v);
    }
  }
  for (const v of precio) cantidad.delete(v);
  return cantidad;
}

/** Acuerdos de precio: frenan siempre, haya o no número permitido. */
const ACUERDO_PRECIO = /(?<!\p{L})(?:a|por|en)\s+ese\s+(?:valor|precio)(?!\p{L})/iu;

export function numeroNoPermitido(texto: string, permitidos: string, delCliente = ''): string | null {
  if (MONEDA.test(texto)) return 'moneda o símbolo de plata';
  if (PORCENTAJE.test(texto)) return 'porcentaje';
  if (DESCUENTO.test(texto)) return 'descuento';
  if (MAGNITUD.test(texto)) return 'cifra con magnitud';
  if (ACUERDO_PRECIO.test(texto)) return 'acuerdo de precio';

  const blanca = listaBlanca(permitidos);
  const cliente = { numeros: cantidadesDelCliente(delCliente) };
  for (const m of texto.matchAll(DIGITOS)) {
    const n = m[0];
    const variantes = normalizarNumero(n);
    if (variantes.some((v) => blanca.numeros.has(v))) continue;
    const inicio = m.index ?? 0;
    if (variantes.some((v) => cliente.numeros.has(v)) && comoCantidad(texto, inicio, inicio + n.length)) {
      continue;
    }
    return `el número ${n} no lo devolvió el catálogo`;
  }

  const tokens = (texto.replace(MODISMOS, ' ').toLowerCase().match(/\p{L}+|\d+(?:[.,]\d+)*/gu) ?? []);

  // Frase de precio + cualquier número (dígitos, palabras o romano): frena
  // SIEMPRE, aunque el número esté en la lista blanca («te lo dejo en 1020»).
  const frase = fraseDePrecio(tokens);
  if (frase) return `frase de precio: «${frase}»`;

  // Cantidades en palabras: se comparan por su VALOR con la lista blanca.
  for (let i = 0; i < tokens.length; ) {
    if (!PALABRAS_NUMERO.has(tokens[i])) {
      i++;
      continue;
    }
    // La corrida entera: «ciento cincuenta», «mil veinte», «treinta y dos».
    let j = i + 1;
    while (
      j < tokens.length &&
      (PALABRAS_NUMERO.has(tokens[j]) || (tokens[j] === 'y' && PALABRAS_NUMERO.has(tokens[j + 1] ?? '')))
    ) {
      j++;
    }
    const corrida = tokens.slice(i, j).filter((t) => t !== 'y');
    const antes = tokens[i - 1];
    const despues = tokens[j];
    const pegadaADigito =
      /^\d/.test(antes ?? '') ||
      /^\d/.test(despues ?? '') ||
      (UNIONES.has(antes ?? '') && /^\d/.test(tokens[i - 2] ?? '')) ||
      (UNIONES.has(despues ?? '') && /^\d/.test(tokens[j + 1] ?? ''));
    const detrasDePrecio =
      DE_PRECIO.has(antes ?? '') && !(corrida.length === 1 && ARTICULOS.has(corrida[0]));
    const esCantidad =
      corrida.length > 1 || corrida.some((t) => GRANDES.test(t)) || pegadaADigito || detrasDePrecio;
    if (esCantidad) {
      const valor = valorEnPalabras(corrida);
      if (pegadaADigito || valor === null || !blanca.numeros.has(String(valor))) {
        return `la cantidad «${corrida.join(' ')}» no la devolvió el catálogo`;
      }
    }
    i = j;
  }
  return null;
}

const VALORES: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, 'dieciséis': 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiuna: 21,
  veintidos: 22, 'veintidós': 22, veintitres: 23, 'veintitrés': 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, 'veintiséis': 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600,
  seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};

/** «ciento cincuenta mil» → 150000; «mil veinte» → 1020. null si no se puede leer. */
export function valorEnPalabras(palabras: string[]): number | null {
  let total = 0;
  let actual = 0;
  for (const p of palabras) {
    if (p === 'y') continue;
    if (p === 'mil') {
      total += (actual || 1) * 1000;
      actual = 0;
    } else if (p === 'millon' || p === 'millón' || p === 'millones') {
      total = (total + (actual || 1)) * 1_000_000;
      actual = 0;
    } else if (p in VALORES) {
      actual += VALORES[p];
    } else {
      return null;
    }
  }
  return total + actual;
}

const ROMANO = /^[ivxlcdm]+$/;
/** Lo que puede ir entre la frase y el número: «el precio ES DE 420», «cuesta UNOS 950». */
const RELLENO = new Set(['es', 'de', 'unos', 'unas', 'como', 'solo', 'apenas', 'mas', 'más', 'o', 'menos', 'aprox', 'aproximadamente', 'eso', 'lo', 'te', 'en', 'a', 'los', 'las', 'el', 'la', 'entonces', 'pues']);
const FRASES_PRECIO: string[][] = [
  ['te', 'lo', 'dejo', 'en'], ['te', 'lo', 'dejo', 'a'], ['te', 'lo', 'dejamos', 'en'], ['te', 'lo', 'dejamos', 'a'],
  ['te', 'queda', 'en'], ['te', 'queda', 'a'], ['te', 'sale', 'en'], ['te', 'sale', 'a'],
  ['queda', 'en'], ['sale', 'en'], ['quedan', 'en'], ['salen', 'en'],
  ['el', 'valor', 'es'], ['valor'], ['vale'], ['valen'], ['cuesta'], ['cuestan'], ['precio'],
  // Acuerdos (segunda validación): «quedamos en los 120», «te dejo los 120»,
  // «de una, 120», «listo, 120», «dejamos 120».
  ['quedamos', 'en'], ['quedamos'], ['dejo'], ['dejamos'], ['de', 'acuerdo'], ['de', 'una'], ['listo'],
  // Última ronda: «Perfecto, los 120 entonces», «Aceptamos los 120».
  ['perfecto'], ['aceptamos'], ['aceptado'], ['acepto'], ['trato'], ['hecho'],
];
const POR_UNIDAD: string[][] = [['la', 'unidad'], ['c', 'u'], ['cada', 'uno'], ['cada', 'una'], ['por', 'unidad']];

function esNumeroCualquiera(t: string | undefined): boolean {
  return !!t && (/^\d/.test(t) || PALABRAS_NUMERO.has(t) || ROMANO.test(t));
}

function coincide(tokens: string[], i: number, frase: string[]): boolean {
  return frase.every((w, k) => tokens[i + k] === w);
}

/** La frase de precio seguida de un número, o null. */
export function fraseDePrecio(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    for (const f of FRASES_PRECIO) {
      if (!coincide(tokens, i, f)) continue;
      // Hasta tres palabras de relleno entre la frase y el número.
      for (let k = i + f.length, saltos = 0; k < tokens.length && saltos <= 3; k++, saltos++) {
        if (esNumeroCualquiera(tokens[k])) {
          // «el precio de los dos que tienen»: una palabra menor de diez tras
          // «precio de los/las» cuenta referencias, no es un precio.
          const v = PALABRAS_NUMERO.has(tokens[k]) ? valorEnPalabras([tokens[k]]) : null;
          const cuentaReferencias =
            f.length === 1 && f[0] === 'precio' && tokens[k - 2] === 'de' &&
            (tokens[k - 1] === 'los' || tokens[k - 1] === 'las') && v !== null && v < 10;
          if (cuentaReferencias) break;
          return `${f.join(' ')} ${tokens[k]}`;
        }
        if (!RELLENO.has(tokens[k])) break;
      }
    }
    // «son N la unidad / c-u / cada uno»
    if (tokens[i] === 'son' && esNumeroCualquiera(tokens[i + 1])) {
      let k = i + 2;
      while (k < tokens.length && PALABRAS_NUMERO.has(tokens[k])) k++;
      if (POR_UNIDAD.some((u) => coincide(tokens, k, u))) return `son ${tokens[i + 1]} ${tokens.slice(k, k + 2).join(' ')}`;
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
  permitidos = '',
  /** Lo que escribió el cliente: sus números solo valen como cantidad. */
  delCliente = '',
  /**
   * Códigos de referencia que el catálogo confirmó en turnos anteriores de la
   * conversación. Valen como código entero («SR-3300»), no sus cifras sueltas.
   */
  codigosPrevios: string[] = []
): Revision {
  const limpio = texto.trim();
  if (!limpio) return { ok: false, motivo: 'respuesta vacía' };

  // Lo que escribió el modelo, sin las marcas de precio (esas las cambia el código).
  let suyo = limpio.replace(MARCA, ' ');
  for (const c of codigosPrevios) {
    const seguro = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    suyo = suyo.replace(new RegExp(`(?<![\\p{L}\\d])${seguro}(?![\\p{L}\\d])`, 'giu'), ' ');
  }
  const problema = numeroNoPermitido(suyo, permitidos, delCliente);
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
