// ============================================================
// El procesamiento de los eventos normalizados (plan.md §3, pasos 3 y 4).
//
// Corre ANTES de responder: guarda lo que llegó y deja para `after()` solo lo
// pesado (bajar adjuntos y despertar a los motores y al bot). Si algo de lo que
// guarda falla, lanza: la ruta responde 500, el evento NO queda marcado y
// Zernio lo reintenta. Lo que se repite no se guarda dos veces: por el `id` del
// evento (`registrar_evento_wa`, 0115) y por el wamid del mensaje
// (índice único `conversation_id, message_id`).
// ============================================================

import type {
  AdjuntoEntrante,
  EventoMensajeEntrante,
  EventoMensajeEnviado,
  EventoWhatsApp,
  IdentidadRemitente,
  ReferenciaConversacion,
} from '../proveedor/tipos';
import {
  EventoEnCurso,
  type AlmacenWhatsApp,
  type ContentType,
  type ConversacionFila,
  type Inquilino,
  type MensajeNuevo,
  type OpcionesConversacionNueva,
} from './almacen';
import {
  MOTIVO_CELULAR,
  debeVolverElBot,
  ecoDelCelularCallaAlBot,
  entrantePuedeDespertarAlBot,
  puedeVolverPorCelular,
} from './coexistencia';

/** Texto que queda en el chat mientras el adjunto no se haya bajado. */
export const ADJUNTO_SIN_DESCARGAR = 'Adjunto recibido, sin descargar';

export interface TrabajoAdjunto {
  clase: 'adjunto';
  accountId: string;
  mensajeId: string;
  wamid: string;
  adjunto: AdjuntoEntrante;
  /** El texto real del mensaje (sin el aviso de «sin descargar»). */
  textoOriginal: string | null;
}

export interface TrabajoMotores {
  clase: 'motores';
  inquilino: Inquilino;
  contactoId: string;
  contactoCreado: boolean;
  conversacionId: string;
  wamid: string;
  texto: string;
  primerEntrante: boolean;
}

export type TrabajoPosterior = TrabajoAdjunto | TrabajoMotores;

export interface ResultadoProcesar {
  procesados: number;
  repetidos: number;
  ignorados: number;
  trabajos: TrabajoPosterior[];
}

function tieneIdentidad(id: IdentidadRemitente): boolean {
  return !!id.telefono || !!id.waUserId;
}

export function contentTypeDe(
  adjunto: AdjuntoEntrante | undefined
): ContentType {
  if (!adjunto) return 'text';
  switch (adjunto.tipo) {
    case 'image':
    case 'sticker':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    default:
      return 'document';
  }
}

export function resumen(texto: string | null, tipo: ContentType): string {
  return texto?.trim() ? texto : `[${tipo}]`;
}

/**
 * El chat de un mensaje: primero el que ya tiene guardada la conversación del
 * proveedor (así un eco con BSUID cae en el chat de un contacto guardado por
 * teléfono), después por BSUID o teléfono del contacto. Lo usan el webhook y el
 * importador del historial (`proveedor/historial.ts`).
 */
export async function chatDeMensaje(
  almacen: AlmacenWhatsApp,
  inq: Inquilino,
  identidad: IdentidadRemitente,
  referencia: ReferenciaConversacion,
  nueva?: OpcionesConversacionNueva
): Promise<{
  conversacion: ConversacionFila;
  contactoId: string;
  contactoCreado: boolean;
} | null> {
  if (referencia.conversacionId) {
    const porReferencia = await almacen.buscarConversacionPorReferencia(
      inq,
      referencia
    );
    if (porReferencia) {
      return {
        conversacion: porReferencia,
        contactoId: porReferencia.contact_id,
        contactoCreado: false,
      };
    }
  }
  // Sin teléfono ni BSUID no se crea un contacto vacío.
  if (!tieneIdentidad(identidad)) return null;
  const { contactoId, creado } = await almacen.buscarOCrearContacto(
    inq,
    identidad
  );
  const { conversacion } = await almacen.buscarOCrearConversacion(
    inq,
    contactoId,
    nueva
  );
  if (referencia.conversacionId) {
    await almacen.guardarReferencia(conversacion.id, referencia);
  }
  return { conversacion, contactoId, contactoCreado: creado };
}

export class Procesador {
  private inquilino: Inquilino | null = null;
  private avisoSinConexion = false;

  constructor(private readonly almacen: AlmacenWhatsApp) {}

  private async elInquilino(): Promise<Inquilino> {
    this.inquilino ??= await this.almacen.resolverInquilino();
    if (!this.inquilino.conectadoDesde && !this.avisoSinConexion) {
      this.avisoSinConexion = true;
      console.warn(
        '[webhook] sin fecha de conexión (whatsapp_config.conectado_desde ni WHATSAPP_CONECTADO_DESDE): todo se trata como historia y el bot no se despierta'
      );
    }
    return this.inquilino;
  }

