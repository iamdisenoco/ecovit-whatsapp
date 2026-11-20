// ============================================================
// El almacén de verdad: escribe con la clave de servicio (RLS no aplica; las
// rejas de columnas y los disparadores de la base sí). Es, junto con la ruta de
// Meta (`app/api/whatsapp/meta/webhook`), el ÚNICO lugar que crea contactos.
//
// Dos cosas que la base de hoy no tiene se toleran sin romper (pendientes de
// SQL, ver el informe del bloque 5):
//   · la tabla `whatsapp_eventos` para deduplicar por id de evento: sin ella se
//     deduplica solo por wamid (índice único conversation_id, message_id);
//   · la columna `conversations.proveedor_conversacion_id`: sin ella no se puede
//     contestar con Zernio en ese chat, y el envío lo dice.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound'
import { normalizePhone } from '../phone-utils'
import { applyMessageStatus, applyPendingMessageStatuses } from '../message-status-sync'
import { applyBroadcastRecipientStatus } from '../broadcast-recipient-webhook'
import type { Entorno, IdentidadRemitente, ReferenciaConversacion } from '../proveedor/tipos'
import {
  ErrorAlmacen,
  type AlmacenWhatsApp,
  type ConversacionFila,
  type EstadoEntrante,
  type Inquilino,
  type MensajeNuevo,
} from './almacen'

export const BUCKET_ADJUNTOS = 'chat-media'
export const TABLA_EVENTOS = 'whatsapp_eventos'
export const COLUMNA_REFERENCIA = 'proveedor_conversacion_id'

const COLUMNAS_CONVERSACION =
  'id, status, assigned_agent_id, ai_autoreply_disabled, ai_handoff_summary, first_inbound_at, last_inbound_at'

const COLUMNAS_CONTACTO = 'id, phone, name, wa_user_id, wa_parent_user_id, wa_username'

interface ContactoFila {
  id: string
  phone: string | null
  name: string | null
  wa_user_id: string | null
  wa_parent_user_id: string | null
  wa_username: string | null
}

/** Ventana para conciliar un envío dudoso con su `message.sent`. */
const VENTANA_CONCILIAR_MS = 15 * 60 * 1000

/** «Esa tabla o columna no existe»: la base todavía no tiene el SQL del bloque 5. */
export function faltaEnLaBase(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  return ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code ?? '')
}

const avisados = new Set<string>()
function avisarUnaVez(clave: string, mensaje: string) {
  if (avisados.has(clave)) return
  avisados.add(clave)
  console.warn(mensaje)
}

export class AlmacenSupabase implements AlmacenWhatsApp {
  private accountId: string | null = null

  constructor(
    private readonly db: SupabaseClient,
    private readonly env: Entorno = process.env,
  ) {}

  // ── Eventos ─────────────────────────────────────────────────────────

  async eventoYaProcesado(eventoId: string): Promise<boolean> {
    const { data, error } = await this.db.from(TABLA_EVENTOS).select('id').eq('id', eventoId).maybeSingle()
    if (faltaEnLaBase(error)) {
      avisarUnaVez(
        'eventos',
        `[webhook] falta la tabla ${TABLA_EVENTOS}: se deduplica solo por wamid (pendiente de SQL del bloque 5)`,
      )
      return false
    }
    if (error) throw new ErrorAlmacen(`No se pudo consultar el evento: ${error.message}`)
    return !!data
  }

  async marcarEventoProcesado(eventoId: string, tipo: string): Promise<void> {
    const { error } = await this.db
      .from(TABLA_EVENTOS)
      .upsert({ id: eventoId, tipo }, { onConflict: 'id', ignoreDuplicates: true })
    if (faltaEnLaBase(error)) return
    if (error) throw new ErrorAlmacen(`No se pudo marcar el evento: ${error.message}`)
  }

  // ── La cuenta ───────────────────────────────────────────────────────

