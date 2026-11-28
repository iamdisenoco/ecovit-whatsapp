// ============================================================
// Los textos que reemplazan lo crudo del proveedor en un mensaje. Sin imports:
// lo usan el servidor (webhook, historial) y el navegador (la bandeja).
//
// - «[Unsupported message]» (o «[Unsupported message type: …]», el de Meta
//   directo) es un archivo o un tipo que WhatsApp no deja leer: se muestra
//   `ARCHIVO_NO_MOSTRADO`.
// - Una tarjeta de contacto compartida se guarda como «Contacto compartido:
//   <nombre>» y, en la línea siguiente, el teléfono. La vista previa muestra
//   solo la primera línea: el teléfono completo no sale en la lista.
// ============================================================

export const ARCHIVO_NO_MOSTRADO = 'Archivo que no se pudo mostrar';
export const PREFIJO_CONTACTO = 'Contacto compartido';
export const PREFIJO_CONTACTOS = 'Contactos compartidos';

/** El texto literal que guarda el proveedor para lo que no sabe leer. */
export const TEXTO_NO_SOPORTADO = '[Unsupported message]';

const NO_SOPORTADO = /^\[Unsupported message(?: type\b[^\]]*)?\]$/i;

export function esNoSoportado(texto: string | null | undefined): boolean {
  return NO_SOPORTADO.test((texto ?? '').trim());
}

/** El texto de un mensaje para mostrarlo: traduce lo crudo que ya esté guardado. */
export function textoParaMostrar(texto: string | null | undefined): string {
  if (esNoSoportado(texto)) return ARCHIVO_NO_MOSTRADO;
  return texto ?? '';
}

/** Lo que va en la lista de chats: lo mismo, y de una tarjeta solo el nombre. */
export function textoVistaPrevia(texto: string | null | undefined): string {
  const t = textoParaMostrar(texto);
  if (t.startsWith(PREFIJO_CONTACTO) || t.startsWith(PREFIJO_CONTACTOS))
    return t.split('\n')[0];
  return t;
}

/** Una tarjeta de contacto, ya leída: el nombre (si hay) y los teléfonos. */
export interface TarjetaContacto {
  nombre: string | null;
  telefonos: string[];
}

/** «Contacto compartido: Ana» + los teléfonos en las líneas siguientes. */
export function textoContactoCompartido(tarjetas: TarjetaContacto[]): string {
  const nombres = tarjetas
    .map((t) => t.nombre)
    .filter((n): n is string => !!n);
  const titulo =
    tarjetas.length > 1
      ? nombres.length
        ? `${PREFIJO_CONTACTOS}: ${nombres.join(', ')}`
        : PREFIJO_CONTACTOS
      : nombres.length
        ? `${PREFIJO_CONTACTO}: ${nombres[0]}`
        : PREFIJO_CONTACTO;
  const telefonos = tarjetas.flatMap((t) => t.telefonos);
  return [titulo, ...telefonos].join('\n');
}
