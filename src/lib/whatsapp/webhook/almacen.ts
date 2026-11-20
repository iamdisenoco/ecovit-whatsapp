// ============================================================
// Lo que el webhook necesita de la base, en una interfaz chica.
//
// La implementación de verdad (`almacen-supabase.ts`) escribe con la clave de
// servicio; la de memoria (`almacen-memoria.ts`) es el doble para las pruebas
// de la ruta y del procesador. El procesador no sabe cuál tiene.
// ============================================================

import type { IdentidadRemitente, ReferenciaConversacion } from '../proveedor/tipos'

/** La cuenta de wacrm y quién firma las filas que crea el webhook. */
export interface Inquilino {
  accountId: string
  /** `user_id` NOT NULL de contacts/conversations: el dueño de la config o un admin. */
  usuarioId: string
  /** Desde cuándo está conectado el número. Lo anterior es historia (coexistencia). */
  conectadoDesde: string | null
}

export interface ConversacionFila {
  id: string
  status: string | null
  assigned_agent_id: string | null
  ai_autoreply_disabled: boolean
  ai_handoff_summary: string | null
  first_inbound_at: string | null
  last_inbound_at: string | null
}

export type ContentType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'template' | 'interactive'

export interface MensajeNuevo {
  /** Opcional: el id lo pone la base si no viene. */
  id?: string
  conversation_id: string
  sender_type: 'customer' | 'agent' | 'bot'
  sender_id: string | null
  content_type: ContentType
  content_text: string | null
  media_url: string | null
  media_type: string | null
  message_id: string
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  created_at: string
  reply_to_message_id: string | null
}

export interface EstadoEntrante {
  wamid: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  failure: { code: number; title: string; details: string | null } | null
  statusAt: string | null
}

export interface AlmacenWhatsApp {
  /** ¿Ya se procesó este id de evento? Sin la tabla de eventos, siempre `false`. */
  eventoYaProcesado(eventoId: string): Promise<boolean>
  /** Se marca DESPUÉS de procesar bien: si algo falla, Zernio reintenta y se procesa de nuevo. */
  marcarEventoProcesado(eventoId: string, tipo: string): Promise<void>

  resolverInquilino(): Promise<Inquilino>

  buscarOCrearContacto(
    inquilino: Inquilino,
    identidad: IdentidadRemitente,
  ): Promise<{ contactoId: string; creado: boolean }>
  buscarOCrearConversacion(
    inquilino: Inquilino,
    contactoId: string,
  ): Promise<{ conversacion: ConversacionFila; creada: boolean }>

  /** Guarda la conversación del proveedor para poder contestar en ella. */
  guardarReferencia(conversacionId: string, referencia: ReferenciaConversacion): Promise<void>

  /** Inserta si no existe (conversation_id, message_id). `null` = ya estaba: es un repetido. */
  insertarMensajeSiNuevo(fila: MensajeNuevo): Promise<{ id: string } | null>

  /** Id interno de un mensaje por su wamid, dentro de la conversación. */
  buscarMensajePorWamid(conversacionId: string, wamid: string): Promise<string | null>

  /**
   * Un envío nuestro que quedó dudoso (5xx o tiempo agotado) no tiene wamid. Si
   * llega su `message.sent`, se le pone el wamid aquí. `true` si concilió uno.
   */
  conciliarEnvioPendiente(conversacionId: string, texto: string | null, wamid: string): Promise<boolean>

  /** Sube el contador de no leídos y el resumen; reabre si estaba cerrada. */
  registrarEntrante(conversacion: ConversacionFila, resumen: string, recibidoEn: string): Promise<{ primerEntrante: boolean }>

  /** Resumen de la conversación tras un envío (desde el celular, por ejemplo). */
  registrarSaliente(conversacionId: string, resumen: string): Promise<void>

  /** Aplica un estado sin retroceder; si la fila todavía no existe, lo deja pendiente. */
  aplicarEstado(accountId: string, estado: EstadoEntrante): Promise<void>

  /** Calla al bot en ese chat (el mismo `ai_autoreply_disabled` de «Tomar el control»). */
  callarBot(conversacionId: string, motivo: string): Promise<void>
  /** Lo vuelve a despertar (solo si sigue callado por `motivo` y sin dueño). */
  despertarBot(conversacionId: string, motivo: string): Promise<void>
  /** Pausa los flujos activos del contacto, como cuando contesta un agente. */
  pausarFlujos(accountId: string, contactoId: string): Promise<void>

  anotarCuentaDesconectada(accountId: string): Promise<void>

  /** Guarda un adjunto en el bucket privado y devuelve la ruta interna. */
  guardarAdjunto(ruta: string, bytes: Uint8Array, mime: string): Promise<boolean>
  /** Cambia la URL del adjunto (y el texto, si se da) de un mensaje ya guardado. */
  actualizarAdjunto(mensajeId: string, mediaUrl: string | null, texto?: string | null): Promise<void>
}

/** Errores que obligan a responder 500 (para que el proveedor reintente). */
export class ErrorAlmacen extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = 'ErrorAlmacen'
  }
}