  async resolverInquilino(): Promise<Inquilino> {
    // ECOVIT tiene una sola cuenta (restricción `accounts_solo_ecovit`).
    const { data: cuentas, error } = await this.db.from('accounts').select('id').limit(2)
    if (error) throw new ErrorAlmacen(`No se pudo leer la cuenta: ${error.message}`)
    if (!cuentas || cuentas.length !== 1) {
      throw new ErrorAlmacen(`Se esperaba una sola cuenta y hay ${cuentas?.length ?? 0}.`)
    }
    const accountId = cuentas[0].id as string

    const { data: config, error: errConfig } = await this.db
      .from('whatsapp_config')
      .select('user_id, connected_at')
      .eq('account_id', accountId)
      .maybeSingle()
    if (errConfig) throw new ErrorAlmacen(`No se pudo leer whatsapp_config: ${errConfig.message}`)

    let usuarioId = (config?.user_id as string | undefined) ?? null
    if (!usuarioId) {
      // Con Zernio la configuración vive en el entorno y puede no haber fila: las
      // filas nuevas las firma el primer admin de la cuenta.
      const { data: admins, error: errAdmin } = await this.db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .in('account_role', ['owner', 'admin'])
        .order('created_at', { ascending: true })
        .limit(1)
      if (errAdmin) throw new ErrorAlmacen(`No se pudo leer profiles: ${errAdmin.message}`)
      usuarioId = (admins?.[0]?.user_id as string | undefined) ?? null
    }
    if (!usuarioId) throw new ErrorAlmacen('No hay un admin en la cuenta para firmar las filas del webhook.')

    this.accountId = accountId
    return {
      accountId,
      usuarioId,
      conectadoDesde:
        (config?.connected_at as string | null | undefined) ?? (this.env.WHATSAPP_CONECTADO_DESDE?.trim() || null),
    }
  }

  // ── Contactos y conversaciones ──────────────────────────────────────

  private async contactoPorBsuid(accountId: string, waUserId: string): Promise<ContactoFila | null> {
    const { data, error } = await this.db
      .from('contacts')
      .select(COLUMNAS_CONTACTO)
      .eq('account_id', accountId)
      .eq('wa_user_id', waUserId)
      .maybeSingle()
    if (error) throw new ErrorAlmacen(`No se pudo buscar el contacto por BSUID: ${error.message}`)
    return (data as ContactoFila | null) ?? null
  }

  private async contactoPorTelefono(accountId: string, telefono: string): Promise<ContactoFila | null> {
    const c = await findExistingContact(this.db, accountId, telefono)
    return c ? (c as unknown as ContactoFila) : null
  }

  async buscarOCrearContacto(
    inq: Inquilino,
    identidad: IdentidadRemitente,
  ): Promise<{ contactoId: string; creado: boolean }> {
    let existente = identidad.waUserId ? await this.contactoPorBsuid(inq.accountId, identidad.waUserId) : null
    if (!existente && identidad.telefono) existente = await this.contactoPorTelefono(inq.accountId, identidad.telefono)

    if (existente) {
      // Solo completa lo que falta o lo que el proveedor sí dijo. El teléfono se
      // llena solo si estaba vacío: nunca se reescribe (re-enlazaría el chat a
      // otro cliente de ECOVIT, bloque 3).
      const cambios: Record<string, string> = {}
      const nombre = identidad.nombre || identidad.waUsername
      if (nombre && nombre !== existente.name) cambios.name = nombre
      if (identidad.waUserId && identidad.waUserId !== existente.wa_user_id) cambios.wa_user_id = identidad.waUserId
      if (identidad.waParentUserId && identidad.waParentUserId !== existente.wa_parent_user_id) {
        cambios.wa_parent_user_id = identidad.waParentUserId
      }
      if (identidad.waUsername && identidad.waUsername !== existente.wa_username) {
        cambios.wa_username = identidad.waUsername
      }
      if (identidad.telefono && !normalizePhone(existente.phone ?? '')) cambios.phone = identidad.telefono
      if (Object.keys(cambios).length > 0) {
        const { error } = await this.db
          .from('contacts')
          .update({ ...cambios, updated_at: new Date().toISOString() })
          .eq('id', existente.id)
        // Un BSUID que otra entrega ya tomó: no es fatal, el mensaje es de este contacto.
        if (error) console.error('[webhook] no se pudo completar la identidad del contacto:', error.message)
      }
      return { contactoId: existente.id, creado: false }
    }

    const nombre = identidad.nombre || identidad.waUsername || identidad.telefono || identidad.waUserId || ''
    const { data, error } = await this.db
      .from('contacts')
      .insert({
        account_id: inq.accountId,
        user_id: inq.usuarioId,
        // `phone` es NOT NULL: un remitente solo con BSUID queda con '' (índice parcial).
        phone: identidad.telefono,
        name: nombre,
        wa_user_id: identidad.waUserId,
        wa_parent_user_id: identidad.waParentUserId,
        wa_username: identidad.waUsername,
      })
      .select('id')
      .single()
    if (error) {
      // Carrera con otra entrega que lo creó primero: se usa el que quedó.
      if (isUniqueViolation(error)) {
        const ganador =
          (identidad.waUserId && (await this.contactoPorBsuid(inq.accountId, identidad.waUserId))) ||
          (identidad.telefono && (await this.contactoPorTelefono(inq.accountId, identidad.telefono))) ||
          null
        if (ganador) return { contactoId: ganador.id, creado: false }
      }
      throw new ErrorAlmacen(`No se pudo crear el contacto: ${error.message}`)
    }
    return { contactoId: data.id as string, creado: true }
  }

