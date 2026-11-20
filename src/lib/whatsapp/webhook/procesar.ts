// ============================================================
// El procesamiento de los eventos normalizados (plan.md §3, pasos 3 y 4).
//
// Corre ANTES de responder: guarda lo que llegó y deja para `after()` solo lo
// pesado (bajar adjuntos y despertar a los motores y al bot). Si algo de lo que
// guarda falla, lanza: la ruta responde 500, el evento NO queda marcado y
// Zernio lo reintenta. Lo que se repite no se guarda dos veces: por el `id` del
// evento (cuando la base tiene dónde anotarlo) y por el wamid del mensaje
// (índice único `conversation_id, message_id`).
// ============================================================

import type {
  AdjuntoEntrante,
  EventoMensajeEntrante,
  EventoMensajeEnviado,
  EventoWhatsApp,
  IdentidadRemitente,
} from '../proveedor/tipos'
import type { AlmacenWhatsApp, ContentType, Inquilino, MensajeNuevo } from './almacen'
import {
  MOTIVO_CELULAR,
  debeDespertarPorInactividad,
  ecoDelCelularCallaAlBot,
  entrantePuedeDespertarAlBot,
} from './coexistencia'

/** Texto que queda en el chat mientras el adjunto no se haya bajado. */
export const ADJUNTO_SIN_DESCARGAR = 'Adjunto recibido, sin descargar'

export interface TrabajoAdjunto {
  clase: 'adjunto'
  accountId: string
  mensajeId: string
  wamid: string
  adjunto: AdjuntoEntrante
  /** El texto real del mensaje (sin el aviso de «sin descargar»). */
  textoOriginal: string | null
}

export interface TrabajoMotores {
  clase: 'motores'
  inquilino: Inquilino
  contactoId: string
  contactoCreado: boolean
  conversacionId: string
  wamid: string
  texto: string
  primerEntrante: boolean
}

export type TrabajoPosterior = TrabajoAdjunto | TrabajoMotores

export interface ResultadoProcesar {
  procesados: number
  repetidos: number
  ignorados: number
  trabajos: TrabajoPosterior[]
}

function tieneIdentidad(id: IdentidadRemitente): boolean {
  return !!id.telefono || !!id.waUserId
}

function contentTypeDe(adjunto: AdjuntoEntrante | undefined): ContentType {
  if (!adjunto) return 'text'
  switch (adjunto.tipo) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'document':
      return 'document'
    default:
      return 'document'
  }
}

function resumen(texto: string | null, tipo: ContentType): string {
  return texto?.trim() ? texto : `[${tipo}]`
}

export class Procesador {
  private inquilino: Inquilino | null = null

  constructor(private readonly almacen: AlmacenWhatsApp) {}

  private async elInquilino(): Promise<Inquilino> {
    this.inquilino ??= await this.almacen.resolverInquilino()
    return this.inquilino
  }

  async procesar(eventos: EventoWhatsApp[]): Promise<ResultadoProcesar> {
    const resultado: ResultadoProcesar = { procesados: 0, repetidos: 0, ignorados: 0, trabajos: [] }

    for (const evento of eventos) {
      if (evento.eventoId && (await this.almacen.eventoYaProcesado(evento.eventoId))) {
        resultado.repetidos++
        continue
      }

      // Las muestras de `POST /v1/webhooks/test` no crean contactos ni chats.
      if (evento.prueba || evento.tipo === 'prueba') {
        console.info(`[webhook] evento de prueba recibido (${evento.tipo}, id ${evento.eventoId || '—'})`)
      } else if (evento.tipo === 'ignorado') {
        resultado.ignorados++
      } else if (evento.tipo === 'cuenta_desconectada') {
        const inq = await this.elInquilino()
        console.warn(`[webhook] el proveedor avisa que la cuenta ${evento.cuentaId ?? '—'} se desconectó`)
        await this.almacen.anotarCuentaDesconectada(inq.accountId)
      } else if (evento.tipo === 'estado') {
        const inq = await this.elInquilino()
        await this.almacen.aplicarEstado(inq.accountId, {
          wamid: evento.mensajeId,
          status: evento.estado,
          failure:
            evento.estado === 'failed' && evento.error
              ? { code: evento.error.codigo ?? 0, title: evento.error.titulo, details: evento.error.detalle }
              : null,
          statusAt: evento.ocurridoEn,
        })
      } else if (evento.tipo === 'mensaje_entrante') {
        const nuevo = await this.entrante(evento, resultado.trabajos)
        if (!nuevo) resultado.repetidos++
      } else if (evento.tipo === 'mensaje_enviado') {
        const nuevo = await this.enviado(evento)
        if (!nuevo) resultado.repetidos++
      }

      if (evento.eventoId) await this.almacen.marcarEventoProcesado(evento.eventoId, evento.tipo)
      resultado.procesados++
    }
    return resultado
  }

