// ============================================================
// Un doble en memoria del almacén, para las pruebas del procesador y de la
// ruta del webhook. Imita las reglas de la base que importan aquí: el índice
// único (conversation_id, message_id), los estados que no retroceden (con la
// misma función que usa la app) y los estados que llegan antes que su fila.
// ============================================================

import { randomUUID } from 'node:crypto';
import {
  canAdvanceMessageStatus,
  furthestReachableStatus,
} from '../message-status';
import type {
  IdentidadRemitente,
  ReferenciaConversacion,
} from '../proveedor/tipos';
import type {
  AlmacenWhatsApp,
  ConversacionFila,
  EstadoEntrante,
  Inquilino,
  MensajeNuevo,
} from './almacen';

export interface MensajeMemoria extends MensajeNuevo {
  id: string;
  error_code: number | null;
  error_title: string | null;
}

export class AlmacenMemoria implements AlmacenWhatsApp {
  eventos = new Map<string, string>();
  contactos: Array<{
    id: string;
    telefono: string;
    waUserId: string | null;
    nombre: string;
  }> = [];
  conversaciones: Array<
    ConversacionFila & {
      contact_id: string;
      unread_count: number;
      last_message_text: string | null;
    }
  > = [];
  referencias = new Map<string, ReferenciaConversacion>();
  mensajes: MensajeMemoria[] = [];
  pendientes: EstadoEntrante[] = [];
  flujosPausados: string[] = [];
  cuentaDesconectada = false;
  archivos = new Map<string, { bytes: Uint8Array; mime: string }>();
  /** Para simular una base caída: el siguiente insert lanza. */
  fallarSiguienteInsert = false;

  constructor(
    public inquilino: Inquilino = {
      accountId: 'cuenta-1',
      usuarioId: 'usuario-1',
      conectadoDesde: null,
    }
  ) {}

  async eventoYaProcesado(id: string) {
    return this.eventos.has(id);
  }
  async marcarEventoProcesado(id: string, tipo: string) {
    this.eventos.set(id, tipo);
  }
  async resolverInquilino() {
    return this.inquilino;
  }

  async buscarOCrearContacto(_inq: Inquilino, identidad: IdentidadRemitente) {
    const existente =
      (identidad.waUserId &&
        this.contactos.find((c) => c.waUserId === identidad.waUserId)) ||
      (identidad.telefono &&
        this.contactos.find((c) => c.telefono === identidad.telefono));
    if (existente) {
      if (identidad.waUserId && !existente.waUserId)
        existente.waUserId = identidad.waUserId;
      if (identidad.telefono && !existente.telefono)
        existente.telefono = identidad.telefono;
      return { contactoId: existente.id, creado: false };
    }
    const id = randomUUID();
    this.contactos.push({
      id,
      telefono: identidad.telefono,
      waUserId: identidad.waUserId,
      nombre: identidad.nombre,
    });
    return { contactoId: id, creado: true };
  }

  async buscarOCrearConversacion(_inq: Inquilino, contactoId: string) {
    const existente = this.conversaciones.find(
      (c) => c.contact_id === contactoId
    );
    if (existente) return { conversacion: { ...existente }, creada: false };
    const nueva = {
      id: randomUUID(),
      contact_id: contactoId,
      status: 'open',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
      first_inbound_at: null,
      last_inbound_at: null,
      unread_count: 0,
      last_message_text: null,
    };
    this.conversaciones.push(nueva);
    return { conversacion: { ...nueva }, creada: true };
  }

  conversacion(id: string) {
    const c = this.conversaciones.find((x) => x.id === id);
    if (!c) throw new Error(`conversación ${id} no existe`);
    return c;
  }

  async guardarReferencia(conversacionId: string, ref: ReferenciaConversacion) {
    this.referencias.set(conversacionId, ref);
  }