  async procesar(eventos: EventoWhatsApp[]): Promise<ResultadoProcesar> {
    const resultado: ResultadoProcesar = {
      procesados: 0,
      repetidos: 0,
      ignorados: 0,
      trabajos: [],
    };

    for (const evento of eventos) {
      // Sin id no hay cómo marcarlo: se procesa y deduplica el wamid.
      const estado = evento.eventoId
        ? await this.almacen.tomarEvento(evento.eventoId, evento.tipo)
        : 'nuevo';
      if (estado === 'procesado') {
        resultado.repetidos++;
        continue;
      }
      if (estado === 'en_curso') throw new EventoEnCurso(evento.eventoId);
      const reintento = estado === 'reintento';

      // Las muestras de `POST /v1/webhooks/test` no crean contactos ni chats.
      if (evento.prueba || evento.tipo === 'prueba') {
        console.info(
          `[webhook] evento de prueba recibido (${evento.tipo}, id ${evento.eventoId || '—'})`
        );
      } else if (evento.tipo === 'ignorado') {
        resultado.ignorados++;
      } else if (evento.tipo === 'cuenta_desconectada') {
        const inq = await this.elInquilino();
        console.warn(
          `[webhook] el proveedor avisa que la cuenta ${evento.cuentaId ?? '—'} se desconectó`
        );
        await this.almacen.anotarCuentaDesconectada(inq.accountId);
      } else if (evento.tipo === 'estado') {
        const inq = await this.elInquilino();
        await this.almacen.aplicarEstado(inq.accountId, {
          wamid: evento.mensajeId,
          status: evento.estado,
          failure:
            evento.estado === 'failed' && evento.error
              ? {
                  code: evento.error.codigo ?? 0,
                  title: evento.error.titulo,
                  details: evento.error.detalle,
                }
              : null,
          statusAt: evento.ocurridoEn,
        });
      } else if (evento.tipo === 'mensaje_entrante') {
        const nuevo = await this.entrante(
          evento,
          resultado.trabajos,
          reintento
        );
        if (!nuevo) resultado.repetidos++;
      } else if (evento.tipo === 'mensaje_enviado') {
        const nuevo = await this.enviado(evento, reintento);
        if (!nuevo) resultado.repetidos++;
      }

      // Al final: si algo de arriba lanzó, el evento queda sin cerrar y el
      // reintento lo retoma desde donde quedó.
      if (evento.eventoId)
        await this.almacen.marcarEventoProcesado(evento.eventoId, evento.tipo);
      resultado.procesados++;
    }
    return resultado;
  }

  private chatDe(
    inq: Inquilino,
    identidad: IdentidadRemitente,
    referencia: ReferenciaConversacion
  ) {
    return chatDeMensaje(this.almacen, inq, identidad, referencia);
  }

  /** `false` si el mensaje ya estaba (repetido por wamid). */
  private async entrante(
    evento: EventoMensajeEntrante,
    trabajos: TrabajoPosterior[],
    reintento: boolean
  ): Promise<boolean> {
    if (!tieneIdentidad(evento.remitente)) {
      // Sin teléfono ni BSUID no hay a quién atarlo; reintentar no lo arregla.
      console.error(
        '[webhook] mensaje entrante sin teléfono ni BSUID; se descarta:',
        evento.mensajeId
      );
      return true;
    }
    const inq = await this.elInquilino();
    const chat = await this.chatDe(inq, evento.remitente, evento.referencia);
    if (!chat) return true;
    const { conversacion, contactoId, contactoCreado } = chat;

    const adjunto = evento.adjuntos[0];
    const tipo = contentTypeDe(adjunto);
    const responde = evento.citaA
      ? await this.almacen.buscarMensajePorWamid(conversacion.id, evento.citaA)
      : null;

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
      desde_celular: false,
    };
    let insertado = await this.almacen.insertarMensajeSiNuevo(fila);
    if (!insertado) {
      // Repetido por wamid. Si es la retoma de ESTE evento (quedó sin cerrar),
      // la fila entró pero lo que seguía no: se sigue desde ahí. Si es otro
      // evento con el mismo wamid, es un repetido y no despierta a nadie.
      if (!reintento) return false;
      const id = await this.almacen.buscarMensajePorWamid(
        conversacion.id,
        evento.mensajeId
      );
      if (!id) return false;
      insertado = { id };
    }

