/**
 * Modo muestra: la app entera corre con datos ficticios en memoria del
 * navegador, sin Supabase, sin Zernio y sin ninguna red. Sirve para enseñar
 * la bandeja en una reunión o en un enlace de demostración.
 *
 * Se prende SOLO con `NEXT_PUBLIC_MODO_MUESTRA=1`, que no es secreta. Next la
 * escribe en el código al compilar, así que hay que ponerla ANTES del build.
 * Sin ella, `/muestra` da 404 y la app es la de siempre.
 *
 * Es una función (no una constante) para que las pruebas puedan cambiarla.
 */
export function modoMuestra(): boolean {
  return process.env.NEXT_PUBLIC_MODO_MUESTRA === '1'
}

/** La ruta de entrada de la demostración. */
export const RUTA_MUESTRA = '/muestra'

/** Adónde lleva la entrada: la bandeja. */
export const DESTINO_MUESTRA = '/inbox'
