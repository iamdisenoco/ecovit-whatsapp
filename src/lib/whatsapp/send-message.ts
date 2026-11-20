// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { leerCredencialesMeta } from '@/lib/whatsapp/config-servidor';
import { nombreProveedor } from '@/lib/whatsapp/proveedor/nombre';
import { ErrorConfiguracion, type NombreProveedor } from '@/lib/whatsapp/proveedor/tipos';
import {
  enviarPorProveedor,
  urlParaProveedor,
  type PedidoEnvio,
} from '@/lib/whatsapp/enviar-por-proveedor';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { applyPendingMessageStatuses } from '@/lib/whatsapp/message-status-sync';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
  templateHeaderMediaUrl,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  senderId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message ('' mientras está pendiente). */
  whatsappMessageId: string;
  /**
   * ECOVIT · bloque 5: el proveedor respondió 5xx o no respondió. NO se
   * reintenta; la fila queda en `sending` y la resuelve el webhook.
   */
  pendiente?: boolean;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    senderId,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;

  // A contact is addressable by phone number OR by business-scoped user
  // ID. Meta withholds the phone number for a customer who has adopted
  // a WhatsApp username, so those contacts carry only a BSUID and are
  // reached through Meta's `recipient` field instead of `to` (issue
  // #519). Phone stays preferred when we have one: only it supports the
  // trunk-prefix variant retry below.
  const resolvedTarget = resolveContactSendTarget(contact);
  if (!resolvedTarget) {
    throw new SendMessageError(
      'bad_request',
      contact?.phone
        ? 'Invalid phone number format'
        : 'Contact has no phone number or WhatsApp user ID',
      400
    );
  }
  const sendTarget = resolvedTarget.target;
  const hasValidPhone = resolvedTarget.isPhone;
  const sanitizedPhone = hasValidPhone ? sendTarget : '';

  // ECOVIT · bloque 5: qué proveedor manda (RF-M03.8). Las credenciales de Meta
  // se leen con la clave de servicio y columnas nombradas: con la sesión,
  // `whatsapp_config.access_token` da 42501 (0110, B9). El auto-arreglo del
  // cifrado viejo (CBC) de wacrm se fue: escribía el token con la sesión.
  let proveedor: NombreProveedor;
  try {
    proveedor = nombreProveedor();
  } catch (err) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      err instanceof ErrorConfiguracion ? err.message : String(err),
      500
    );
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  // ECOVIT · bloque 5 (revisión 🔴2): la fila se guarda en `sending` ANTES
  // de llamar al proveedor, con id = la clave de idempotencia. Si el
  // `message.sent` del webhook llega antes que la respuesta, adopta ESTA fila
  // en vez de guardar otra (y el insert de aquí ya no choca con el índice
  // único). Con la sesión: la RLS decide si este vendedor escribe en el chat.
  // Sin `media_url` en el objeto: con el permiso por columna de la 0115,
  // nombrarla (aunque sea null) rechaza la sentencia entera con 42501. El
  // adjunto lo escribe la clave de servicio justo después.
  // El enlace que baja el proveedor se resuelve ANTES de guardar nada: si el
  // adjunto no se puede mandar desde aquí, no queda una fila a medias.
  // Lo que este proveedor no manda (botones y listas fuera de Meta) se rechaza
  // ANTES de guardar la fila: si no, quedaba huérfana en `sending`.
  if (proveedor !== 'meta' && messageType === 'interactive') {
    // TODO(zernio): botones y listas, sin verificar con Zernio (plan-wacrm).
    throw new SendMessageError(
      'no_soportado',
      'Los botones y las listas todavía no se envían por este proveedor.',
      400
    );
  }
  let urlEnvio: string | null = null;
  if (isMediaKind) {
    try {
      urlEnvio = await urlParaProveedor(mediaUrl!, accountId);
    } catch (err) {
      throw new SendMessageError(
        'bad_request',
        err instanceof Error ? err.message : String(err),
        400
      );
    }
  }
  const idMensaje = randomUUID();
  const mediaUrlFila =
    messageType === 'template'
      ? templateHeaderMediaUrl(templateRow, templateMessageParams)
      : mediaUrl || null;
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      id: idMensaje,
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: senderId ?? null,
      content_type: messageType,
      content_text: persistedText,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: null,
      status: 'sending',
      reply_to_message_id: replyToMessageId || null,
    })
    .select('id')
    .single();
  if (msgError || !messageRecord) {
    console.error('[send-message] error inserting message before send:', msgError);
    throw new SendMessageError(
      'db_error',
      `No se pudo guardar el mensaje (no se envió): ${msgError?.message ?? 'sin fila'}`,
      500
    );
  }
  const admin = supabaseAdmin();
  if (mediaUrlFila) {
    const { error: mediaErr } = await admin
      .from('messages')
      .update({ media_url: mediaUrlFila })
      .eq('id', idMensaje);
    if (mediaErr) console.error('[send-message] no se pudo anotar el adjunto:', mediaErr.message);
  }

  /** Un error definitivo: la fila queda en `failed` con el mensaje real. */
  const marcarFallido = async (motivo: string) => {
    const { error } = await admin
      .from('messages')
      .update({ status: 'failed', error_title: motivo.slice(0, 500) })
      .eq('id', idMensaje)
      .eq('status', 'sending');
    if (error) console.error('[send-message] no se pudo marcar el fallo:', error.message);
  };

  let waMessageId = '';
  let workingPhone = sendTarget;
  let pendiente = false;

  if (proveedor !== 'meta') {
    const pedido: PedidoEnvio =
      messageType === 'template'
        ? {
            clase: 'plantilla',
            nombre: templateName!,
            idioma: sendLanguage,
            parametros: templateBodyParams(templateParams, templateMessageParams),
          }
        : isMediaKind
          ? {
              clase: 'media',
              tipo: messageType as MediaKind,
              url: urlEnvio!,
              texto: contentText || null,
              nombreArchivo: filename || null,
            }
          : { clase: 'texto', texto: contentText! };
    const r = await enviarPorProveedor({
      conversationId,
      telefono: sendTarget,
      idMensaje,
      responderA: contextMessageId ?? null,
      pedido,
    });
    if (r.estado === 'fallido') {
      await marcarFallido(r.motivo);
      throw new SendMessageError(r.codigo, r.motivo, r.status);
    }
    if (r.estado === 'pendiente') pendiente = true;
    else waMessageId = r.mensajeId;
  } else {
    const config = await leerCredencialesMeta(accountId);
    if (!config) {
      await marcarFallido('WhatsApp (Meta) no está configurado.');
      throw new SendMessageError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    const accessToken = config.accessToken;

    const attempt = async (phone: string): Promise<string> => {
      if (messageType === 'template') {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phoneNumberId,
          accessToken,
          to: phone,
          templateName: templateName!,
          language: sendLanguage,
          template: templateRow ?? undefined,
          messageParams: templateMessageParams ?? undefined,
          params: templateParams || [],
          contextMessageId,
        });
        return result.messageId;
      }
      if (isMediaKind) {
        const result = await sendMediaMessage({
          phoneNumberId: config.phoneNumberId,
          accessToken,
          to: phone,
          kind: messageType as MediaKind,
          link: urlEnvio!,
          caption: contentText || undefined,
          filename: filename || undefined,
          contextMessageId,
        });
        return result.messageId;
      }
      if (messageType === 'interactive') {
        const p = interactivePayload!;
        if (p.kind === 'buttons') {
          const result = await sendInteractiveButtons({
            phoneNumberId: config.phoneNumberId,
            accessToken,
            to: phone,
            bodyText: p.body,
            headerText: p.header || undefined,
            footerText: p.footer || undefined,
            buttons: p.buttons,
            contextMessageId,
          });
          return result.messageId;
        }
        const result = await sendInteractiveList({
          phoneNumberId: config.phoneNumberId,
          accessToken,
          to: phone,
          bodyText: p.body,
          buttonLabel: p.button_label,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          sections: p.sections,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendTextMessage({
        phoneNumberId: config.phoneNumberId,
        accessToken,
        to: phone,
        text: contentText!,
        contextMessageId,
      });
      return result.messageId;
    };

    // Send via Meta — retry across phone-number variants if Meta rejects
    // with "recipient not in allowed list"; persist a working variant
    // back to the contact so the next send goes straight through.
    try {
      // Variants only make sense for a phone number — a BSUID is opaque
      // and has exactly one correct form, so it gets a single attempt.
      const variants = hasValidPhone ? phoneVariants(sanitizedPhone) : [sendTarget];
      let lastError: unknown = null;

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant);
          workingPhone = variant;
          lastError = null;
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(message)) {
            throw err;
          }
          lastError = err;
          console.warn(
            `[send-message] variant "${variant}" rejected by Meta, trying next…`
          );
        }
      }

      if (lastError) throw lastError;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('[send-message] Meta send failed for all variants:', message);
      await marcarFallido(`Meta API error: ${message}`);
      throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
    }
  }

  // ECOVIT (bloque 3): `contacts.phone` ya no se escribe con la sesión de la
  // persona —cambiarlo re-enlaza el chat a otro cliente de ECOVIT—, y esta
  // función solo la llama `/api/whatsapp/send`, con la sesión. Meta aceptó
  // una variante del número: se anota en el registro y el contacto queda
  // como lo dejó el webhook.
  if (hasValidPhone && workingPhone !== sanitizedPhone) {
    console.warn(
      `[send-message] Meta aceptó ${workingPhone} para el contacto ${contact.id} (guardado: ${sanitizedPhone}); contacts.phone no se toca desde la sesión`
    );
  }

  if (!pendiente) {
    // Si el webhook ya adoptó la fila (`message.sent` antes que la respuesta),
    // `message_id` ya no es null y esto no cambia nada: es la misma fila.
    const { error: wamidErr } = await admin
      .from('messages')
      .update({ message_id: waMessageId, status: 'sent' })
      .eq('id', idMensaje)
      .is('message_id', null);
    if (wamidErr) console.error('[send-message] no se pudo anotar el wamid:', wamidErr.message);
    await applyPendingMessageStatuses(admin, accountId, waMessageId);
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId, pendiente };
}
