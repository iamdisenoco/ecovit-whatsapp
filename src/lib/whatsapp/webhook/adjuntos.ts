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
import type { ArchivoBajado, ProveedorWhatsApp } from '../proveedor/tipos';
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

/**
 * Los tipos que admite el bucket `chat-media` (`allowed_mime_types`, migración
 * 0110 de ecovit-comercial). Storage rechaza cualquier otro: un archivo así no
 * se baja ni se reintenta. Si la migración cambia la lista, cambia aquí.
 */
export const TIPOS_BUCKET_ADJUNTOS: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'video/3gp',
  'video/quicktime',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/mp4',
  'audio/amr',
  'audio/opus',
]);

/** ¿El bucket acepta este tipo? `null` (no se sabe) no se descarta aquí. */
export function tipoAdmitido(mime: string | null | undefined): boolean {
  const base = normalizeMimeType(mime);
  return base !== null && TIPOS_BUCKET_ADJUNTOS.has(base);
}

export type ResultadoGuardar =
  | { estado: 'guardado'; url: string }
  /** Sin tipo o con uno que el bucket no acepta: no cambia al reintentar. */
  | { estado: 'tipo_no_admitido' }
  /** Storage falló: puede servir otro día. */
  | { estado: 'fallo' };

/**
 * Guarda en el bucket un archivo ya bajado, en la ruta de siempre. Devuelve la
 * `media_url` interna, o `null` si no tiene un tipo usable o Storage falló. La
 * usan el webhook y el importador del historial: la misma ruta para los dos.
 */
export async function guardarArchivoAdjunto(
  almacen: AlmacenWhatsApp,
  destino: { accountId: string; wamid: string; indice: number },
  archivo: ArchivoBajado,
  mimeDeclarado: string | null
): Promise<ResultadoGuardar> {
  const mime = normalizeMimeType(archivo.mime ?? mimeDeclarado);
  if (!mime || !TIPOS_BUCKET_ADJUNTOS.has(mime))
    return { estado: 'tipo_no_admitido' };
  const ruta = rutaAdjunto(
    destino.accountId,
    destino.wamid,
    destino.indice,
    mime
  );
  const ok = await almacen.guardarAdjunto(ruta, archivo.bytes, mime);
  return ok
    ? { estado: 'guardado', url: urlInternaAdjunto(ruta) }
    : { estado: 'fallo' };
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
  const guardado = archivo
    ? await guardarArchivoAdjunto(
        almacen,
        {
          accountId: trabajo.accountId,
          wamid: trabajo.wamid,
          indice: trabajo.adjunto.indice,
        },
        archivo,
        trabajo.adjunto.mime
      )
    : null;
  if (guardado?.estado !== 'guardado') {
    console.warn(
      `[webhook] adjunto de ${trabajo.wamid} recibido, sin descargar`
    );
    return 'sin_descargar';
  }
  // Si el mensaje no traía texto, se quita el aviso de «sin descargar».
  await almacen.actualizarAdjunto(
    trabajo.mensajeId,
    guardado.url,
    trabajo.textoOriginal ?? null
  );
  return 'guardado';
}

export { ADJUNTO_SIN_DESCARGAR };
