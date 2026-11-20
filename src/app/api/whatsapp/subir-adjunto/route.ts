import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { extensionForMime } from '@/lib/media/filename';
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';
import { normalizeMimeType } from '@/lib/whatsapp/mirror-inbound-media';
import { BUCKET_ADJUNTOS } from '@/lib/whatsapp/webhook/almacen-supabase';
import { urlInternaAdjunto } from '@/lib/whatsapp/webhook/adjuntos';

/**
 * POST /api/whatsapp/subir-adjunto  (vendedor o dirección; multipart, campo `archivo`)
 *
 * ECOVIT · bloque 5. El adjunto que se manda desde la bandeja ya no lo sube el
 * navegador con `getPublicUrl` (el bucket `chat-media` es privado y no tiene
 * políticas de escritura): lo sube el servicio, después de comprobar el rol,
 * en `account-<cuenta>/outbound/<uuid>.<ext>`. Devuelve la URL interna que se
 * guarda en el mensaje y un enlace firmado corto para la vista previa. Al
 * enviar, `send-message` le da al proveedor otro enlace firmado de 10 minutos.
 */

const VISTA_PREVIA_S = 10 * 60;

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent');
    const datos = await request.formData().catch(() => null);
    const archivo = datos?.get('archivo');
    if (!archivo || typeof archivo === 'string') {
      return NextResponse.json({ error: 'Falta el archivo' }, { status: 400 });
    }
    if (archivo.size === 0 || archivo.size > MEDIA_MAX_BYTES) {
      return NextResponse.json(
        { error: 'El archivo está vacío o pasa de 16 MB' },
        { status: 400 }
      );
    }
    const mime = normalizeMimeType(archivo.type);
    if (!mime)
      return NextResponse.json(
        { error: 'Tipo de archivo desconocido' },
        { status: 400 }
      );

    // Nombre al azar: nadie lo adivina para fabricar un mensaje que lo apunte.
    const ruta = `account-${accountId}/outbound/${randomUUID()}.${extensionForMime(mime)}`;
    const admin = supabaseAdmin();
    const { error } = await admin.storage
      .from(BUCKET_ADJUNTOS)
      .upload(ruta, new Uint8Array(await archivo.arrayBuffer()), {
        contentType: mime,
        cacheControl: '3600',
        upsert: false,
      });
    // El bucket rechaza lo que no está en su lista de tipos: se dice tal cual.
    if (error)
      return NextResponse.json(
        { error: `No se pudo subir: ${error.message}` },
        { status: 400 }
      );

    const { data: firmado } = await admin.storage
      .from(BUCKET_ADJUNTOS)
      .createSignedUrl(ruta, VISTA_PREVIA_S);
    return NextResponse.json({
      media_url: urlInternaAdjunto(ruta),
      path: ruta,
      vista_previa: firmado?.signedUrl ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
