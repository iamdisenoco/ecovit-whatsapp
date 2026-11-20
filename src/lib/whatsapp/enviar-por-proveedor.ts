// ============================================================
// El envío de la bandeja por la interfaz del proveedor (Zernio o el simulado).
// Meta sigue por el camino que traía wacrm en `send-message.ts`.
//
// La regla de Zernio para un envío dudoso (5xx, tiempo agotado, red caída):
// «a blind retry could send it twice». Así que NO se reintenta: el mensaje se
// guarda en `sending` sin wamid y lo resuelve el `message.sent` (que lo concilia
// el webhook) o un `message.failed`. La clave de idempotencia es el id de
// NUESTRO mensaje, el mismo con que se guarda la fila.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { crearProveedor } from './proveedor';
import {
  ErrorConfiguracion,
  ErrorProveedor,
  type DestinoEnvio,
  type ReferenciaConversacion,
  type ResultadoEnvio,
} from './proveedor/tipos';
import {
  BUCKET_ADJUNTOS,
  COLUMNA_CUENTA_REFERENCIA,
  COLUMNA_REFERENCIA,
} from './webhook/almacen-supabase';
import { rutaDesdeUrlInterna } from './webhook/adjuntos';

/** La conversación (y la cuenta) del proveedor que guardó el webhook (0115). */
export async function leerReferenciaConversacion(
  db: SupabaseClient,
  conversationId: string
): Promise<ReferenciaConversacion> {
  const { data, error } = await db
    .from('conversations')
    .select(`${COLUMNA_REFERENCIA}, ${COLUMNA_CUENTA_REFERENCIA}`)
    .eq('id', conversationId)
    .maybeSingle();
  if (error)
    throw new Error(
      `No se pudo leer la conversación del proveedor: ${error.message}`
    );
  const fila = data as Record<string, string | null> | null;
  return {
    conversacionId: fila?.[COLUMNA_REFERENCIA] ?? null,
    cuentaId: fila?.[COLUMNA_CUENTA_REFERENCIA] ?? null,
  };
}

export async function guardarReferenciaConversacion(
  db: SupabaseClient,
  conversationId: string,
  ref: ReferenciaConversacion | null
): Promise<void> {
  if (!ref?.conversacionId) return;
  const { error } = await db
    .from('conversations')
    .update({
      [COLUMNA_REFERENCIA]: ref.conversacionId,
      [COLUMNA_CUENTA_REFERENCIA]: ref.cuentaId,
    })
    .eq('id', conversationId);
  if (error) {
    console.warn(
      '[enviar] no se pudo guardar la conversación del proveedor:',
      error.message
    );
  }
}

/** Cuánto vive el enlace firmado que se le da al proveedor para bajar el adjunto. */
export const VENCE_ADJUNTO_SALIENTE_S = 10 * 60;

/**
 * Un adjunto nuestro (`/api/whatsapp/adjunto/<ruta>` en el bucket privado
 * chat-media) se le pasa al proveedor como enlace firmado de vencimiento corto:
 * Zernio y Meta lo bajan por URL al enviar. Otra URL pasa tal cual.
 */
export async function urlParaProveedor(
  url: string,
  accountId: string
): Promise<string> {
  const ruta = rutaDesdeUrlInterna(url);
  if (!ruta) return url;
  // Solo lo que se subió para MANDAR desde esta cuenta. Firmar cualquier ruta
  // dejaría a un vendedor reenviar adjuntos de chats que no ve.
  if (!ruta.startsWith(`account-${accountId}/outbound/`)) {
    throw new Error('Ese adjunto no se puede enviar desde aquí.');
  }
  const { data, error } = await supabaseAdmin()
    .storage.from(BUCKET_ADJUNTOS)
    .createSignedUrl(ruta, VENCE_ADJUNTO_SALIENTE_S);
  if (error || !data?.signedUrl) {
    throw new Error(
      `No se pudo firmar el adjunto: ${error?.message ?? 'sin enlace'}`
    );
  }
  return data.signedUrl;
}

export type PedidoEnvio =
  | { clase: 'texto'; texto: string }
  | {
      clase: 'media';
      tipo: 'image' | 'video' | 'audio' | 'document';
      url: string;
      texto: string | null;
      nombreArchivo: string | null;
    }
  | {
      clase: 'plantilla';
      nombre: string;
      idioma: string;
      parametros: string[];
      componentes?: unknown[];
    };

export type ResultadoEnvioBandeja =
  | {
      estado: 'enviado';
      mensajeId: string;
      referencia: ReferenciaConversacion | null;
    }
  | { estado: 'pendiente'; motivo: string }
  | { estado: 'fallido'; motivo: string; codigo: string; status: number };

/**
 * Envía y clasifica el resultado. No lanza por errores del proveedor: devuelve
 * `fallido` (definitivo, no se guarda nada) o `pendiente` (no se sabe si salió).
 */
export async function enviarPorProveedor(args: {
  conversationId: string;
  telefono: string | null;
  idMensaje: string;
  responderA: string | null;
  pedido: PedidoEnvio;
}): Promise<ResultadoEnvioBandeja> {
  const admin = supabaseAdmin();
  let resultado: ResultadoEnvio;
  try {
    const proveedor = crearProveedor();
    const destino: DestinoEnvio = {
      referencia: await leerReferenciaConversacion(admin, args.conversationId),
      telefono: args.telefono,
    };
    const opciones = {
      idempotencia: args.idMensaje,
      responderA: args.responderA,
    };
    const p = args.pedido;
    resultado =
      p.clase === 'texto'
        ? await proveedor.enviarTexto(destino, p.texto, opciones)
        : p.clase === 'media'
          ? await proveedor.enviarMedia(
              destino,
              {
                tipo: p.tipo,
                url: p.url,
                texto: p.texto,
                nombreArchivo: p.nombreArchivo,
              },
              opciones
            )
          : await proveedor.enviarPlantilla(
              destino,
              {
                nombre: p.nombre,
                idioma: p.idioma,
                parametros: p.parametros,
                componentes: p.componentes,
              },
              opciones
            );
  } catch (err) {
    if (err instanceof ErrorProveedor && err.dudoso) {
      console.warn(
        '[enviar] envío dudoso, queda pendiente (no se reintenta):',
        err.message
      );
      return { estado: 'pendiente', motivo: err.message };
    }
    if (err instanceof ErrorConfiguracion) {
      return {
        estado: 'fallido',
        motivo: err.message,
        codigo: 'whatsapp_not_configured',
        status: 500,
      };
    }
    const motivo = err instanceof Error ? err.message : String(err);
    const codigo =
      err instanceof ErrorProveedor && err.codigo
        ? err.codigo
        : 'proveedor_error';
    const status = codigo === 'sin_conversacion_proveedor' ? 409 : 502;
    return { estado: 'fallido', motivo, codigo, status };
  }

  await guardarReferenciaConversacion(
    admin,
    args.conversationId,
    resultado.referencia
  );
  return {
    estado: 'enviado',
    mensajeId: resultado.mensajeId,
    referencia: resultado.referencia,
  };
}
