// ============================================================
// Adaptador de Zernio (https://docs.zernio.com).
//
// Basado en el adaptador `agent/providers/zernio.py` del kit
// whatsapp-agentkit (MIT, © 2026 Enrique Rocha), traducido a TypeScript y
// cambiado donde ECOVIT pide otra cosa: sin secreto se RECHAZA todo (el kit lo
// aceptaba), varios secretos para rotar, la cuenta se lee de `account.accountId`
// (la documentación dice que `account.id` es solo por compatibilidad), y ante un
// 5xx o un tiempo agotado el envío NO se da por fallido: queda dudoso.
//
// Todo lo que este archivo afirma de Zernio sale de su documentación (webhooks,
// inbox, send-inbox-message, templates, phone-numbers). Lo que no está ahí va
// marcado «sin verificar en la documentación».
// ============================================================

import { leerSecretos, verificarFirmaHmac } from './firma'
import {
  ErrorConfiguracion,
  ErrorProveedor,
  leerEncabezado,
  type AdjuntoEntrante,
  type ArchivoBajado,
  type DestinoEnvio,
  type Encabezados,
  type EnvioMedia,
  type Entorno,
  type EnvioPlantilla,
  type EstadoConexion,
  type EstadoMensaje,
  type EventoWhatsApp,
  type IdentidadRemitente,
  type OpcionesEnvio,
  type OrigenEnvio,
  type ProveedorWhatsApp,
  type ReferenciaConversacion,
  type ResultadoEnvio,
  type TipoAdjunto,
} from './tipos'

export const ZERNIO_URL_BASE = 'https://zernio.com/api/v1'

/** El tope del bucket `chat-media` (16 MB). Un adjunto más grande no se baja. */
export const ADJUNTO_MAX_BYTES = 16 * 1024 * 1024

export interface ConfigZernio {
  apiKey: string
  /** Uno o varios secretos de firma (`ZERNIO_WEBHOOK_SECRET`, separados por coma). */
  secretos: string[]
  /** `ZERNIO_ACCOUNT_ID`: la cuenta de WhatsApp conectada. */
  cuentaId: string
  baseUrl?: string
  /** Inyectable para las pruebas. */
  fetch?: typeof fetch
  /** Tiempo máximo por llamada. Pasado, el envío queda dudoso. */
  timeoutMs?: number
}

/** Lee la configuración del entorno. Solo en el servidor: la llave nunca llega al navegador. */
export function configZernioDesdeEntorno(env: Entorno = process.env): ConfigZernio {
  return {
    apiKey: (env.ZERNIO_API_KEY ?? '').trim(),
    secretos: leerSecretos(env.ZERNIO_WEBHOOK_SECRET),
    cuentaId: (env.ZERNIO_ACCOUNT_ID ?? '').trim(),
    baseUrl: (env.ZERNIO_BASE_URL ?? '').trim() || ZERNIO_URL_BASE,
  }
}

// ── Lectura del webhook ─────────────────────────────────────────────────

type Obj = Record<string, unknown>

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

const SOLO_DIGITOS = /^\d{6,15}$/

/**
 * La identidad de quien escribe. `phoneNumber` viene en E.164 con «+» y puede
 * faltar o ser nulo desde la llegada de los nombres de usuario (abril de 2026):
 * entonces se usa `businessScopedUserId`. `sender.id` es el teléfono sin «+»
 * «when available», si no el BSUID; por eso solo se toma como teléfono si son
 * solo dígitos.
 */
export function identidadDeRemitente(sender: Obj): IdentidadRemitente {
  const deTelefono = (str(sender.phoneNumber) ?? '').replace(/\D/g, '')
  const id = str(sender.id) ?? ''
  const telefono = deTelefono || (SOLO_DIGITOS.test(id) ? id : '')
  return {
    telefono,
    waUserId: str(sender.businessScopedUserId),
    waParentUserId: str(sender.parentBusinessScopedUserId),
    waUsername: str(sender.whatsappUsername),
    nombre: (str(sender.name) ?? '').trim(),
  }
}

