import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { leerConfigWhatsApp } from '@/lib/whatsapp/config-servidor';
import {
  crearProveedor,
  nombreProveedorOnull,
  type EstadoConexion,
} from '@/lib/whatsapp/proveedor';

/**
 * GET /api/whatsapp/conexion  (cualquier miembro; los detalles, solo la dirección)
 *
 * El estado del número para la pantalla de Zernio y el aviso de la bandeja:
 * qué proveedor manda, si el canal está vivo (`verificarConexion`; con Zernio,
 * `GET /whatsapp/number-info`), el `accountId` y la fecha del último webhook.
 * Las llaves NO salen de aquí ni se editan desde la app: viven en el entorno.
 */

// Una lectura viva por minuto como mucho: la bandeja pregunta al abrir.
const CACHE_MS = 60_000;
let cache: { en: number; proveedor: string; estado: EstadoConexion } | null =
  null;

/** `ultimo_webhook_wa()` (0115) se llama con la sesión: la función exige dirección. */
async function ultimoWebhook(supabase: {
  rpc: (
    fn: string
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): Promise<{ fecha: string | null; nota: string | null }> {
  const { data, error } = await supabase.rpc('ultimo_webhook_wa');
  if (error)
    return {
      fecha: null,
      nota: 'No se pudo leer la fecha del último webhook.',
    };
  const r = (data ?? {}) as {
    ultimo_recibido_en?: string | null;
    sin_cerrar?: number;
  };
  const sinCerrar = Number(r.sin_cerrar ?? 0);
  return {
    fecha: r.ultimo_recibido_en ?? null,
    nota: !r.ultimo_recibido_en
      ? 'Todavía no ha llegado ningún webhook.'
      : sinCerrar > 0
        ? `${sinCerrar} evento(s) quedaron sin cerrar hace más de 2 minutos.`
        : null,
  };
}

export async function GET() {
  try {
    const { accountId, role, supabase } = await getCurrentAccount();
    const proveedor = nombreProveedorOnull();
    if (!proveedor) {
      return NextResponse.json({
        proveedor: null,
        conectado: false,
        detalle: 'Falta WHATSAPP_PROVEEDOR en el entorno del servidor.',
      });
    }

    let estado: EstadoConexion;
    if (
      cache &&
      cache.proveedor === proveedor &&
      Date.now() - cache.en < CACHE_MS
    ) {
      estado = cache.estado;
    } else {
      estado = await crearProveedor({ accountId }).verificarConexion();
      cache = { en: Date.now(), proveedor, estado };
    }

    const base = { proveedor, conectado: estado.conectado };
    if (!hasMinRole(role, 'admin')) return NextResponse.json(base);

    const webhook = await ultimoWebhook(supabase);
    const config = await leerConfigWhatsApp(accountId).catch(() => null);
    return NextResponse.json({
      ...base,
      esDireccion: true,
      detalle: estado.detalle,
      numero: estado.numero,
      nombre: estado.nombre,
      calidad: estado.calidad,
      // No es secreto: identifica el número conectado en Zernio.
      cuentaId:
        proveedor === 'zernio'
          ? config?.zernio_account_id ||
            process.env.ZERNIO_ACCOUNT_ID?.trim() ||
            null
          : null,
      conectadoDesde: config?.conectado_desde ?? null,
      ultimoWebhook: webhook.fecha,
      ultimoWebhookNota: webhook.nota,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
