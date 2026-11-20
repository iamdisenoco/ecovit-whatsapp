// ============================================================
// La interfaz del proveedor de WhatsApp (RF-M03.8).
//
// El resto de la app —el webhook, la bandeja, el bot— habla solo con
// `ProveedorWhatsApp` y con los eventos normalizados de este archivo. No
// sabe si detrás está Zernio, Meta directo o el simulado: eso lo decide
// `WHATSAPP_PROVEEDOR` en `./index.ts`.
// ============================================================

export type NombreProveedor = 'zernio' | 'simulado' | 'meta'

/** Las variables de entorno (o un objeto de prueba con las mismas llaves). */
export type Entorno = Record<string, string | undefined>

/** Encabezados de la petición, en minúsculas o como vengan. */
export type Encabezados = Headers | Record<string, string | null | undefined>

export type TipoAdjunto = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'otro'

export interface AdjuntoEntrante {
  tipo: TipoAdjunto
  /** Dónde se baja. En Zernio/WhatsApp pide la llave del proveedor. */
  url: string
  mime: string | null
  /** Posición en el arreglo original (sirve para nombrar el archivo). */
  indice: number
}

/** Cómo se identifica a la persona del otro lado. */
export interface IdentidadRemitente {
  /** Solo dígitos, sin «+», o '' cuando WhatsApp no lo da (usuarios con nombre de usuario). */
  telefono: string
  /** BSUID de Meta, cuando viene. */
  waUserId: string | null
  waParentUserId: string | null
  waUsername: string | null
  nombre: string
}

/** Lo que se necesita para contestar en la misma conversación del proveedor. */
export interface ReferenciaConversacion {
  /** Id de la conversación en el proveedor (Zernio: `conversationId`). */
  conversacionId: string | null
  /** Id de la cuenta conectada en el proveedor (Zernio: `accountId`). */
  cuentaId: string | null
}

interface EventoBase {
  /** Id del evento (Zernio: `id`, igual en cada reintento). Clave de deduplicación. */
  eventoId: string
  /** Cuándo lo generó el proveedor (ISO). */
  generadoEn: string | null
  /** Solo en los eventos de muestra de `POST /v1/webhooks/test`. */
  prueba: boolean
}

export interface EventoMensajeEntrante extends EventoBase {
  tipo: 'mensaje_entrante'
  /** Id del mensaje en WhatsApp (wamid). Segunda clave de deduplicación. */
  mensajeId: string
  referencia: ReferenciaConversacion
  remitente: IdentidadRemitente
  texto: string | null
  adjuntos: AdjuntoEntrante[]
  /** Cuándo lo mandó el cliente, según la plataforma (ISO). */
  enviadoEn: string
  /** Otra app (p. ej. Meta Business Agent) tiene el chat: el bot no contesta. */
  enEspera: boolean
  /** Historia traída al conectar en coexistencia: no despierta al bot. */
  esHistoria: boolean
  /** Id del mensaje citado, si es una respuesta citada. */
  citaA: string | null
}

/**
 * De dónde salió un mensaje enviado. `celular` es la app WhatsApp Business del
 * número en coexistencia (RF-M03.10): un vendedor contestando desde el teléfono.
 */
export type OrigenEnvio = 'api' | 'celular' | 'agente_meta' | 'desconocido'

export interface EventoMensajeEnviado extends EventoBase {
  tipo: 'mensaje_enviado'
  mensajeId: string
  referencia: ReferenciaConversacion
  /** La otra parte de la conversación (el cliente), no el negocio. */
  destinatario: IdentidadRemitente
  texto: string | null
  adjuntos: AdjuntoEntrante[]
  enviadoEn: string
  origen: OrigenEnvio
  /** El valor crudo del proveedor (`source` en Zernio), para el registro. */
  origenCrudo: string | null
}

export type EstadoMensaje = 'sent' | 'delivered' | 'read' | 'failed'

export interface ErrorEstado {
  codigo: number | null
  titulo: string
  detalle: string | null
}

export interface EventoEstado extends EventoBase {
  tipo: 'estado'
  mensajeId: string
  estado: EstadoMensaje
  ocurridoEn: string | null
  error: ErrorEstado | null
}

export interface EventoCuentaDesconectada extends EventoBase {
  tipo: 'cuenta_desconectada'
  cuentaId: string | null
  motivo: string | null
}

export interface EventoPrueba extends EventoBase {
  tipo: 'prueba'
  mensaje: string | null
}

/** Un evento que la app no usa: se reconoce (200) y no se procesa. */
export interface EventoIgnorado extends EventoBase {
  tipo: 'ignorado'
  nombre: string
}