/**
 * La otra parte en un `message.sent`: ahí `sender` es el propio negocio, y la
 * documentación pide leer `conversation.participantId` / `participantName` /
 * `participantUsername`. Si `participantId` es un BSUID y no dígitos, queda como
 * BSUID (sin verificar en la documentación cuál de los dos trae para usuarios
 * sin teléfono).
 */
function identidadDeParticipante(conversation: Obj): IdentidadRemitente {
  const participante = str(conversation.participantId) ?? ''
  const digitos = participante.replace(/^\+/, '')
  const esTelefono = SOLO_DIGITOS.test(digitos)
  return {
    telefono: esTelefono ? digitos : '',
    waUserId: esTelefono ? null : participante || null,
    waParentUserId: null,
    waUsername: str(conversation.participantUsername),
    nombre: (str(conversation.participantName) ?? '').trim(),
  }
}

function tipoAdjunto(tipo: string | null): TipoAdjunto {
  switch (tipo) {
    case 'image':
    case 'video':
    case 'audio':
    case 'sticker':
      return tipo
    case 'file':
      return 'document'
    default:
      return 'otro'
  }
}

function adjuntos(lista: unknown): AdjuntoEntrante[] {
  if (!Array.isArray(lista)) return []
  const salida: AdjuntoEntrante[] = []
  lista.forEach((crudo, indice) => {
    const a = obj(crudo)
    const url = str(a.url)
    if (!url) return
    salida.push({ tipo: tipoAdjunto(str(a.type)), url, mime: str(a.mimeType), indice })
  })
  return salida
}

function referencia(mensaje: Obj, cuenta: Obj): ReferenciaConversacion {
  return {
    conversacionId: str(mensaje.conversationId),
    // `account.id` repite `account.accountId` «for compatibility».
    cuentaId: str(cuenta.accountId) ?? str(cuenta.id),
  }
}

function origenDe(source: string | null): OrigenEnvio {
  if (source === 'whatsapp_business_app') return 'celular'
  if (source === 'cloud_api') return 'api'
  if (source === 'meta_business_agent') return 'agente_meta'
  return 'desconocido'
}

const ESTADOS: Record<string, EstadoMensaje> = {
  'message.delivered': 'delivered',
  'message.read': 'read',
  // Un audio reproducido ya fue leído; el orden de estados impide que retroceda.
  'message.played': 'read',
  'message.failed': 'failed',
}

function numeroOnull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10)
  return null
}

/**
 * Normaliza un evento de Zernio. Lo que no es WhatsApp o no se usa sale como
 * `ignorado` (se contesta 200 igual: un 4xx haría que Zernio lo mande a la cola
 * de muertos, y un 5xx lo reintentaría siete veces sin razón).
 */