    // Callado por el celular y sin dueño: vuelve si la última respuesta del
    // celular ya tiene `HORAS_CELULAR`. Solo entonces se lee el último eco.
    if (puedeVolverPorCelular(conversacion)) {
      const ultimoEco = await this.almacen.ultimoEcoCelular(conversacion.id);
      if (debeVolverElBot(conversacion, ultimoEco, evento.enviadoEn)) {
        await this.almacen.despertarBot(conversacion.id, MOTIVO_CELULAR);
      }
    }
    const { primerEntrante } = await this.almacen.registrarEntrante(
      conversacion,
      resumen(evento.texto, tipo),
      evento.enviadoEn
    );

    if (adjunto) {
      trabajos.push({
        clase: 'adjunto',
        accountId: inq.accountId,
        mensajeId: insertado.id,
        wamid: evento.mensajeId,
        adjunto,
        textoOriginal: evento.texto,
      });
    }

    if (entrantePuedeDespertarAlBot(evento, inq.conectadoDesde)) {
      trabajos.push({
        clase: 'motores',
        inquilino: inq,
        contactoId,
        contactoCreado,
        conversacionId: conversacion.id,
        wamid: evento.mensajeId,
        texto: evento.texto ?? '',
        primerEntrante,
      });
    } else {
      console.info(
        `[webhook] entrante ${evento.mensajeId} guardado sin despertar al bot (historia, en espera o sin fecha de conexión)`
      );
    }
    return true;
  }

  /** Un mensaje que salió del número: por la API, el celular o el agente de Meta. */
  private async enviado(
    evento: EventoMensajeEnviado,
    reintento: boolean
  ): Promise<boolean> {
    if (
      !tieneIdentidad(evento.destinatario) &&
      !evento.referencia.conversacionId
    ) {
      console.error(
        '[webhook] message.sent sin participante identificable; se descarta:',
        evento.mensajeId
      );
      return true;
    }
    const inq = await this.elInquilino();
    const chat = await this.chatDe(inq, evento.destinatario, evento.referencia);
    if (!chat) {
      console.error(
        '[webhook] message.sent de un chat desconocido y sin participante; se descarta:',
        evento.mensajeId
      );
      return true;
    }
    const { conversacion, contactoId } = chat;

    const sent = {
      wamid: evento.mensajeId,
      status: 'sent' as const,
      failure: null,
      statusAt: evento.enviadoEn,
    };

    // Ya existe ese wamid (nuestro envío ya tiene su id, o es un repetido): no
    // se concilia nada con él, que chocaría con el índice único.
    const existente = await this.almacen.buscarMensajePorWamid(
      conversacion.id,
      evento.mensajeId
    );
    if (existente) {
      await this.almacen.aplicarEstado(inq.accountId, sent);
      if (!reintento || evento.origen !== 'celular') return false;
    } else if (evento.origen === 'api') {
      // Un envío de la bandeja se guarda ANTES de llamar al proveedor; si su
      // `message.sent` llega antes que la respuesta, aquí se adopta esa fila.
      const c = await this.almacen.conciliarEnvioPendiente(
        conversacion.id,
        evento.texto,
        evento.mensajeId
      );
      if (c === 'conciliado') return true;
      if (c === 'ambiguo') {
        // No se adivina: el evento queda anotado (whatsapp_eventos) y los
        // pendientes siguen su curso (su respuesta, o `incierto`).
        console.warn(
          `[webhook] message.sent ${evento.mensajeId}: varios envíos pendientes con el mismo texto; no se concilia`
        );
        return true;
      }
    }

    if (!existente) {
      const adjunto = evento.adjuntos[0];
      const tipo = contentTypeDe(adjunto);
      const insertado = await this.almacen.insertarMensajeSiNuevo({
        conversation_id: conversacion.id,
        // El agente de Meta es un bot ajeno; lo demás lo mandó una persona del negocio.
        sender_type: evento.origen === 'agente_meta' ? 'bot' : 'agent',
        // Desde el celular no hay usuario de la app detrás.
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
        desde_celular: evento.origen === 'celular',
      });
      if (!insertado) {
        await this.almacen.aplicarEstado(inq.accountId, sent);
        return false;
      }
      await this.almacen.registrarSaliente(
        conversacion.id,
        resumen(evento.texto, tipo)
      );
    }

    if (
      evento.origen === 'celular' &&
      ecoDelCelularCallaAlBot(evento.enviadoEn, inq.conectadoDesde)
    ) {
      console.info(
        `[webhook] contestado desde el celular en ${conversacion.id}: se calla el bot`
      );
      await this.almacen.callarBot(
        conversacion.id,
        evento.mensajeId,
        MOTIVO_CELULAR
      );
      await this.almacen.pausarFlujos(inq.accountId, contactoId);
    }
    return true;
  }
}