export type EventoWhatsApp =
  | EventoMensajeEntrante
  | EventoMensajeEnviado
  | EventoEstado
  | EventoCuentaDesconectada
  | EventoPrueba
  | EventoIgnorado

// ── Enviar ─────────────────────────────────────────────────────────────

export interface DestinoEnvio {
  referencia: ReferenciaConversacion
  /** Teléfono en dígitos (con indicativo) o BSUID; lo usa Meta y la plantilla que abre chat. */
  telefono: string | null
}

export interface OpcionesEnvio {
  /** Clave de idempotencia: el id de NUESTRO mensaje (`messages.id`). */
  idempotencia: string
  /** Id de plataforma del mensaje que se cita. */
  responderA?: string | null
}

export interface EnvioMedia {
  tipo: 'image' | 'video' | 'audio' | 'document'
  /** URL que el proveedor pueda bajar (en ECOVIT, un enlace firmado de Storage). */
  url: string
  texto?: string | null
  nombreArchivo?: string | null
}

export interface EnvioPlantilla {
  nombre: string
  idioma: string
  /** Variables en orden: cabecera de texto, cuerpo y botones dinámicos. */
  parametros: string[]
  /** Componentes ya armados al estilo de Meta (cuando hay cabecera con media, botones, etc.). */
  componentes?: unknown[]
}

export interface ResultadoEnvio {
  /** Id de plataforma (wamid) del mensaje enviado. */
  mensajeId: string
  /** La conversación del proveedor, cuando la devuelve (al abrir con plantilla). */
  referencia: ReferenciaConversacion | null
}

export interface EstadoConexion {
  conectado: boolean
  /** Texto para la persona, en español. */
  detalle: string
  /** Número visible, nombre verificado, calidad: lo que el proveedor dé. */
  numero: string | null
  nombre: string | null
  calidad: string | null
}

export interface ArchivoBajado {
  bytes: Uint8Array
  mime: string | null
}

/**
 * Error al hablar con el proveedor.
 *
 * `dudoso` = no se sabe si el mensaje salió (5xx, tiempo agotado, red caída). En
 * ese caso NO se reintenta: el mensaje queda pendiente y lo resuelve el evento
 * `message.sent` o `message.failed` (Zernio: «a blind retry could send it twice»).
 */
export class ErrorProveedor extends Error {
  readonly dudoso: boolean
  readonly estadoHttp: number | null
  readonly codigo: string | null

  constructor(
    mensaje: string,
    opciones: { dudoso: boolean; estadoHttp?: number | null; codigo?: string | null },
  ) {
    super(mensaje)
    this.name = 'ErrorProveedor'
    this.dudoso = opciones.dudoso
    this.estadoHttp = opciones.estadoHttp ?? null
    this.codigo = opciones.codigo ?? null
  }
}

/** Falta configuración (llave, secreto, cuenta): no es culpa del proveedor. */
export class ErrorConfiguracion extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = 'ErrorConfiguracion'
  }
}

export interface ProveedorWhatsApp {
  readonly nombre: NombreProveedor

  /** `true` solo si la firma del cuerpo crudo es válida. Sin secreto configurado, `false`. */
  verificarFirma(cuerpoCrudo: string, encabezados: Encabezados): boolean

  /** Normaliza un cuerpo ya verificado. No lanza por eventos desconocidos: los marca `ignorado`. */
  leerWebhook(json: unknown): EventoWhatsApp[]

  enviarTexto(destino: DestinoEnvio, texto: string, opciones: OpcionesEnvio): Promise<ResultadoEnvio>
  enviarMedia(destino: DestinoEnvio, media: EnvioMedia, opciones: OpcionesEnvio): Promise<ResultadoEnvio>
  enviarPlantilla(
    destino: DestinoEnvio,
    plantilla: EnvioPlantilla,
    opciones: OpcionesEnvio,
  ): Promise<ResultadoEnvio>

  verificarConexion(): Promise<EstadoConexion>

  /**
   * Baja un adjunto entrante. `null` si el proveedor no ofrece una descarga
   * segura para esa URL (se guarda como «recibido, sin descargar»).
   */
  descargarAdjunto(adjunto: AdjuntoEntrante): Promise<ArchivoBajado | null>
}

/** Lee un encabezado sin importar mayúsculas, venga en `Headers` o en un objeto. */
export function leerEncabezado(encabezados: Encabezados, nombre: string): string | null {
  if (typeof (encabezados as Headers).get === 'function') {
    return (encabezados as Headers).get(nombre)
  }
  const buscado = nombre.toLowerCase()
  for (const [clave, valor] of Object.entries(encabezados as Record<string, string | null | undefined>)) {
    if (clave.toLowerCase() === buscado) return valor ?? null
  }
  return null
}
