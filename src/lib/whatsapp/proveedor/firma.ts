import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Secretos de firma desde una variable de entorno. Admite varios separados por
 * coma, para rotar sin cortar: se pone el nuevo junto al viejo, se cambia en el
 * proveedor y después se quita el viejo. Vacíos y espacios no cuentan.
 */
export function leerSecretos(valor: string | null | undefined): string[] {
  if (!valor) return [];
  return valor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Compara la firma recibida con el HMAC-SHA256 en hexadecimal del cuerpo crudo,
 * para cada secreto, con `timingSafeEqual`.
 *
 * - Sin secretos configurados: `false` (se rechaza todo; el kit lo aceptaba).
 * - Firma vacía, de otro largo o con caracteres que no son hex: `false`, sin
 *   lanzar (un error aquí sería un 500 y el proveedor reintentaría siete veces).
 * - `prefijo` sirve para Meta (`sha256=<hex>`).
 */
export function verificarFirmaHmac(
  cuerpoCrudo: string,
  firmaRecibida: string | null | undefined,
  secretos: readonly string[],
  prefijo = ''
): boolean {
  if (secretos.length === 0) return false;
  if (!firmaRecibida) return false;

  let firma = firmaRecibida.trim();
  if (prefijo) {
    if (!firma.startsWith(prefijo)) return false;
    firma = firma.slice(prefijo.length);
  }
  firma = firma.toLowerCase();
  if (!HEX_64.test(firma)) return false;

  const recibida = Buffer.from(firma, 'hex');
  let valida = false;
  // Se prueban TODOS los secretos aunque uno ya coincida: así el tiempo no dice
  // cuál de ellos es el vigente.
  for (const secreto of secretos) {
    const esperada = createHmac('sha256', secreto)
      .update(cuerpoCrudo, 'utf8')
      .digest();
    if (
      esperada.length === recibida.length &&
      timingSafeEqual(esperada, recibida)
    ) {
      valida = true;
    }
  }
  return valida;
}

/** Firma un cuerpo como lo hace Zernio. Lo usan el simulador y las pruebas. */
export function firmarCuerpo(cuerpoCrudo: string, secreto: string): string {
  return createHmac('sha256', secreto)
    .update(cuerpoCrudo, 'utf8')
    .digest('hex');
}