  private async conversacionDe(accountId: string, contactoId: string): Promise<ConversacionFila | null> {
    // La más vieja: la misma que conserva la deduplicación de wacrm (#363).
    const { data, error } = await this.db
      .from('conversations')
      .select(COLUMNAS_CONVERSACION)
      .eq('account_id', accountId)
      .eq('contact_id', contactoId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw new ErrorAlmacen(`No se pudo buscar la conversación: ${error.message}`)
    return (data?.[0] as ConversacionFila | undefined) ?? null
  }

  async buscarOCrearConversacion(
    inq: Inquilino,
    contactoId: string,
  ): Promise<{ conversacion: ConversacionFila; creada: boolean }> {
    const existente = await this.conversacionDe(inq.accountId, contactoId)
    if (existente) return { conversacion: existente, creada: false }

    // Sin asignado: el webhook nunca escribe `assigned_agent_id` (reja de la 0113).
    const { data, error } = await this.db
      .from('conversations')
      .insert({ account_id: inq.accountId, user_id: inq.usuarioId, contact_id: contactoId })
      .select(COLUMNAS_CONVERSACION)
      .single()
    if (error) {
      if (isUniqueViolation(error)) {
        const ganadora = await this.conversacionDe(inq.accountId, contactoId)
        if (ganadora) return { conversacion: ganadora, creada: false }
      }
      throw new ErrorAlmacen(`No se pudo crear la conversación: ${error.message}`)
    }
    return { conversacion: data as ConversacionFila, creada: true }
  }

  async guardarReferencia(conversacionId: string, ref: ReferenciaConversacion): Promise<void> {
    if (!ref.conversacionId) return
    const { error } = await this.db
      .from('conversations')
      .update({ [COLUMNA_REFERENCIA]: ref.conversacionId })
      .eq('id', conversacionId)
    if (faltaEnLaBase(error)) {
      avisarUnaVez(
        'referencia',
        `[webhook] falta conversations.${COLUMNA_REFERENCIA}: no se podrá contestar por Zernio (pendiente de SQL del bloque 5)`,
      )
      return
    }
    if (error) throw new ErrorAlmacen(`No se pudo guardar la conversación del proveedor: ${error.message}`)
  }

  // ── Mensajes ────────────────────────────────────────────────────────

  async insertarMensajeSiNuevo(fila: MensajeNuevo): Promise<{ id: string } | null> {
    // `ignoreDuplicates` = ON CONFLICT DO NOTHING; `.select()` devuelve la fila
    // solo si de verdad se insertó. Vacío = repetido (wacrm #367).
    const { data, error } = await this.db
      .from('messages')
      .upsert(fila, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw new ErrorAlmacen(`No se pudo guardar el mensaje: ${error.message}`)
    if (!data || data.length === 0) return null
    if (fila.sender_type !== 'customer' && this.accountId) {
      // Un «entregado» o «leído» que llegó antes que el `message.sent`.
      await applyPendingMessageStatuses(this.db, this.accountId, fila.message_id)
    }
    return { id: data[0].id as string }
  }

  async buscarMensajePorWamid(conversacionId: string, wamid: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversacionId)
      .eq('message_id', wamid)
      .maybeSingle()
    if (error) {
      console.error('[webhook] no se encontró el mensaje citado:', error.message)
      return null
    }
    return (data?.id as string | undefined) ?? null
  }

  async conciliarEnvioPendiente(conversacionId: string, texto: string | null, wamid: string): Promise<boolean> {
    let consulta = this.db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversacionId)
      .eq('status', 'sending')
      .is('message_id', null)
      .gte('created_at', new Date(Date.now() - VENTANA_CONCILIAR_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(1)
    consulta = texto === null ? consulta.is('content_text', null) : consulta.eq('content_text', texto)
    const { data, error } = await consulta
    if (error) throw new ErrorAlmacen(`No se pudo buscar el envío pendiente: ${error.message}`)
    const id = data?.[0]?.id as string | undefined
    if (!id) return false

    const { data: actualizado, error: errUpd } = await this.db
      .from('messages')
      .update({ message_id: wamid, status: 'sent' })
      .eq('id', id)
      .eq('status', 'sending')
      .is('message_id', null)
      .select('id')
    if (errUpd) throw new ErrorAlmacen(`No se pudo conciliar el envío pendiente: ${errUpd.message}`)
    if (!actualizado?.length) return false
    if (this.accountId) await applyPendingMessageStatuses(this.db, this.accountId, wamid)
    return true
  }

  async registrarEntrante(
    conv: ConversacionFila,
    resumen: string,
    recibidoEn: string,
  ): Promise<{ primerEntrante: boolean }> {
    // El contador sube en la base, en un solo UPDATE (wacrm #369).
    const { error } = await this.db.rpc('bump_conversation_on_inbound', {
      p_conversation_id: conv.id,
      p_last_message_text: resumen,
    })
    if (error) console.error('[webhook] no se pudo actualizar la conversación:', error.message)
    const primerEntrante = await claimFirstInboundMessage(this.db, conv, recibidoEn)
    await reopenClosedConversation(this.db, conv)
    return { primerEntrante }
  }

  async registrarSaliente(conversacionId: string, resumen: string): Promise<void> {
    const ahora = new Date().toISOString()
    const { error } = await this.db
      .from('conversations')
      .update({ last_message_text: resumen, last_message_at: ahora, updated_at: ahora })
      .eq('id', conversacionId)
    if (error) console.error('[webhook] no se pudo actualizar el resumen de la conversación:', error.message)
  }

  async aplicarEstado(accountId: string, estado: EstadoEntrante): Promise<void> {
    // No retrocede (message-status.ts) y, si la fila no existe todavía, queda en
    // `pending_message_statuses` hasta que llegue.
    await applyMessageStatus(this.db, accountId, estado)
    await applyBroadcastRecipientStatus(this.db, {
      whatsappMessageId: estado.wamid,
      status: estado.status,
      occurredAt: estado.statusAt ?? new Date().toISOString(),
      failure: estado.failure,
    })
  }

  // ── El bot ──────────────────────────────────────────────────────────

  async callarBot(conversacionId: string, motivo: string): Promise<void> {
    // Si ya estaba callado (alguien lo tomó), no se pisa su nota.
    const { error } = await this.db
      .from('conversations')
      .update({ ai_autoreply_disabled: true, ai_handoff_summary: motivo })
      .eq('id', conversacionId)
      .eq('ai_autoreply_disabled', false)
    if (error) throw new ErrorAlmacen(`No se pudo callar al bot: ${error.message}`)
  }

  async despertarBot(conversacionId: string, motivo: string): Promise<void> {
    const { error } = await this.db
      .from('conversations')
      .update({ ai_autoreply_disabled: false, ai_handoff_summary: null, ai_reply_count: 0 })
      .eq('id', conversacionId)
      .eq('ai_handoff_summary', motivo)
      .is('assigned_agent_id', null)
    if (error) throw new ErrorAlmacen(`No se pudo devolver el chat al bot: ${error.message}`)
  }

  async pausarFlujos(accountId: string, contactoId: string): Promise<void> {
    const { error } = await this.db
      .from('flow_runs')
      .update({ status: 'paused_by_agent', ended_at: new Date().toISOString(), end_reason: 'agent_replied' })
      .eq('account_id', accountId)
      .eq('contact_id', contactoId)
      .eq('status', 'active')
    if (error) console.error('[webhook] no se pudieron pausar los flujos:', error.message)
  }

  async anotarCuentaDesconectada(accountId: string): Promise<void> {
    const { error } = await this.db
      .from('whatsapp_config')
      .update({ status: 'disconnected' })
      .eq('account_id', accountId)
    if (error) throw new ErrorAlmacen(`No se pudo anotar la desconexión: ${error.message}`)
  }

  // ── Adjuntos ────────────────────────────────────────────────────────

  async guardarAdjunto(ruta: string, bytes: Uint8Array, mime: string): Promise<boolean> {
    const { error } = await this.db.storage
      .from(BUCKET_ADJUNTOS)
      .upload(ruta, bytes, { contentType: mime, cacheControl: '3600', upsert: true })
    if (error) {
      console.error('[webhook] no se pudo guardar el adjunto en Storage:', error.message)
      return false
    }
    return true
  }

  async actualizarAdjunto(mensajeId: string, mediaUrl: string | null, texto?: string | null): Promise<void> {
    const cambios: Record<string, string | null> = { media_url: mediaUrl }
    if (texto !== undefined) cambios.content_text = texto
    const { error } = await this.db.from('messages').update(cambios).eq('id', mensajeId)
    if (error) console.error('[webhook] no se pudo anotar el adjunto en el mensaje:', error.message)
  }
}
