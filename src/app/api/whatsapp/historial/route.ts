import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  ErrorHistorial,
  FuenteHistorialZernio,
  SinFechaDeConexion,
  importarHistorial,
} from '@/lib/whatsapp/proveedor/historial';
import { nombreProveedorOnull } from '@/lib/whatsapp/proveedor/nombre';
import { configZernioDesdeEntorno } from '@/lib/whatsapp/proveedor/zernio';
import { AlmacenSupabase } from '@/lib/whatsapp/webhook/almacen-supabase';

/**
 * POST /api/whatsapp/historial  (solo la dirección)
 *
 * Trae un tramo de la historia de la coexistencia (`proveedor/historial.ts`).
 * Recibe `{ cursor? }` y devuelve `{ procesadas, mensajes, listas, cursor,
 * terminado, esperarMs }`; el botón de Configuración la llama en bucle hasta
 * `terminado`. Es idempotente: se puede volver a correr cuando se quiera.
 *
 * Los textos de error llegan a la pantalla: no nombran al proveedor.
 */
export const maxDuration = 60;

const NO_CONFIGURADA = 'La conexión de WhatsApp no está configurada.';

export async function POST(request: Request) {
  try {
    await requireRole('admin');

    const config = configZernioDesdeEntorno();
    if (
      nombreProveedorOnull() !== 'zernio' ||
      !config.apiKey ||
      !config.cuentaId
    ) {
      console.warn(
        '[historial] falta WHATSAPP_PROVEEDOR=zernio, ZERNIO_API_KEY o ZERNIO_ACCOUNT_ID'
      );
      return NextResponse.json({ error: NO_CONFIGURADA }, { status: 503 });
    }

    const cuerpo = (await request.json().catch(() => ({}))) as {
      cursor?: unknown;
    };
    const cursor = typeof cuerpo?.cursor === 'string' ? cuerpo.cursor : null;

    const r = await importarHistorial({
      almacen: new AlmacenSupabase(supabaseAdmin()),
      fuente: new FuenteHistorialZernio({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      }),
      cuentaId: config.cuentaId,
      cursor,
    });
    return NextResponse.json(r);
  } catch (err) {
    if (err instanceof SinFechaDeConexion) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ErrorHistorial) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
