// ============================================================
// Adjuntos que llegan: se bajan del proveedor (Zernio pide Bearer) y se guardan
// en el bucket PRIVADO `chat-media` con la clave de servicio. En el mensaje queda
// `/api/whatsapp/adjunto/<ruta>`, una ruta de la app que mira si quien pide ve
// ese mensaje y redirige a un enlace firmado que vence pronto. Nada de
// `getPublicUrl`: los buckets ya no son públicos (0110, B10).
//
// Si no se puede bajar, el mensaje se queda con «Adjunto recibido, sin
// descargar» y sin URL. No se reintenta el webhook por esto: Meta guarda el
// archivo un tiempo y reintentar re-correría todo lo demás.
// ============================================================

import { extensionForMime } from '@/lib/media/filename';
import { normalizeMimeType } from '../mirror-inbound-media';
import type { ProveedorWhatsApp } from '../proveedor/tipos';
import type { AlmacenWhatsApp } from './almacen';
import { ADJUNTO_SIN_DESCARGAR, type TrabajoAdjunto } from './procesar';

export const PREFIJO_ADJUNTO = '/api/whatsapp/adjunto/';

/** La ruta del objeto en el bucket: por cuenta, «inbound», y el wamid. */
export function rutaAdjunto(
  accountId: string,
  wamid: string,
  indice: number,
  mime: string | null
): string {
  const limpio = wamid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  const ext = extensionForMime(mime ?? '') || 'bin';
  return `account-${accountId}/inbound/${limpio}-${indice}.${ext}`;
}

/** `messages.media_url` para un adjunto guardado. */
export function urlInternaAdjunto(ruta: string): string {
  return PREFIJO_ADJUNTO + ruta.split('/').map(encodeURIComponent).join('/');
}

/** Lo inverso: de la URL interna a la ruta del bucket, o null si no es una de las nuestras. */
export function rutaDesdeUrlInterna(url: string): string | null {
  if (!url.startsWith(PREFIJO_ADJUNTO)) return null;
  const partes = url
    .slice(PREFIJO_ADJUNTO.length)
    .split('/')
    .map(decodeURIComponent);
  if (partes.some((p) => p === '' || p === '.' || p === '..')) return null;
  return partes.join('/');
}

export async function guardarAdjuntoEntrante(
  proveedor: ProveedorWhatsApp,
  almacen: AlmacenWhatsApp,
  trabajo: TrabajoAdjunto
): Promise<'guardado' | 'sin_descargar'> {
  let archivo = null;
  try {
    archivo = await proveedor.descargarAdjunto(trabajo.adjunto);
  } catch (err) {
    console.error(
      '[webhook] falló la descarga del adjunto:',
      err instanceof Error ? err.message : err
    );
  }
  const mime = normalizeMimeType(archivo?.mime ?? trabajo.adjunto.mime);
  if (!archivo || !mime) {
    console.warn(
      `[webhook] adjunto de ${trabajo.wamid} recibido, sin descargar`
    );
    return 'sin_descargar';
  }
  const ruta = rutaAdjunto(
    trabajo.accountId,
    trabajo.wamid,
    trabajo.adjunto.indice,
    mime
  );
  const ok = await almacen.guardarAdjunto(ruta, archivo.bytes, mime);
  if (!ok) return 'sin_descargar';
  // Si el mensaje no traía texto, se quita el aviso de «sin descargar».
  await almacen.actualizarAdjunto(
    trabajo.mensajeId,
    urlInternaAdjunto(ruta),
    trabajo.textoOriginal ?? null
  );
  return 'guardado';
}

export { ADJUNTO_SIN_DESCARGAR };
