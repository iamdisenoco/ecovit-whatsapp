import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { barrerWhatsApp, revisarSecretoCron } from '@/lib/whatsapp/cron-limpieza';

/**
 * GET /api/whatsapp/cron — el barrido de WhatsApp (envíos inciertos y limpieza).
 *
 * Lo llama Vercel Cron (`vercel.json`), que manda `Authorization: Bearer
 * <CRON_SECRET>`. Sin `CRON_SECRET` en el entorno responde 503; con uno que no
 * coincide, 401. No necesita sesión (middleware: API_PROPIAS).
 */
export async function GET(request: Request) {
  const rechazo = revisarSecretoCron(
    request.headers.get('authorization'),
    process.env.CRON_SECRET
  );
  if (rechazo) {
    return NextResponse.json({ error: rechazo.error }, { status: rechazo.status });
  }
  const { resultado, errores } = await barrerWhatsApp(supabaseAdmin());
  if (errores.length > 0) console.error('[whatsapp/cron]', errores.join(' · '));
  return NextResponse.json(
    { ...resultado, errores },
    { status: errores.length === 3 ? 500 : 200 }
  );
}
