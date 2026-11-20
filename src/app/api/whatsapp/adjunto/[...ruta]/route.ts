import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { BUCKET_ADJUNTOS } from '@/lib/whatsapp/webhook/almacen-supabase';
import {
  rutaDesdeUrlInterna,
  urlInternaAdjunto,
} from '@/lib/whatsapp/webhook/adjuntos';

/**
 * GET /api/whatsapp/adjunto/<ruta en chat-media>
 *
 * Los adjuntos que llegan por WhatsApp viven en el bucket PRIVADO `chat-media`
 * (0110, B10). Esta ruta mira con la sesión —es decir, con la RLS de
 * `messages`— que quien pide vea un mensaje con ese adjunto, y redirige a un
 * enlace firmado que vence en dos minutos. Nada de `getPublicUrl`.
 */

const VENCE_EN_SEGUNDOS = 120;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ruta: string[] }> }
) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { ruta: partes } = await params;
    const url = urlInternaAdjunto(
      (partes ?? []).map((p) => decodeURIComponent(p)).join('/')
    );
    const ruta = rutaDesdeUrlInterna(url);
    if (!ruta || !ruta.startsWith(`account-${accountId}/`)) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
    }

    const { data: visible, error } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', url)
      .limit(1);
    if (error) {
      console.error(
        '[adjunto] no se pudo comprobar el mensaje:',
        error.message
      );
      return NextResponse.json(
        { error: 'No se pudo comprobar el acceso' },
        { status: 500 }
      );
    }
    if (!visible || visible.length === 0) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
    }

    const { data: firmado, error: errFirma } = await supabaseAdmin()
      .storage.from(BUCKET_ADJUNTOS)
      .createSignedUrl(ruta, VENCE_EN_SEGUNDOS);
    if (errFirma || !firmado?.signedUrl) {
      return NextResponse.json(
        { error: 'El adjunto no está disponible' },
        { status: 404 }
      );
    }
    const respuesta = NextResponse.redirect(firmado.signedUrl, 302);
    respuesta.headers.set('Cache-Control', 'private, no-store');
    return respuesta;
  } catch (err) {
    return toErrorResponse(err);
  }
}
