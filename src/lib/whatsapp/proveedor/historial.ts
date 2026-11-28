// ============================================================
// El historial de la coexistencia: al conectar el número, Zernio sincroniza
// hasta 6 meses de chats en SU bandeja pero no los manda por webhook. Esto los
// trae (solo GET) y los guarda con el mismo almacén del webhook, como historia:
//
// - el contacto y el chat salen de `chatDeMensaje` (lo mismo que el webhook),
//   con `proveedor_conversacion_id` y `proveedor_cuenta_id`;
// - los mensajes de cada página entran en lote (`insertarMensajesSiNuevos`): el índice único
//   (conversation_id, message_id) evita duplicar con el webhook y entre
//   corridas. En Zernio el `id` del mensaje ES el wamid, igual que el
//   `platformMessageId` del webhook (medido el 28-nov);
// - nunca despierta al bot ni a los motores, no lo calla, no sube no leídos,
//   no reabre y no toca `ai_reply_count` ni `ai_autoreply_disabled`. El
//   resumen del chat se pone con `registrarHistoria`, que no retrocede;
// - solo entra lo ESTRICTAMENTE anterior a `conectado_desde`. Lo de después es
//   siempre del webhook: si la historia lo guardara primero, el webhook lo vería
//   repetido y el bot no contestaría un mensaje vivo. Sin esa fecha no se importa;
// - un chat que crea la historia nace cerrado (no queda «esperando respuesta»);
//   uno que ya existía no se toca, y uno sin mensajes importables no se crea.
//
// Después de los chats viene la fase de los contactos: recorre la agenda del
// número (`GET /v1/contacts`, que en coexistencia trae los contactos de la app
// del celular) y les pone el nombre a los contactos de la app que YA existen,
// cruzando por teléfono, con la regla única `nombreParaCompletar`. No crea
// contactos para quien no tiene chat ni pisa un nombre puesto a mano.
//
// Va por tramos (Vercel corta a los 60 s): cada llamada procesa hasta
// `maxConversaciones` chats o hasta `presupuestoMs`, y devuelve un cursor
// opaco para seguir. Es reanudable e idempotente.
// ============================================================

import type {
  AlmacenWhatsApp,
  ContentType,
  MensajeNuevo,
} from '../webhook/almacen';
import { nombreUtil } from '../webhook/contactos-supabase';
import { chatDeMensaje, resumen } from '../webhook/procesar';
import { obj, str, type Obj } from './zernio-webhook';
import { ZERNIO_URL_BASE } from './zernio';
import type { IdentidadRemitente } from './tipos';

/** Lo que se pone en el chat cuando el mensaje era solo un adjunto. */
export const TEXTO_ADJUNTO = '[adjunto]';
export const CONVERSACIONES_POR_PAGINA = 20;
export const MENSAJES_POR_PAGINA = 100;
/** Vercel corta a los 60 s: se deja margen para guardar y responder. */
export const PRESUPUESTO_MS = 25_000;
export const MAX_CONVERSACIONES_POR_TRAMO = 10;
/** El máximo que documenta `GET /v1/contacts`. */
export const CONTACTOS_POR_PAGINA = 100;

// ── Lo que se lee de Zernio ─────────────────────────────────────────────

export interface ConversacionRemota {
  id: string;
  cuentaId: string | null;
  plataforma: string | null;
  participanteId: string | null;
  participanteNombre: string | null;
  bsuid: string | null;
}

export interface MensajeRemoto {
  id: string;
  creadoEn: string;
  saliente: boolean;
  texto: string | null;
  adjuntos: Array<{ tipo: string | null; mime: string | null }>;
  estadoEntrega: string | null;
  borrado: boolean;
}

/** Un contacto de la agenda del número. `telefono` en dígitos, sin «+». */
export interface ContactoRemoto {
  id: string;
  nombre: string | null;
  telefono: string | null;
}

/** La agenda se pagina por posición (`skip`): `siguiente` es el próximo `skip`. */
export interface PaginaContactos {
  items: ContactoRemoto[];
  siguiente: number | null;
}

export interface Pagina<T> {
  items: T[];
  siguiente: string | null;
}

