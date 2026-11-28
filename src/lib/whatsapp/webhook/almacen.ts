// ============================================================
// Lo que el webhook necesita de la base, en una interfaz chica.
//
// La implementación de verdad (`almacen-supabase.ts`) escribe con la clave de
// servicio y las funciones de la migración 0115; la de memoria
// (`almacen-memoria.ts`) es el doble para las pruebas. El procesador no sabe
// cuál tiene.
// ============================================================

import type {
  IdentidadRemitente,
  ReferenciaConversacion,
} from '../proveedor/tipos';

/** La cuenta de wacrm y quién firma las filas que crea el webhook. */
export interface Inquilino {
  accountId: string;
  /** `user_id` NOT NULL de contacts/conversations: el dueño de la config o un admin. */
  usuarioId: string;
  /**
   * Desde cuándo está conectado el número. Lo anterior es historia
   * (coexistencia). `null` = no se sabe: todo se trata como historia.
   */
  conectadoDesde: string | null;
}

export interface ConversacionFila {
  id: string;
  contact_id: string;
  status: string | null;
  assigned_agent_id: string | null;
  ai_autoreply_disabled: boolean;
  ai_handoff_summary: string | null;
  first_inbound_at: string | null;
  last_inbound_at: string | null;
}

export type ContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  | 'interactive';

export interface MensajeNuevo {
  /** Opcional: el id lo pone la base si no viene. */
  id?: string;
  conversation_id: string;
  sender_type: 'customer' | 'agent' | 'bot';
  sender_id: string | null;
  content_type: ContentType;
  content_text: string | null;
  media_url: string | null;
  media_type: string | null;
  message_id: string;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
  reply_to_message_id: string | null;
  /** RF-M03.10: lo contestó un vendedor desde la app del celular. */
  desde_celular: boolean;
}

/** Cómo nace un chat si hay que crearlo. Si ya existía, no se toca. */
export interface OpcionesConversacionNueva {
  /** Nace cerrado en esa fecha (la historia: no queda «esperando respuesta»). */
  cerradaEn?: string;
  /** Su `created_at`: la historia lo pone en la fecha de su primer mensaje. */
  creadaEn?: string;
}

export interface ResumenHistoria {
  /** Texto del último mensaje de la tanda (o `[tipo]`). */
  resumen: string;
  /** Fecha ORIGINAL de ese mensaje. */
  ultimoEn: string;
  /** Fecha original del primer mensaje del cliente en la tanda, si hubo. */
  primerEntranteEn: string | null;
}

/** Lo que el importador necesita saber de un mensaje ya guardado. */
export interface MensajeGuardado {
  id: string;
  message_id: string;
  media_url: string | null;
  content_text: string | null;
}

/** Cómo quedó un chat al recalcularlo (`recalcularChat`). */
export type ChatRecalculado = 'recalculado' | 'vacio' | 'borrado';

export interface EstadoEntrante {
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  failure: { code: number; title: string; details: string | null } | null;
  statusAt: string | null;
}

/**
 * Lo que dice la base de un id de evento al llegar:
 * - `nuevo`: nunca se vio; este proceso lo toma.
 * - `reintento`: se tomó antes y quedó sin cerrar (más de 2 min): se retoma y
 *   se sigue desde donde quedó.
 * - `procesado`: ya se cerró bien; es un repetido.
 * - `en_curso`: otro lo tomó hace menos de 2 min y no lo cerró: hay que
 *   pedirle al proveedor que vuelva más tarde.
 */
export type EstadoEvento = 'nuevo' | 'reintento' | 'procesado' | 'en_curso';

export type Conciliacion = 'conciliado' | 'ambiguo' | 'ninguno';

export interface AlmacenWhatsApp {
  tomarEvento(eventoId: string, tipo: string): Promise<EstadoEvento>;
  /** Se cierra AL FINAL, cuando todo lo de antes de responder salió bien. */
  marcarEventoProcesado(eventoId: string, tipo: string): Promise<void>;

  resolverInquilino(): Promise<Inquilino>;

  /** El chat que ya tiene guardada esta conversación del proveedor. */
  buscarConversacionPorReferencia(
    inquilino: Inquilino,
    referencia: ReferenciaConversacion
  ): Promise<ConversacionFila | null>;
  buscarOCrearContacto(
    inquilino: Inquilino,
    identidad: IdentidadRemitente
  ): Promise<{ contactoId: string; creado: boolean }>;
  /**
   * El nombre de la agenda del número para los contactos que YA existen
   * (por teléfono). Nunca crea uno y nunca pisa un nombre puesto a mano: la
   * regla es `nombreParaCompletar` (`contactos-supabase.ts`). Devuelve cuántos
   * nombres se pusieron.
   */
  completarNombres(
    inquilino: Inquilino,
    pares: Array<{ telefono: string; nombre: string }>
  ): Promise<number>;
  buscarOCrearConversacion(
    inquilino: Inquilino,
    contactoId: string,
    nueva?: OpcionesConversacionNueva
  ): Promise<{ conversacion: ConversacionFila; creada: boolean }>;

  /** Guarda la conversación (y la cuenta) del proveedor para poder contestar. */
  guardarReferencia(
    conversacionId: string,
    referencia: ReferenciaConversacion
  ): Promise<void>;

