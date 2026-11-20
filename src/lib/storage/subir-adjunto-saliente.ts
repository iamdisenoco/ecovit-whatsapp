// El navegador ya no sube a `chat-media` (bucket privado, sin políticas de
// escritura): le pasa el archivo a /api/whatsapp/subir-adjunto, que lo sube con
// la clave de servicio después de comprobar el rol.

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