/** Lo único que el importador necesita del proveedor. Solo lectura. */
export interface FuenteHistorial {
  conversaciones(
    cuentaId: string,
    cursor: string | null,
    limite: number
  ): Promise<Pagina<ConversacionRemota>>;
  mensajes(
    cuentaId: string,
    conversacionId: string,
    cursor: string | null,
    limite: number
  ): Promise<Pagina<MensajeRemoto>>;
  /** La agenda del número (los contactos de WhatsApp de esa cuenta). */
  contactos(
    cuentaId: string,
    salto: number,
    limite: number
  ): Promise<PaginaContactos>;
}

/** Leer UN contacto de la agenda (el webhook `contact.updated`). Solo lectura. */
export interface LectorContactos {
  /** `null` si el proveedor ya no lo tiene (404). */
  contacto(id: string, cuentaId: string | null): Promise<ContactoRemoto | null>;
}

/** 429: hay que esperar `esperaMs` antes de volver a pedir. */
export class LimiteDeVelocidad extends Error {
  constructor(readonly esperaMs: number) {
    super('La conexión de WhatsApp pidió esperar un momento.');
    this.name = 'LimiteDeVelocidad';
  }
}

/** No hay `conectado_desde`: no se sabe qué es historia. */
export class SinFechaDeConexion extends Error {
  constructor() {
    super(
      'Falta la fecha en que se conectó el número de WhatsApp. Sin ella no se puede importar el historial.'
    );
    this.name = 'SinFechaDeConexion';
  }
}

/** Error al leer el historial. El texto puede llegar a la pantalla: sin nombre de proveedor. */
export class ErrorHistorial extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorHistorial';
  }
}

function leerConversacion(crudo: unknown): ConversacionRemota | null {
  const c = obj(crudo);
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    cuentaId: str(c.accountId),
    plataforma: str(c.platform),
    participanteId: str(c.participantId),
    participanteNombre: str(c.participantName),
    bsuid: str(c.businessScopedUserId),
  };
}

function leerMensaje(crudo: unknown): MensajeRemoto | null {
  const m = obj(crudo);
  const id = str(m.id);
  const creadoEn = str(m.createdAt) ?? str(m.sentAt);
  if (!id || !creadoEn) return null;
  const adjuntos = Array.isArray(m.attachments)
    ? m.attachments.map((a) => {
        const x = obj(a);
        return { tipo: str(x.type), mime: str(x.mimeType) };
      })
    : [];
  return {
    id,
    creadoEn,
    // «incoming» / «outgoing» (medido). Cualquier otra cosa se toma como del cliente.
    saliente: str(m.direction) === 'outgoing',
    texto: str(m.message) ?? str(m.text),
    adjuntos,
    estadoEntrega: str(m.deliveryStatus),
    borrado: m.isDeleted === true,
  };
}

/** Solo dígitos, y solo si parece un teléfono (6 a 15). */
function telefonoDe(v: unknown): string | null {
  const d = (str(v) ?? '').replace(/\D/g, '');
  return /^\d{6,15}$/.test(d) ? d : null;
}

/** Un elemento de `GET /v1/contacts` (la lista ya viene filtrada por cuenta). */
export function leerContactoDeLista(crudo: unknown): ContactoRemoto | null {
  const c = obj(crudo);
  const id = str(c.id);
  if (!id) return null;
  const plataforma = str(c.platform);
  return {
    id,
    nombre: str(c.name)?.trim() ?? null,
    telefono:
      plataforma && plataforma !== 'whatsapp'
        ? null
        : telefonoDe(c.platformIdentifier),
  };
}

/**
 * `GET /v1/contacts/{id}`: `{ contact: { id, name }, channels: [...] }`. El
 * teléfono es el `platformIdentifier` del canal de WhatsApp de ESTA cuenta.
 */
export function leerContactoUno(
  json: Obj,
  cuentaId: string | null
): ContactoRemoto | null {
  const c = obj(json.contact);
  const id = str(c.id);
  if (!id) return null;
  const canales = Array.isArray(json.channels) ? json.channels.map(obj) : [];
  const canal = canales.find(
    (x) =>
      str(x.platform) === 'whatsapp' &&
      (!cuentaId || str(x.accountId) === cuentaId)
  );
  return {
    id,
    nombre: str(c.name)?.trim() ?? null,
    telefono: canal ? telefonoDe(canal.platformIdentifier) : null,
  };
}

function siguienteDe(json: Obj): string | null {
  const p = obj(json.pagination);
  return p.hasMore === true ? str(p.nextCursor) : null;
}

