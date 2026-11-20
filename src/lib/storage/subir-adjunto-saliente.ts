// El navegador ya no sube a `chat-media` (bucket privado, sin políticas de
// escritura): le pasa el archivo a /api/whatsapp/subir-adjunto, que lo sube con
// la clave de servicio después de comprobar el rol.

/**
 * Lo más grande que se sube desde la bandeja: el cuerpo de una función de
 * Vercel no pasa de 4,5 MB, y el archivo viaja por ella. Se deja margen para
 * el resto del formulario. Más grande, se manda desde el celular.
 */
export const TOPE_SUBIDA_BYTES = 4 * 1024 * 1024;

export const MENSAJE_TOPE_SUBIDA =
  'El archivo pasa de 4 MB, lo máximo que se puede subir desde aquí. Redúcelo o mándalo desde el celular.';

/** La ruta que el servidor le dio a un borrador de esta cuenta (y nada más). */
export const RUTA_BORRADOR = /^account-[0-9a-f-]{36}\/outbound\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export interface AdjuntoSubido {
  /** La URL interna que se guarda en el mensaje (`/api/whatsapp/adjunto/...`). */
  mediaUrl: string;
  path: string;
  /** Enlace firmado corto, solo para la vista previa del borrador. */
  vistaPrevia: string | null;
}

export async function subirAdjuntoSaliente(
  archivo: File
): Promise<AdjuntoSubido> {
  const datos = new FormData();
  datos.append('archivo', archivo);
  const res = await fetch('/api/whatsapp/subir-adjunto', {
    method: 'POST',
    body: datos,
  });
  const json = (await res.json().catch(() => null)) as {
    media_url?: string;
    path?: string;
    vista_previa?: string | null;
    error?: string;
  } | null;
  if (!res.ok || !json?.media_url || !json.path) {
    throw new Error(
      json?.error ?? `No se pudo subir el archivo (${res.status})`
    );
  }
  return {
    mediaUrl: json.media_url,
    path: json.path,
    vistaPrevia: json.vista_previa ?? null,
  };
}

/**
 * Borra un borrador que no se mandó. Lo hace el servidor (el navegador no
 * escribe en `chat-media`); si un mensaje ya lo usa, no se borra. Sin ruido:
 * es limpieza, no tiene que molestar a nadie si falla.
 */
export async function borrarAdjuntoSaliente(path: string | undefined): Promise<void> {
  if (!path) return;
  await fetch('/api/whatsapp/subir-adjunto', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(() => {});
}
