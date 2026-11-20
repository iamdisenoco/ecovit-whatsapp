import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  crearProveedor,
  nombreProveedorOnull,
  type EstadoConexion,
} from '@/lib/whatsapp/proveedor';
import {
  TABLA_EVENTOS,
  faltaEnLaBase,
} from '@/lib/whatsapp/webhook/almacen-supabase';

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

async function ultimoWebhook(): Promise<{
  fecha: string | null;
  nota: string | null;
}> {
  const { data, error } = await supabaseAdmin()
    .from(TABLA_EVENTOS)
    .select('recibido_en')
    .order('recibido_en', { ascending: false })
    .limit(1);
  if (faltaEnLaBase(error)) {
    return {
      fecha: null,
      nota: 'La base todavía no guarda los eventos del webhook (falta SQL del bloque 5).',
    };
  }
  if (error)
    return {
      fecha: null,
      nota: 'No se pudo leer la fecha del último webhook.',
    };
  const fila = data?.[0] as { recibido_en?: string } | undefined;
  return {
    fecha: fila?.recibido_en ?? null,
    nota: fila ? null : 'Todavía no ha llegado ningún webhook.',
  };
}

export async function GET() {
  try {
    const { accountId, role } = await getCurrentAccount();
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

    const webhook = await ultimoWebhook();
    return NextResponse.json({
      ...base,
      detalle: estado.detalle,
      numero: estado.numero,
      nombre: estado.nombre,
      calidad: estado.calidad,
      // No es secreto: identifica el número conectado en Zernio.
      cuentaId:
        proveedor === 'zernio'
          ? process.env.ZERNIO_ACCOUNT_ID?.trim() || null
          : null,
      ultimoWebhook: webhook.fecha,
      ultimoWebhookNota: webhook.nota,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