  async insertarMensajeSiNuevo(fila: MensajeNuevo) {
    if (this.fallarSiguienteInsert) {
      this.fallarSiguienteInsert = false;
      throw new Error('base caída (simulada)');
    }
    if (
      this.mensajes.some(
        (m) =>
          m.conversation_id === fila.conversation_id &&
          m.message_id === fila.message_id
      )
    ) {
      return null;
    }
    const id = fila.id ?? randomUUID();
    this.mensajes.push({ ...fila, id, error_code: null, error_title: null });
    // Los estados que llegaron antes que la fila (pending_message_statuses).
    const parked = this.pendientes.filter((p) => p.wamid === fila.message_id);
    if (parked.length) {
      const m = this.mensajes[this.mensajes.length - 1];
      const destino = furthestReachableStatus(
        m.status,
        parked.map((p) => p.status)
      );
      if (destino) m.status = destino;
      this.pendientes = this.pendientes.filter(
        (p) => p.wamid !== fila.message_id
      );
    }
    return { id };
  }

  async buscarMensajePorWamid(conversacionId: string, wamid: string) {
    return (
      this.mensajes.find(
        (m) => m.conversation_id === conversacionId && m.message_id === wamid
      )?.id ?? null
    );
  }

  async conciliarEnvioPendiente(
    conversacionId: string,
    texto: string | null,
    wamid: string
  ) {
    const m = this.mensajes.find(
      (x) =>
        x.conversation_id === conversacionId &&
        x.status === 'sending' &&
        !x.message_id &&
        (x.content_text ?? null) === (texto ?? null)
    );
    if (!m) return false;
    m.message_id = wamid;
    m.status = 'sent';
    return true;
  }

  async registrarEntrante(
    conv: ConversacionFila,
    resumen: string,
    recibidoEn: string
  ) {
    const c = this.conversacion(conv.id);
    c.unread_count++;
    c.last_message_text = resumen;
    c.last_inbound_at = recibidoEn;
    if (c.status === 'closed') c.status = 'open';
    const primerEntrante = !c.first_inbound_at;
    c.first_inbound_at ??= recibidoEn;
    return { primerEntrante };
  }

  async registrarSaliente(conversacionId: string, resumen: string) {
    this.conversacion(conversacionId).last_message_text = resumen;
  }

  async aplicarEstado(_accountId: string, estado: EstadoEntrante) {
    const filas = this.mensajes.filter((m) => m.message_id === estado.wamid);
    if (filas.length === 0) {
      this.pendientes.push(estado);
      return;
    }
    for (const m of filas) {
      if (!canAdvanceMessageStatus(m.status, estado.status)) continue;
      m.status = estado.status;
      if (estado.status === 'failed' && estado.failure) {
        m.error_code = estado.failure.code;
        m.error_title = estado.failure.title;
      }
    }
  }

  async callarBot(conversacionId: string, motivo: string) {
    const c = this.conversacion(conversacionId);
    c.ai_autoreply_disabled = true;
    c.ai_handoff_summary = motivo;
  }

  async despertarBot(conversacionId: string, motivo: string) {
    const c = this.conversacion(conversacionId);
    if (
      c.ai_autoreply_disabled &&
      c.ai_handoff_summary === motivo &&
      !c.assigned_agent_id
    ) {
      c.ai_autoreply_disabled = false;
      c.ai_handoff_summary = null;
    }
  }

  async pausarFlujos(_accountId: string, contactoId: string) {
    this.flujosPausados.push(contactoId);
  }

  async anotarCuentaDesconectada() {
    this.cuentaDesconectada = true;
  }

  async guardarAdjunto(ruta: string, bytes: Uint8Array, mime: string) {
    this.archivos.set(ruta, { bytes, mime });
    return true;
  }

  async actualizarAdjunto(
    mensajeId: string,
    mediaUrl: string | null,
    texto?: string | null
  ) {
    const m = this.mensajes.find((x) => x.id === mensajeId);
    if (!m) return;
    m.media_url = mediaUrl;
    if (texto !== undefined) m.content_text = texto;
  }
}
