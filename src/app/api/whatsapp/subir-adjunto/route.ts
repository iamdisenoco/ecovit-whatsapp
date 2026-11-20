import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { extensionForMime } from '@/lib/media/filename';
import {
  MENSAJE_TOPE_SUBIDA,
  RUTA_BORRADOR,
  TOPE_SUBIDA_BYTES,
} from '@/lib/storage/subir-adjunto-saliente';
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
    if (archivo.size === 0) {
      return NextResponse.json({ error: 'El archivo está vacío' }, { status: 400 });
    }
    if (archivo.size > TOPE_SUBIDA_BYTES) {
      return NextResponse.json({ error: MENSAJE_TOPE_SUBIDA }, { status: 413 });
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

/**
 * DELETE /api/whatsapp/subir-adjunto  (vendedor o dirección; JSON `{ path }`)
 *
 * Borra un borrador de adjunto que no se mandó. Antes lo borraba el navegador
 * con su sesión, y el bucket privado no tiene políticas de escritura (no
 * borraba nada). Solo rutas de borrador de ESTA cuenta, y solo si ningún
 * mensaje lo usa: si no, un vendedor podría borrar el adjunto de un mensaje
 * ya enviado (o que quedó en `failed`, que lo sigue mostrando).
 */
export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
    const ruta = typeof body?.path === 'string' ? body.path : '';
    if (!RUTA_BORRADOR.test(ruta) || !ruta.startsWith(`account-${accountId}/outbound/`)) {
      return NextResponse.json({ error: 'Ese archivo no se puede borrar desde aquí.' }, { status: 400 });
    }
    const admin = supabaseAdmin();
    const { data: usado, error: usadoErr } = await admin
      .from('messages')
      .select('id')
      .eq('media_url', urlInternaAdjunto(ruta))
      .limit(1);
    if (usadoErr) {
      return NextResponse.json({ error: 'No se pudo revisar el archivo.' }, { status: 500 });
    }
    if (usado && usado.length > 0) {
      return NextResponse.json({ error: 'Ese archivo ya está en un mensaje.' }, { status: 409 });
    }
    const { error } = await admin.storage.from(BUCKET_ADJUNTOS).remove([ruta]);
    if (error) {
      return NextResponse.json({ error: `No se pudo borrar: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ borrado: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