  /** `false` si el mensaje ya estaba (repetido por wamid). */
  private async entrante(evento: EventoMensajeEntrante, trabajos: TrabajoPosterior[]): Promise<boolean> {
    if (!tieneIdentidad(evento.remitente)) {
      // Sin teléfono ni BSUID no hay a quién atarlo; reintentar no lo arregla.
      console.error('[webhook] mensaje entrante sin teléfono ni BSUID; se descarta:', evento.mensajeId)
      return true
    }
    const inq = await this.elInquilino()
    const { contactoId, creado } = await this.almacen.buscarOCrearContacto(inq, evento.remitente)
    const { conversacion } = await this.almacen.buscarOCrearConversacion(inq, contactoId)
    if (evento.referencia.conversacionId) {
      await this.almacen.guardarReferencia(conversacion.id, evento.referencia)
    }

    const adjunto = evento.adjuntos[0]
    const tipo = contentTypeDe(adjunto)
    const responde = evento.citaA ? await this.almacen.buscarMensajePorWamid(conversacion.id, evento.citaA) : null

    const fila: MensajeNuevo = {
      conversation_id: conversacion.id,
      sender_type: 'customer',
      sender_id: null,
      content_type: tipo,
      content_text: evento.texto ?? (adjunto ? ADJUNTO_SIN_DESCARGAR : null),
      media_url: null,
      media_type: adjunto?.mime ?? null,
      message_id: evento.mensajeId,
      status: 'delivered',
      created_at: evento.enviadoEn,
      reply_to_message_id: responde,
    }
    const insertado = await this.almacen.insertarMensajeSiNuevo(fila)
    if (!insertado) return false

    // Antes de registrar el entrante: `last_inbound_at` todavía es el anterior.
    if (debeDespertarPorInactividad(conversacion, evento.enviadoEn)) {
      await this.almacen.despertarBot(conversacion.id, MOTIVO_CELULAR)
    }
    const { primerEntrante } = await this.almacen.registrarEntrante(
      conversacion,
      resumen(evento.texto, tipo),
      evento.enviadoEn,
    )

    if (adjunto) {
      trabajos.push({
        clase: 'adjunto',
        accountId: inq.accountId,
        mensajeId: insertado.id,
        wamid: evento.mensajeId,
        adjunto,
        textoOriginal: evento.texto,
      })
    }

    if (entrantePuedeDespertarAlBot(evento, inq.conectadoDesde)) {
      trabajos.push({
        clase: 'motores',
        inquilino: inq,
        contactoId,
        contactoCreado: creado,
        conversacionId: conversacion.id,
        wamid: evento.mensajeId,
        texto: evento.texto ?? '',
        primerEntrante,
      })
    } else {
      console.info(`[webhook] entrante ${evento.mensajeId} guardado sin despertar al bot (historia o en espera)`)
    }
    return true
  }

  /** Un mensaje que salió del número: por la API, el celular o el agente de Meta. */
  private async enviado(evento: EventoMensajeEnviado): Promise<boolean> {
    if (!tieneIdentidad(evento.destinatario)) {
      console.error('[webhook] message.sent sin participante identificable; se descarta:', evento.mensajeId)
      return true
    }
    const inq = await this.elInquilino()
    const { contactoId } = await this.almacen.buscarOCrearContacto(inq, evento.destinatario)
    const { conversacion } = await this.almacen.buscarOCrearConversacion(inq, contactoId)
    if (evento.referencia.conversacionId) {
      await this.almacen.guardarReferencia(conversacion.id, evento.referencia)
    }

    // Un envío nuestro que quedó dudoso se resuelve aquí (plan.md §3, amarillo 7).
    if (evento.origen === 'api') {
      const conciliado = await this.almacen.conciliarEnvioPendiente(conversacion.id, evento.texto, evento.mensajeId)
      if (conciliado) return true
    }

    const adjunto = evento.adjuntos[0]
    const tipo = contentTypeDe(adjunto)
    const insertado = await this.almacen.insertarMensajeSiNuevo({
      conversation_id: conversacion.id,
      // El agente de Meta es un bot ajeno; lo demás lo mandó una persona del negocio.
      sender_type: evento.origen === 'agente_meta' ? 'bot' : 'agent',
      // Desde el celular no hay usuario de la app detrás.
      // TODO(SQL): marca «desde el celular» en la fila (columna pendiente).
      sender_id: null,
      content_type: tipo,
      content_text: evento.texto,
      // Saliente: la URL es la que se usó al enviar (en WhatsApp, por enlace).
      media_url: adjunto?.url ?? null,
      media_type: adjunto?.mime ?? null,
      message_id: evento.mensajeId,
      status: 'sent',
      created_at: evento.enviadoEn,
      reply_to_message_id: null,
    })
    if (!insertado) {
      // Ya estaba (nuestro propio envío, o un repetido): el estado «sent» igual vale.
      await this.almacen.aplicarEstado(inq.accountId, {
        wamid: evento.mensajeId,
        status: 'sent',
        failure: null,
        statusAt: evento.enviadoEn,
      })
      return false
    }

    await this.almacen.registrarSaliente(conversacion.id, resumen(evento.texto, tipo))

    if (evento.origen === 'celular' && ecoDelCelularCallaAlBot(evento.enviadoEn, inq.conectadoDesde)) {
      console.info(`[webhook] contestado desde el celular en ${conversacion.id}: se calla el bot`)
      await this.almacen.callarBot(conversacion.id, MOTIVO_CELULAR)
      await this.almacen.pausarFlujos(inq.accountId, contactoId)
    }
    return true
  }
}