export interface ConfigFuenteZernio {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** La lectura de la bandeja de Zernio. SOLO GET. */
export class FuenteHistorialZernio
  implements FuenteHistorial, LectorContactos
{
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigFuenteZernio) {
    this.base = (config.baseUrl || ZERNIO_URL_BASE).replace(/\/+$/, '');
    this.f = config.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  private async get(
    ruta: string,
    params: Record<string, string | null>,
    nuloSi404 = false
  ): Promise<Obj | null> {
    const url = new URL(`${this.base}${ruta}`);
    for (const [k, v] of Object.entries(params))
      if (v !== null) url.searchParams.set(k, v);
    let r: Response;
    try {
      r = await this.f(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.error('[historial] zernio no respondió:', err);
      throw new ErrorHistorial('La conexión de WhatsApp no respondió.');
    }
    if (r.status === 429) {
      throw new LimiteDeVelocidad(esperaDe(r.headers));
    }
    const texto = await r.text().catch(() => '');
    if (r.status === 404 && nuloSi404) return null;
    if (!r.ok) {
      console.error(
        `[historial] zernio respondió ${r.status} en ${ruta}:`,
        texto.slice(0, 300)
      );
      throw new ErrorHistorial(
        `La conexión de WhatsApp respondió con un error (${r.status}).`
      );
    }
    try {
      return obj(JSON.parse(texto));
    } catch {
      throw new ErrorHistorial(
        'La conexión de WhatsApp respondió algo ilegible.'
      );
    }
  }

  async conversaciones(
    cuentaId: string,
    cursor: string | null,
    limite: number
  ) {
    const json = (await this.get('/inbox/conversations', {
      accountId: cuentaId,
      limit: String(limite),
      cursor,
    }))!;
    const lista = Array.isArray(json.data) ? json.data : [];
    return {
      items: lista
        .map(leerConversacion)
        .filter((c): c is ConversacionRemota => c !== null),
      siguiente: siguienteDe(json),
    };
  }

  async mensajes(
    cuentaId: string,
    conversacionId: string,
    cursor: string | null,
    limite: number
  ) {
    const json = (await this.get(
      `/inbox/conversations/${encodeURIComponent(conversacionId)}/messages`,
      { accountId: cuentaId, limit: String(limite), cursor }
    ))!;
    const lista = Array.isArray(json.messages)
      ? json.messages
      : Array.isArray(json.data)
        ? json.data
        : [];
    return {
      items: lista
        .map(leerMensaje)
        .filter((m): m is MensajeRemoto => m !== null),
      siguiente: siguienteDe(json),
    };
  }

  /**
   * `GET /v1/contacts?accountId&platform=whatsapp&limit&skip`. El siguiente
   * `skip` avanza por lo que LLEGÓ, no por el `limit` pedido: si el proveedor
   * devuelve menos, no se salta a nadie.
   */
  async contactos(
    cuentaId: string,
    salto: number,
    limite: number
  ): Promise<PaginaContactos> {
    const json = (await this.get('/contacts', {
      accountId: cuentaId,
      platform: 'whatsapp',
      limit: String(limite),
      skip: String(salto),
    }))!;
    const lista = Array.isArray(json.contacts) ? json.contacts : [];
    const p = obj(json.pagination);
    return {
      items: lista
        .map(leerContactoDeLista)
        .filter((c): c is ContactoRemoto => c !== null),
      siguiente:
        p.hasMore === true && lista.length > 0 ? salto + lista.length : null,
    };
  }

  async contacto(
    id: string,
    cuentaId: string | null
  ): Promise<ContactoRemoto | null> {
    const json = await this.get(
      `/contacts/${encodeURIComponent(id)}`,
      {},
      true
    );
    return json ? leerContactoUno(json, cuentaId) : null;
  }
}

/** `Retry-After` en segundos o, si no, `X-RateLimit-Reset` (epoch en segundos). */
export function esperaDe(h: Headers, ahora = Date.now()): number {
  const ra = Number(h.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra * 1000);
  const reset = Number(h.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - ahora;
    if (ms > 0 && ms < 120_000) return ms;
  }
  return 5_000;
}

// ── El cursor ───────────────────────────────────────────────────────────

/**
 * Dónde va la importación. Opaco para el navegador (base64url de JSON):
 * - `pagina`: el cursor de Zernio de la página de chats en curso (null = la primera);
 * - `hechas`: los chats de ESA página que ya se terminaron;
 * - `enCurso`: el chat a medias, el cursor de sus mensajes y si lo creó la historia;
 * - `listas`: cuántos chats van en total (para el avance);
 * - `fase`: `chats` y después `contactos` (la agenda, para los nombres);
 * - `saltoContactos`: el `skip` de la próxima página de la agenda.
 */
export interface EstadoImportacion {
  pagina: string | null;
  hechas: string[];
  enCurso: { id: string; cursor: string; creada?: boolean } | null;
  listas: number;
  fase: 'chats' | 'contactos';
  saltoContactos: number;
}

const INICIO: EstadoImportacion = {
  pagina: null,
  hechas: [],
  enCurso: null,
  listas: 0,
  fase: 'chats',
  saltoContactos: 0,
};

export function codificarCursor(e: EstadoImportacion): string {
  return Buffer.from(JSON.stringify(e), 'utf8').toString('base64url');
}

export function leerCursor(
  cursor: string | null | undefined
): EstadoImportacion {
  if (!cursor) return { ...INICIO, hechas: [] };
  try {
    const e = obj(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    );
    const enCurso = obj(e.enCurso);
    return {
      pagina: str(e.pagina),
      hechas: Array.isArray(e.hechas)
        ? e.hechas.filter((x): x is string => typeof x === 'string')
        : [],
      enCurso:
        str(enCurso.id) && str(enCurso.cursor)
          ? {
              id: str(enCurso.id)!,
              cursor: str(enCurso.cursor)!,
              creada: enCurso.creada === true,
            }
          : null,
      listas: typeof e.listas === 'number' && e.listas >= 0 ? e.listas : 0,
      // Un cursor de antes de la fase de contactos sigue en los chats.
      fase: e.fase === 'contactos' ? 'contactos' : 'chats',
      saltoContactos:
        typeof e.saltoContactos === 'number' &&
        Number.isInteger(e.saltoContactos) &&
        e.saltoContactos >= 0
          ? e.saltoContactos
          : 0,
    };
  } catch {
    throw new ErrorHistorial(
      'El punto de avance no es válido: empiece de nuevo.'
    );
  }
}

// ── El importador ───────────────────────────────────────────────────────

export interface OpcionesImportar {
  almacen: AlmacenWhatsApp;
  fuente: FuenteHistorial;
  cuentaId: string;
  cursor?: string | null;
  maxConversaciones?: number;
  presupuestoMs?: number;
  conversacionesPorPagina?: number;
  mensajesPorPagina?: number;
  contactosPorPagina?: number;
  /** Para las pruebas. */
  ahora?: () => number;
  esperar?: (ms: number) => Promise<void>;
}

export interface ResultadoTramo {
  /** Chats terminados en este tramo. */
  procesadas: number;
  /** Mensajes NUEVOS guardados en este tramo (los repetidos no cuentan). */
  mensajes: number;
  /** Chats terminados desde el principio (lo que lleva el cursor). */
  listas: number;
  /** Mensajes saltados: borrados, con fecha ilegible o posteriores a la conexión. */
  saltados: number;
  /** Contactos de la agenda leídos en este tramo. */
  contactosLeidos: number;
  /** Nombres de contactos completados en este tramo. */
  nombres: number;
  cursor: string | null;
  terminado: boolean;
  /** Si el proveedor pidió esperar: cuánto antes de la siguiente llamada. */
  esperarMs: number | null;
}

/** Del tipo de adjunto de Zernio al `content_type` de la fila. */
function tipoDe(adjunto: { tipo: string | null } | undefined): ContentType {
  if (!adjunto) return 'text';
  switch (adjunto.tipo) {
    case 'image':
    case 'sticker':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'document';
  }
}

const ESTADOS_SALIENTE = new Set(['sent', 'delivered', 'read', 'failed']);

function identidadDe(c: ConversacionRemota): IdentidadRemitente {
  const digitos = (c.participanteId ?? '').replace(/^\+/, '');
  const esTelefono = /^\d{6,15}$/.test(digitos);
  return {
    telefono: esTelefono ? digitos : '',
    waUserId: c.bsuid ?? (esTelefono ? null : c.participanteId),
    waParentUserId: null,
    waUsername: null,
    nombre: (c.participanteNombre ?? '').trim(),
  };
}

function filaDe(m: MensajeRemoto, conversacionId: string): MensajeNuevo {
  const adjunto = m.adjuntos[0];
  const tipo = tipoDe(adjunto);
  return {
    conversation_id: conversacionId,
    sender_type: m.saliente ? 'agent' : 'customer',
    sender_id: null,
    content_type: tipo,
    content_text: m.texto ?? (adjunto ? TEXTO_ADJUNTO : null),
    // Los adjuntos de Zernio piden la llave para bajarse: queda la marca.
    media_url: null,
    media_type: adjunto?.mime ?? null,
    message_id: m.id,
    status: m.saliente
      ? ESTADOS_SALIENTE.has(m.estadoEntrega ?? '')
        ? (m.estadoEntrega as MensajeNuevo['status'])
        : 'sent'
      : 'delivered',
    created_at: new Date(m.creadoEn).toISOString(),
    reply_to_message_id: null,
    // No es un eco de ahora: no debe mover el reloj del bot.
    desde_celular: false,
  };
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function importarHistorial(
  o: OpcionesImportar
): Promise<ResultadoTramo> {
  const ahora = o.ahora ?? Date.now;
  const esperar = o.esperar ?? dormir;
  const inicio = ahora();
  const presupuesto = o.presupuestoMs ?? PRESUPUESTO_MS;
  const maxConv = o.maxConversaciones ?? MAX_CONVERSACIONES_POR_TRAMO;
  const porPagina = o.conversacionesPorPagina ?? CONVERSACIONES_POR_PAGINA;
  const msjPorPagina = o.mensajesPorPagina ?? MENSAJES_POR_PAGINA;
  const contactosPorPagina = o.contactosPorPagina ?? CONTACTOS_POR_PAGINA;
  const queda = () => presupuesto - (ahora() - inicio);

  const estado = leerCursor(o.cursor);
  const inq = await o.almacen.resolverInquilino();
  // Sin fecha de conexión no se puede separar la historia de lo vivo.
  const conexion = inq.conectadoDesde ? Date.parse(inq.conectadoDesde) : NaN;
  if (!Number.isFinite(conexion)) throw new SinFechaDeConexion();
  const r: ResultadoTramo = {
    procesadas: 0,
    mensajes: 0,
    listas: estado.listas,
    saltados: 0,
    contactosLeidos: 0,
    nombres: 0,
    cursor: null,
    terminado: false,
    esperarMs: null,
  };

  /** Pide al proveedor; ante un 429 espera si cabe en el tramo, si no corta. */
  async function pedir<T>(fn: () => Promise<T>): Promise<T | 'cortar'> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof LimiteDeVelocidad)) throw err;
        if (err.esperaMs + 2_000 > queda()) {
          r.esperarMs = err.esperaMs;
          return 'cortar';
        }
        await esperar(err.esperaMs);
      }
    }
  }

  const cortar = () => {
    r.listas = estado.listas;
    r.cursor = codificarCursor(estado);
    return r;
  };

  if (estado.fase === 'contactos') return faseContactos();

  for (;;) {
    if (queda() <= 0) return cortar();
    const pagina = await pedir(() =>
      o.fuente.conversaciones(o.cuentaId, estado.pagina, porPagina)
    );
    if (pagina === 'cortar') return cortar();

    for (const conv of pagina.items) {
      if (estado.hechas.includes(conv.id)) continue;
      if (r.procesadas >= maxConv || queda() <= 0) return cortar();

      const terminada = await importarConversacion(conv);
      if (terminada === 'cortar') return cortar();
      estado.hechas.push(conv.id);
      estado.enCurso = null;
      estado.listas++;
      r.procesadas++;
    }

    if (!pagina.siguiente) {
      // Terminados los chats, la agenda: así los contactos que acaban de
      // crearse también reciben su nombre.
      estado.fase = 'contactos';
      estado.pagina = null;
      estado.hechas = [];
      estado.enCurso = null;
      estado.saltoContactos = 0;
      return faseContactos();
    }
    estado.pagina = pagina.siguiente;
    estado.hechas = [];
  }

  /** La agenda: nombres para los contactos que ya existen. Nunca crea uno. */
  async function faseContactos(): Promise<ResultadoTramo> {
    for (;;) {
      if (queda() <= 0) return cortar();
      const pagina = await pedir(() =>
        o.fuente.contactos(o.cuentaId, estado.saltoContactos, contactosPorPagina)
      );
      if (pagina === 'cortar') return cortar();
      r.contactosLeidos += pagina.items.length;
      const pares = pagina.items.flatMap((c) => {
        const nombre = nombreUtil(c.nombre);
        return c.telefono && nombre ? [{ telefono: c.telefono, nombre }] : [];
      });
      if (pares.length > 0)
        r.nombres += await o.almacen.completarNombres(inq, pares);
      if (pagina.siguiente === null) {
        r.listas = estado.listas;
        r.terminado = true;
        return r;
      }
      estado.saltoContactos = pagina.siguiente;
    }
  }

  /** `'cortar'` si se acabó el tramo a mitad (queda en `estado.enCurso`). */
  async function importarConversacion(
    conv: ConversacionRemota
  ): Promise<'listo' | 'cortar'> {
    if (conv.plataforma && conv.plataforma !== 'whatsapp') return 'listo';
    // El chat se busca o se crea recién con el primer mensaje importable: un
    // chat sin historia no se crea, y uno que ya existía no se toca.
    let conversacionId: string | null = null;
    let sinIdentidad = false;
    const retomado = estado.enCurso?.id === conv.id ? estado.enCurso : null;
    // ¿Lo creó la historia? Solo entonces se le ajustan las fechas.
    let creada = retomado?.creada === true;

    let cursor = retomado?.cursor ?? null;
    const guardarAvance = () => {
      if (cursor) estado.enCurso = { id: conv.id, cursor, creada };
    };
    for (;;) {
      if (queda() <= 0) {
        guardarAvance();
        return 'cortar';
      }
      const pagina = await pedir(() =>
        o.fuente.mensajes(o.cuentaId, conv.id, cursor, msjPorPagina)
      );
      if (pagina === 'cortar') {
        guardarAvance();
        return 'cortar';
      }

      const importables = pagina.items.filter((m) => {
        const cuando = Date.parse(m.creadoEn);
        // Borrado o con fecha ilegible: se salta y se cuenta.
        if (m.borrado || !Number.isFinite(cuando)) {
          r.saltados++;
          return false;
        }
        // Solo lo ESTRICTAMENTE anterior a la conexión: lo de después es del
        // webhook, que es el único que despierta al bot y suma no leídos.
        if (cuando >= conexion) {
          r.saltados++;
          return false;
        }
        return true;
      });

      // Las fechas reales de esta página: de su primer y su último mensaje.
      const fechas = importables
        .map((m) => new Date(m.creadoEn).toISOString())
        .sort();
      const desde = fechas[0];
      const hasta = fechas[fechas.length - 1];

      let recienCreada = false;
      if (importables.length > 0 && !conversacionId && !sinIdentidad) {
        const chat = await chatDeMensaje(
          o.almacen,
          inq,
          identidadDe(conv),
          { conversacionId: conv.id, cuentaId: conv.cuentaId ?? o.cuentaId },
          // Si lo crea la historia, nace cerrado (no queda «esperando
          // respuesta») y en sus fechas reales: así no infla el tablero el día
          // de la importación ni el de la conexión.
          { creadaEn: desde, cerradaEn: hasta }
        );
        if (!chat) {
          console.warn(
            `[historial] chat ${conv.id} sin teléfono ni BSUID: se salta`
          );
          sinIdentidad = true;
        } else {
          conversacionId = chat.conversacion.id;
          recienCreada = chat.conversacionCreada;
          creada ||= chat.conversacionCreada;
        }
      }
      // Una página siguiente de un chat que creó la historia corre sus fechas.
      if (conversacionId && creada && !recienCreada && importables.length > 0)
        await o.almacen.ajustarFechasHistoria(conversacionId, desde, hasta);

      if (conversacionId && importables.length > 0) {
        const filas = importables.map((m) => filaDe(m, conversacionId!));
        r.mensajes += await o.almacen.insertarMensajesSiNuevos(filas);
        let ultimo = filas[0];
        let primerEntrante: string | null = null;
        for (const f of filas) {
          if (Date.parse(f.created_at) >= Date.parse(ultimo.created_at))
            ultimo = f;
          if (
            f.sender_type === 'customer' &&
            (!primerEntrante ||
              Date.parse(f.created_at) < Date.parse(primerEntrante))
          )
            primerEntrante = f.created_at;
        }
        await o.almacen.registrarHistoria(conversacionId, {
          resumen: resumen(ultimo.content_text, ultimo.content_type),
          ultimoEn: ultimo.created_at,
          primerEntranteEn: primerEntrante,
        });
      }

      if (!pagina.siguiente) return 'listo';
      cursor = pagina.siguiente;
    }
  }
}
