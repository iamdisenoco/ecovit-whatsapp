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
  Conciliacion,
  ConversacionFila,
  EstadoEntrante,
  EstadoEvento,
  Inquilino,
  MensajeNuevo,
  OpcionesConversacionNueva,
  ResumenHistoria,
} from './almacen';

/** La ventana de conciliación de la base (`almacen-supabase.ts`). */
const VENTANA_CONCILIAR_MS = 15 * 60 * 1000;

export interface MensajeMemoria extends Omit<MensajeNuevo, 'status'> {
  id: string;
  status: MensajeNuevo['status'] | 'incierto';
  error_code: number | null;
  error_title: string | null;
}

export class AlmacenMemoria implements AlmacenWhatsApp {
  /** Como `whatsapp_eventos`: tipo, cuándo se tomó y si se cerró. */
  eventos = new Map<
    string,
    { tipo: string; tomadoEn: number; procesado: boolean }
  >();
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
      last_message_at: string | null;
      closed_at?: string | null;
      last_reply_at?: string | null;
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
      conectadoDesde: '2026-01-01T00:00:00Z',
    }
  ) {}

  /** Imita `registrar_evento_wa`: retoma lo que quedó sin cerrar más de 2 min. */
  async tomarEvento(id: string, tipo: string): Promise<EstadoEvento> {
    const previo = this.eventos.get(id);
    if (!previo) {
      this.eventos.set(id, { tipo, tomadoEn: Date.now(), procesado: false });
      return 'nuevo';
    }
    if (previo.procesado) return 'procesado';
    if (Date.now() - previo.tomadoEn < 2 * 60 * 1000) return 'en_curso';
    previo.tomadoEn = Date.now();
    return 'reintento';
  }
  async marcarEventoProcesado(id: string, tipo: string) {
    const previo = this.eventos.get(id);
    this.eventos.set(id, {
      tipo,
      tomadoEn: previo?.tomadoEn ?? Date.now(),
      procesado: true,
    });
  }
  /** En las pruebas: «pasaron los 2 minutos». */
  vencerEventosEnCurso() {
    for (const e of this.eventos.values()) if (!e.procesado) e.tomadoEn = 0;
  }
  procesado(id: string): boolean {
    return this.eventos.get(id)?.procesado === true;
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

  async buscarOCrearConversacion(
    _inq: Inquilino,
    contactoId: string,
    opciones?: OpcionesConversacionNueva
  ) {
    const existente = this.conversaciones.find(
      (c) => c.contact_id === contactoId
    );
    if (existente) return { conversacion: { ...existente }, creada: false };
    const nueva = {
      id: randomUUID(),
      contact_id: contactoId,
      status: opciones?.cerradaEn ? 'closed' : 'open',
      closed_at: opciones?.cerradaEn ?? null,
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
      first_inbound_at: null,
      last_inbound_at: null,
      unread_count: 0,
      last_message_text: null,
      last_message_at: null,
    };
    this.conversaciones.push(nueva);
    return { conversacion: { ...nueva }, creada: true };
  }

  conversacion(id: string) {
    const c = this.conversaciones.find((x) => x.id === id);
    if (!c) throw new Error(`conversación ${id} no existe`);
    return c;
  }

  async buscarConversacionPorReferencia(
    _inq: Inquilino,
    ref: ReferenciaConversacion
  ): Promise<ConversacionFila | null> {
    for (const [convId, r] of this.referencias) {
      if (
        r.conversacionId === ref.conversacionId &&
        (r.cuentaId ?? '') === (ref.cuentaId ?? '')
      ) {
        return { ...this.conversacion(convId) };
      }
    }
    return null;
  }

  async guardarReferencia(conversacionId: string, ref: ReferenciaConversacion) {
    this.referencias.set(conversacionId, ref);
  }

  async insertarMensajeSiNuevo(fila: MensajeNuevo) {
    return this.insertarUna(fila);
  }

  private async insertarUna(fila: MensajeNuevo) {
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
    // Como `track_conversation_message_times`: el entrante mueve
    // `last_inbound_at` con su fecha ORIGINAL y sin retroceder.
    const conv = this.conversaciones.find((c) => c.id === fila.conversation_id);
    if (conv && fila.sender_type === 'customer') {
      const previo = conv.last_inbound_at
        ? Date.parse(conv.last_inbound_at)
        : -Infinity;
      if (Date.parse(fila.created_at) > previo)
        conv.last_inbound_at = fila.created_at;
    }
    // …y lo del negocio mueve `last_reply_at`, salvo si falló.
    if (conv && fila.sender_type === 'agent' && fila.status !== 'failed') {
      const previo = conv.last_reply_at
        ? Date.parse(conv.last_reply_at)
        : -Infinity;
      if (Date.parse(fila.created_at) > previo)
        conv.last_reply_at = fila.created_at;
    }
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

  /** Contador de llamadas, para ver en las pruebas que la historia va en lote. */
  lotes = 0;
  async insertarMensajesSiNuevos(filas: MensajeNuevo[]) {
    this.lotes++;
    let n = 0;
    for (const f of filas) if (await this.insertarUna(f)) n++;
    return n;
  }

  async buscarMensajePorWamid(conversacionId: string, wamid: string) {
    return (
      this.mensajes.find(
        (m) => m.conversation_id === conversacionId && m.message_id === wamid
      )?.id ?? null
    );
  }

  async ultimoEcoCelular(conversacionId: string) {
    const ecos = this.mensajes
      .filter((m) => m.conversation_id === conversacionId && m.desde_celular)
      .map((m) => m.created_at)
      .sort((x, y) => Date.parse(y) - Date.parse(x));
    return ecos[0] ?? null;
  }

  async conciliarEnvioPendiente(
    conversacionId: string,
    texto: string | null,
    wamid: string
  ): Promise<Conciliacion> {
    if (
      this.mensajes.some(
        (m) => m.conversation_id === conversacionId && m.message_id === wamid
      )
    ) {
      return 'ninguno';
    }
    const desde = Date.now() - VENTANA_CONCILIAR_MS;
    const candidatos = this.mensajes.filter(
      (x) =>
        x.conversation_id === conversacionId &&
        (x.status === 'sending' || x.status === 'incierto') &&
        !x.message_id &&
        Date.parse(x.created_at) >= desde &&
        (x.content_text ?? null) === (texto ?? null)
    );
    if (candidatos.length === 0) return 'ninguno';
    if (candidatos.length > 1) return 'ambiguo';
    candidatos[0].message_id = wamid;
    candidatos[0].status = 'sent';
    return 'conciliado';
  }

  async registrarEntrante(
    conv: ConversacionFila,
    resumen: string,
    recibidoEn: string
  ) {
    const c = this.conversacion(conv.id);
    c.unread_count++;
    c.last_message_text = resumen;
    // `bump_conversation_on_inbound` pone NOW(); aquí, la hora de llegada.
    c.last_message_at = recibidoEn;
    c.last_inbound_at = recibidoEn;
    if (c.status === 'closed') c.status = 'open';
    const primerEntrante = !c.first_inbound_at;
    c.first_inbound_at ??= recibidoEn;
    return { primerEntrante };
  }

  async registrarSaliente(conversacionId: string, resumen: string) {
    this.conversacion(conversacionId).last_message_text = resumen;
  }

  async registrarHistoria(conversacionId: string, h: ResumenHistoria) {
    const c = this.conversacion(conversacionId);
    if (
      !c.last_message_at ||
      Date.parse(c.last_message_at) < Date.parse(h.ultimoEn)
    ) {
      c.last_message_text = h.resumen;
      c.last_message_at = h.ultimoEn;
    }
    if (h.primerEntranteEn) c.first_inbound_at ??= h.primerEntranteEn;
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

  async callarBot(conversacionId: string, _mensajeId: string, motivo: string) {
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