export function leerWebhookZernio(json: unknown): EventoWhatsApp[] {
  const sobre = obj(json)
  const eventoId = str(sobre.id) ?? ''
  const nombre = str(sobre.event) ?? ''
  const base = {
    eventoId,
    generadoEn: str(sobre.timestamp),
    prueba: sobre.test === true,
  }
  const mensaje = obj(sobre.message)
  const cuenta = obj(sobre.account)
  const metadata = obj(sobre.metadata)

  if (nombre === 'webhook.test') {
    return [{ ...base, prueba: true, tipo: 'prueba', mensaje: str(sobre.message) }]
  }

  if (nombre === 'account.disconnected') {
    return [
      {
        ...base,
        tipo: 'cuenta_desconectada',
        cuentaId: str(cuenta.accountId) ?? str(cuenta.id),
        // TODO(zernio): el motivo («Meta's own reason») no tiene campo nombrado en
        // las páginas leídas — sin verificar en la documentación. Se guarda nulo.
        motivo: null,
      },
    ]
  }

  const esWhatsApp = str(mensaje.platform) === 'whatsapp'

  if (nombre === 'message.received' && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId)
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }]
    return [
      {
        ...base,
        tipo: 'mensaje_entrante',
        mensajeId,
        referencia: referencia(mensaje, cuenta),
        remitente: identidadDeRemitente(obj(mensaje.sender)),
        texto: str(mensaje.text),
        adjuntos: adjuntos(mensaje.attachments),
        enviadoEn: str(mensaje.sentAt) ?? base.generadoEn ?? new Date().toISOString(),
        enEspera: metadata.standby === true,
        // TODO(zernio): `coexistence_history` está documentado como `metadata.source`
        // en la lectura REST de mensajes; que llegue igual en el webhook está sin
        // verificar en la documentación. La regla de la fecha de conexión cubre el resto.
        esHistoria: str(metadata.source) === 'coexistence_history',
        // TODO(zernio): el nombre del campo de la cita en `message.received` está sin
        // verificar en la documentación; `quotedMessageId` es el de `message.sent`.
        citaA: str(metadata.quotedMessageId),
      },
    ]
  }

  if (nombre === 'message.sent' && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId)
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }]
    const source = str(mensaje.source)
    return [
      {
        ...base,
        tipo: 'mensaje_enviado',
        mensajeId,
        referencia: referencia(mensaje, cuenta),
        destinatario: identidadDeParticipante(obj(sobre.conversation)),
        texto: str(mensaje.text),
        adjuntos: adjuntos(mensaje.attachments),
        enviadoEn: str(mensaje.sentAt) ?? base.generadoEn ?? new Date().toISOString(),
        origen: origenDe(source),
        origenCrudo: source,
      },
    ]
  }

  if (nombre in ESTADOS && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId)
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }]
    const estado = ESTADOS[nombre]
    const error = obj(sobre.error)
    return [
      {
        ...base,
        tipo: 'estado',
        mensajeId,
        estado,
        ocurridoEn: str(sobre.statusAt),
        error:
          estado === 'failed'
            ? {
                codigo: numeroOnull(error.code),
                titulo: str(error.title) ?? str(error.message) ?? 'Falló el envío',
                detalle: str(error.message),
              }
            : null,
      },
    ]
  }

  return [{ ...base, tipo: 'ignorado', nombre: nombre || '(sin nombre)' }]
}

// ── El adaptador ────────────────────────────────────────────────────────

function digitos(telefono: string | null): string | null {
  const d = (telefono ?? '').replace(/\D/g, '')
  return d || null
}

export class ProveedorZernio implements ProveedorWhatsApp {
  readonly nombre = 'zernio' as const
  private readonly config: Required<Omit<ConfigZernio, 'fetch'>> & { fetch: typeof fetch }

  constructor(config: ConfigZernio) {
    this.config = {
      apiKey: config.apiKey,
      secretos: config.secretos,
      cuentaId: config.cuentaId,
      baseUrl: (config.baseUrl || ZERNIO_URL_BASE).replace(/\/+$/, ''),
      fetch: config.fetch ?? ((...args) => fetch(...args)),
      timeoutMs: config.timeoutMs ?? 15_000,
    }
  }

  verificarFirma(cuerpoCrudo: string, encabezados: Encabezados): boolean {
    // `X-Late-Signature` lleva el mismo valor; el código nuevo lee `X-Zernio-*`.
    const firma = leerEncabezado(encabezados, 'x-zernio-signature')
    return verificarFirmaHmac(cuerpoCrudo, firma, this.config.secretos)
  }

  leerWebhook(json: unknown): EventoWhatsApp[] {
    return leerWebhookZernio(json)
  }

  private exigirLlave(): void {
    if (!this.config.apiKey) throw new ErrorConfiguracion('Falta ZERNIO_API_KEY en el entorno del servidor.')
  }

  private cuentaDe(ref: ReferenciaConversacion): string {
    const cuenta = ref.cuentaId || this.config.cuentaId
    if (!cuenta) throw new ErrorConfiguracion('Falta ZERNIO_ACCOUNT_ID en el entorno del servidor.')
    return cuenta
  }