  /** Inserta si no existe (conversation_id, message_id). `null` = ya estaba. */
  insertarMensajeSiNuevo(fila: MensajeNuevo): Promise<{ id: string } | null>;

  /**
   * Lo mismo en lote (la historia): un solo viaje por página. Devuelve cuántas
   * filas entraron de verdad; las repetidas no cuentan.
   */
  insertarMensajesSiNuevos(filas: MensajeNuevo[]): Promise<number>;

  /**
   * Los mensajes de esos wamids que ya están en el chat (para la historia:
   * cuáles tienen el adjunto bajado). Listas cortas: solo los de una página.
   */
  mensajesPorWamid(
    conversacionId: string,
    wamids: string[]
  ): Promise<MensajeGuardado[]>;

  /**
   * Borra del chat los mensajes con ESOS wamids y ESE texto exacto (los vacíos
   * de la sincronización que entraron antes de saber saltarlos). Nada más.
   * Devuelve cuántos borró.
   */
  borrarMensajesSinContenido(
    conversacionId: string,
    wamids: string[],
    texto: string
  ): Promise<number>;

  /**
   * Rehace el resumen del chat con los mensajes que le quedan: la vista
   * previa, `last_message_at`, `first_inbound_at`, `last_inbound_at` y
   * `last_reply_at` (los disparadores solo suben esas fechas; esto las
   * escribe directo, sin pasar por ellos). Si el chat lo creó la historia
   * (`created_at` anterior a `historiaAntesDe`), también `created_at` y, si
   * sigue cerrado desde entonces, `closed_at`, a su primer y último mensaje.
   * Sin mensajes: se borra solo si lo creó la historia, está cerrado, sin
   * dueño y sin nada colgado; si no, queda con la vista previa vacía.
   */
  recalcularChat(
    conversacionId: string,
    historiaAntesDe: string
  ): Promise<ChatRecalculado>;

  /** Id interno de un mensaje por su wamid, dentro de la conversación. */
  buscarMensajePorWamid(
    conversacionId: string,
    wamid: string
  ): Promise<string | null>;

  /**
   * `created_at` del último mensaje contestado desde el celular en ese chat
   * (`desde_celular = true`), o `null` si no hay ninguno.
   */
  ultimoEcoCelular(conversacionId: string): Promise<string | null>;

  /**
   * Un envío de la bandeja se guarda en `sending` sin wamid ANTES de llamar
   * al proveedor; si quedó dudoso pasa a `incierto`. Su `message.sent` le pone
   * el wamid aquí, pero solo si hay EXACTAMENTE un candidato con ese texto
   * en la ventana: con dos o más no se adivina (`ambiguo`).
   */
  conciliarEnvioPendiente(
    conversacionId: string,
    texto: string | null,
    wamid: string
  ): Promise<Conciliacion>;

  /** Sube el contador de no leídos y el resumen; reabre si estaba cerrada. */
  registrarEntrante(
    conversacion: ConversacionFila,
    resumen: string,
    recibidoEn: string
  ): Promise<{ primerEntrante: boolean }>;

  registrarSaliente(conversacionId: string, resumen: string): Promise<void>;

  /**
   * La historia importada (`proveedor/historial.ts`): pone el resumen y la fecha
   * del último mensaje solo si son más nuevos que lo que ya hay, y el primer
   * entrante solo si no había. No sube no leídos, no reabre, no toca al bot.
   */
  registrarHistoria(
    conversacionId: string,
    historia: ResumenHistoria
  ): Promise<void>;

  /**
   * Solo para un chat que CREÓ la historia: lleva `created_at` hacia atrás y
   * `closed_at` hacia adelante si `desde`/`hasta` son más extremos. Así el
   * tablero de la dirección lo cuenta en sus fechas reales. No reabre ni
   * toca un chat que alguien ya reabrió.
   */
  ajustarFechasHistoria(
    conversacionId: string,
    desde: string,
    hasta: string
  ): Promise<void>;

  /** Aplica un estado sin retroceder; si la fila todavía no existe, lo deja pendiente. */
  aplicarEstado(accountId: string, estado: EstadoEntrante): Promise<void>;

  /** `callar_bot_por_celular_wa`: calla al bot en ese chat, con bitácora. */
  callarBot(
    conversacionId: string,
    mensajeId: string,
    motivo: string
  ): Promise<void>;
  /** `despertar_bot_por_celular_wa`: solo si sigue callado por `motivo` y sin dueño. */
  despertarBot(conversacionId: string, motivo: string): Promise<void>;
  pausarFlujos(accountId: string, contactoId: string): Promise<void>;

  anotarCuentaDesconectada(accountId: string): Promise<void>;

  guardarAdjunto(
    ruta: string,
    bytes: Uint8Array,
    mime: string
  ): Promise<boolean>;
  actualizarAdjunto(
    mensajeId: string,
    mediaUrl: string | null,
    texto?: string | null
  ): Promise<void>;
}

/** Errores que obligan a responder 500 (para que el proveedor reintente). */
export class ErrorAlmacen extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorAlmacen';
  }
}

/** Otro proceso tiene el evento: 503 y que el proveedor vuelva más tarde. */
export class EventoEnCurso extends Error {
  constructor(eventoId: string) {
    super(`El evento ${eventoId} lo está procesando otra entrega.`);
    this.name = 'EventoEnCurso';
  }
}
