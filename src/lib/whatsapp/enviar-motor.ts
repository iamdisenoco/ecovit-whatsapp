// ============================================================
// ECOVIT · bloque 5/6: lo que mandan los motores (flujos, automatizaciones y el
// bot) por la interfaz del proveedor (RF-M03.8), cuando el proveedor no es
// Meta. Meta sigue por el camino de wacrm (`flows/meta-send.ts`,
// `automations/meta-send.ts`).
//
// Igual que la bandeja (`send-message.ts`):
//  · lo que el proveedor no manda (botones y listas fuera de Meta) se rechaza
//    ANTES de guardar nada;
//  · la fila se guarda en `sending` ANTES de llamar al proveedor, con id = la
//    clave de idempotencia (si el `message.sent` del webhook llega antes que la
//    respuesta, adopta ESTA fila);
//  · un envío dudoso (5xx, tiempo agotado) NO se reintenta: queda en `sending`
//    y lo resuelve el webhook, o el cron lo pasa a `incierto`;
//  · un rechazo definitivo deja la fila en `failed` con el motivo real.
// Todo con la clave de servicio: los motores no tienen sesión.
// ============================================================

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { assertConversationInAccount } from './conversation-scope';
import { applyPendingMessageStatuses } from './message-status-sync';
import { resolveContactSendTarget } from './wa-identity';
import { enviarPorProveedor, type PedidoEnvio } from './enviar-por-proveedor';
import { crearProveedor } from './proveedor';
import { ErrorProveedor } from './proveedor/tipos';

export class EnvioNoSoportado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'EnvioNoSoportado';
  }
}

export interface FilaMotor {
  content_type: string;
  content_text: string | null;
  template_name?: string | null;
  media_url?: string | null;
  interactive_payload?: unknown;
  ai_generated?: boolean;
}

export interface ResultadoMotor {
  /** Id de NUESTRA fila en `messages`. */
  id: string;
  /** wamid, o '' cuando el envío quedó pendiente (dudoso). */
  whatsapp_message_id: string;
  pendiente: boolean;
}

/** Rechaza lo que el proveedor (no Meta) no manda, antes de tocar la base. */
export function rechazarInteractivo(): never {
  throw new EnvioNoSoportado(
    'Los botones y las listas todavía no se envían por este proveedor.'
  );
}

export async function enviarDesdeMotor(args: {
  accountId: string;
  conversationId: string;
  contactId: string;
  pedido: PedidoEnvio;
  fila: FilaMotor;
  /** Lo que muestra la lista de chats. */
  previa: string;
}): Promise<ResultadoMotor> {
  const db = supabaseAdmin();

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (contactErr || !contact) {
    throw new Error('No se encontró el contacto de esta cuenta.');
  }
  await assertConversationInAccount(db, args.conversationId, args.accountId);
  const destino = resolveContactSendTarget(contact);

  const id = randomUUID();
  const { error: insErr } = await db.from('messages').insert({
    id,
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.fila.content_type,
    content_text: args.fila.content_text,
    template_name: args.fila.template_name ?? null,
    media_url: args.fila.media_url ?? null,
    interactive_payload: args.fila.interactive_payload ?? null,
    ai_generated: args.fila.ai_generated ?? false,
    message_id: null,
    status: 'sending',
  });
  if (insErr) {
    throw new Error(
      `No se pudo guardar el mensaje (no se envió): ${insErr.message}`
    );
  }

  const r = await enviarPorProveedor({
    conversationId: args.conversationId,
    telefono: destino?.target ?? null,
    idMensaje: id,
    responderA: null,
    pedido: args.pedido,
  });

  if (r.estado === 'fallido') {
    await db
      .from('messages')
      .update({ status: 'failed', error_title: r.motivo.slice(0, 500) })
      .eq('id', id)
      .eq('status', 'sending');
    throw new Error(r.motivo);
  }

  let wamid = '';
  if (r.estado === 'enviado') {
    wamid = r.mensajeId;
    // Si el webhook ya adoptó la fila, `message_id` ya no es null: no cambia nada.
    await db
      .from('messages')
      .update({ message_id: wamid, status: 'sent' })
      .eq('id', id)
      .is('message_id', null);
    await applyPendingMessageStatuses(db, args.accountId, wamid);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.previa,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId);

  return { id, whatsapp_message_id: wamid, pendiente: r.estado === 'pendiente' };
}

/**
 * Una plantilla a un teléfono, sin conversación del proveedor (envíos masivos).
 * Zernio abre el chat con el teléfono. No lanza: devuelve el wamid o el motivo.
 * Un envío dudoso NO se reintenta (Zernio: «a blind retry could send it twice»):
 * se informa como tal para que nadie lo reenvíe a ciegas.
 */
export async function enviarPlantillaATelefono(args: {
  telefono: string;
  nombre: string;
  idioma: string;
  parametros: string[];
  idempotencia: string;
}): Promise<{ ok: true; wamid: string } | { ok: false; error: string; dudoso: boolean }> {
  try {
    const r = await crearProveedor().enviarPlantilla(
      { referencia: { conversacionId: null, cuentaId: null }, telefono: args.telefono },
      { nombre: args.nombre, idioma: args.idioma, parametros: args.parametros },
      { idempotencia: args.idempotencia }
    );
    return { ok: true, wamid: r.mensajeId };
  } catch (err) {
    const dudoso = err instanceof ErrorProveedor && err.dudoso;
    const motivo = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      dudoso,
      error: dudoso
        ? `No se sabe si salió (el proveedor no respondió); no lo reenvíe sin revisar: ${motivo}`
        : motivo,
    };
  }
}