  /**
   * Una llamada a Zernio. Un 5xx, un 408, un 409 (la misma clave todavía en
   * vuelo), un tiempo agotado o la red caída quedan DUDOSOS: pudo haber salido.
   */
  private async llamar(
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo?: unknown,
    idempotencia?: string,
  ): Promise<Obj> {
    this.exigirLlave()
    const encabezados: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` }
    if (cuerpo !== undefined) encabezados['Content-Type'] = 'application/json'
    if (idempotencia) encabezados['Idempotency-Key'] = idempotencia

    let respuesta: Response
    try {
      respuesta = await this.config.fetch(`${this.config.baseUrl}${ruta}`, {
        method: metodo,
        headers: encabezados,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err)
      throw new ErrorProveedor(`No hubo respuesta de Zernio: ${motivo}`, { dudoso: true })
    }

    const texto = await respuesta.text().catch(() => '')
    let json: Obj = {}
    try {
      json = obj(JSON.parse(texto))
    } catch {
      json = {}
    }

    if (respuesta.ok) return json

    const estado = respuesta.status
    const dudoso = estado >= 500 || estado === 408 || estado === 409
    // Zernio responde { error, type, code }: los tres ahorran tiempo de diagnóstico.
    const detalle = str(json.error) ?? texto.slice(0, 300) ?? ''
    const codigo = str(json.code)
    throw new ErrorProveedor(
      `Zernio respondió ${estado}${codigo ? ` (${codigo})` : ''}: ${detalle}`,
      { dudoso, estadoHttp: estado, codigo },
    )
  }

  private resultado(json: Obj, ref: ReferenciaConversacion | null): ResultadoEnvio {
    const data = obj(json.data)
    const mensajeId = str(data.messageId)
    if (!mensajeId) {
      // 2xx sin id: salió, pero no hay con qué seguirlo. Lo resuelve el evento.
      throw new ErrorProveedor('Zernio aceptó el envío pero no devolvió messageId.', { dudoso: true })
    }
    const conversacionId = str(data.conversationId) ?? ref?.conversacionId ?? null
    return {
      mensajeId,
      referencia: conversacionId ? { conversacionId, cuentaId: ref?.cuentaId ?? this.config.cuentaId } : ref,
    }
  }

  private conversacionDe(destino: DestinoEnvio): { id: string; cuenta: string } {
    const id = destino.referencia.conversacionId
    if (!id) {
      throw new ErrorProveedor(
        'Este chat no tiene la conversación de Zernio guardada: no se puede contestar en él. ' +
          'Fuera de una conversación abierta solo se puede escribir con una plantilla.',
        { dudoso: false, codigo: 'sin_conversacion_proveedor' },
      )
    }
    return { id, cuenta: this.cuentaDe(destino.referencia) }
  }

  async enviarTexto(destino: DestinoEnvio, texto: string, opciones: OpcionesEnvio): Promise<ResultadoEnvio> {
    const conv = this.conversacionDe(destino)
    const cuerpo: Obj = { accountId: conv.cuenta, message: texto }
    if (opciones.responderA) cuerpo.replyTo = opciones.responderA
    const json = await this.llamar(
      'POST',
      `/inbox/conversations/${encodeURIComponent(conv.id)}/messages`,
      cuerpo,
      opciones.idempotencia,
    )
    return this.resultado(json, { conversacionId: conv.id, cuentaId: conv.cuenta })
  }

  async enviarMedia(destino: DestinoEnvio, media: EnvioMedia, opciones: OpcionesEnvio): Promise<ResultadoEnvio> {
    const conv = this.conversacionDe(destino)
    const cuerpo: Obj = {
      accountId: conv.cuenta,
      attachmentUrl: media.url,
      // Zernio: image, video, audio o file.
      attachmentType: media.tipo === 'document' ? 'file' : media.tipo,
    }
    if (media.texto) cuerpo.message = media.texto
    if (media.tipo === 'document' && media.nombreArchivo) cuerpo.attachmentName = media.nombreArchivo
    if (opciones.responderA) cuerpo.replyTo = opciones.responderA
    const json = await this.llamar(
      'POST',
      `/inbox/conversations/${encodeURIComponent(conv.id)}/messages`,
      cuerpo,
      opciones.idempotencia,
    )
    return this.resultado(json, { conversacionId: conv.id, cuentaId: conv.cuenta })
  }

  /**
   * Con conversación: `template.elements` dentro de ella. Sin conversación (abrir
   * un chat nuevo): `POST /inbox/conversations` con el teléfono en `participantId`
   * (solo dígitos, con indicativo, sin «+»).
   */
  async enviarPlantilla(
    destino: DestinoEnvio,
    plantilla: EnvioPlantilla,
    opciones: OpcionesEnvio,
  ): Promise<ResultadoEnvio> {
    const cuenta = this.cuentaDe(destino.referencia)
    if (destino.referencia.conversacionId) {
      const componentes =
        plantilla.componentes ??
        (plantilla.parametros.length > 0
          ? [{ type: 'body', parameters: plantilla.parametros.map((text) => ({ type: 'text', text })) }]
          : undefined)
      const elemento: Obj = { name: plantilla.nombre, language: plantilla.idioma }
      if (componentes) elemento.components = componentes
      const json = await this.llamar(
        'POST',
        `/inbox/conversations/${encodeURIComponent(destino.referencia.conversacionId)}/messages`,
        { accountId: cuenta, template: { elements: [elemento] } },
        opciones.idempotencia,
      )
      return this.resultado(json, { conversacionId: destino.referencia.conversacionId, cuentaId: cuenta })
    }

    const participante = digitos(destino.telefono)
    if (!participante) {
      throw new ErrorProveedor('Para abrir una conversación con plantilla hace falta el teléfono del cliente.', {
        dudoso: false,
        codigo: 'sin_telefono',
      })
    }
    const json = await this.llamar(
      'POST',
      '/inbox/conversations',
      {
        accountId: cuenta,
        participantId: participante,
        templateName: plantilla.nombre,
        templateLanguage: plantilla.idioma,
        templateParams: plantilla.parametros,
      },
      opciones.idempotencia,
    )
    return this.resultado(json, { conversacionId: null, cuentaId: cuenta })
  }

  /**
   * `GET /whatsapp/number-info?accountId=` es «the supported way to check whether
   * a WhatsApp channel is alive». Un 400 (error 100/33 de Meta) = muerto hasta
   * reconectar.
   */
  async verificarConexion(): Promise<EstadoConexion> {
    const vacio = { numero: null, nombre: null, calidad: null }
    if (!this.config.apiKey) return { conectado: false, detalle: 'Falta ZERNIO_API_KEY en el servidor.', ...vacio }
    if (!this.config.cuentaId) {
      return { conectado: false, detalle: 'Falta ZERNIO_ACCOUNT_ID en el servidor.', ...vacio }
    }
    try {
      const json = await this.llamar('GET', `/whatsapp/number-info?accountId=${encodeURIComponent(this.config.cuentaId)}`)
      const tel = obj(json.phone)
      return {
        conectado: true,
        detalle: 'Zernio lee el número en Meta: el canal está vivo.',
        numero: str(tel.display_phone_number),
        nombre: str(tel.verified_name),
        calidad: str(tel.quality_rating),
      }
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err)
      return { conectado: false, detalle: motivo, ...vacio }
    }
  }

  /**
   * En WhatsApp, la URL del adjunto entrante apunta a `GET /v1/whatsapp/media/{id}`
   * y pide `Authorization: Bearer`. La llave SOLO se manda a la URL de Zernio: un
   * adjunto que apunte a otro lado no se baja con ella (la llave no sale de casa).
   */
  async descargarAdjunto(adjunto: AdjuntoEntrante): Promise<ArchivoBajado | null> {
    if (!this.config.apiKey) return null
    let destino: URL
    try {
      destino = new URL(adjunto.url)
    } catch {
      return null
    }
    if (destino.origin !== new URL(this.config.baseUrl).origin) return null

    let respuesta: Response
    try {
      respuesta = await this.config.fetch(destino.toString(), {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch {
      return null
    }
    if (!respuesta.ok) return null
    const largo = Number(respuesta.headers.get('content-length') ?? '0')
    if (largo > ADJUNTO_MAX_BYTES) return null
    const bytes = new Uint8Array(await respuesta.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > ADJUNTO_MAX_BYTES) return null
    const mime = (respuesta.headers.get('content-type') ?? adjunto.mime ?? '').split(';')[0].trim() || null
    return { bytes, mime }
  }
}
