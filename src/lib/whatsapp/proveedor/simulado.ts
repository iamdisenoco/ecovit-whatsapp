// ============================================================
// Proveedor simulado: habla el MISMO formato que Zernio (eventos y firma) pero
// no llama a nadie. Sirve para probar la app de punta a punta sin cuenta ni
// llaves (`WHATSAPP_PROVEEDOR=simulado`), con `scripts/simular-zernio.mts`.
//
// - La firma se verifica igual que en Zernio, con `ZERNIO_WEBHOOK_SECRET`
//   (o `WHATSAPP_SIMULADO_SECRET` si se quiere uno aparte). Sin secreto,
//   se rechaza todo, igual que en producción.
// - Los envíos quedan en memoria (`enviados`) y devuelven un id `sim.<uuid>`.
//   Un texto que contenga «[falla-dudosa]» o «[falla]» simula un 5xx o un 4xx.
// ============================================================

import { randomUUID } from 'node:crypto'
import { leerSecretos, verificarFirmaHmac } from './firma'
import { leerWebhookZernio } from './zernio'
import {
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
  type EventoWhatsApp,
  type OpcionesEnvio,
  type ProveedorWhatsApp,
  type ResultadoEnvio,
} from './tipos'

export interface EnvioSimulado {
  clase: 'texto' | 'media' | 'plantilla'
  destino: DestinoEnvio
  contenido: unknown
  idempotencia: string
  mensajeId: string
}

/** PNG de 1×1: lo que «baja» el simulado para una imagen `simulado://`. */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

export class ProveedorSimulado implements ProveedorWhatsApp {
  readonly nombre = 'simulado' as const
  readonly enviados: EnvioSimulado[] = []
  private readonly secretos: string[]

  constructor(secretos: string[]) {
    this.secretos = secretos
  }

  static desdeEntorno(env: Entorno = process.env): ProveedorSimulado {
    return new ProveedorSimulado(
      leerSecretos(env.WHATSAPP_SIMULADO_SECRET || env.ZERNIO_WEBHOOK_SECRET),
    )
  }

  verificarFirma(cuerpoCrudo: string, encabezados: Encabezados): boolean {
    return verificarFirmaHmac(cuerpoCrudo, leerEncabezado(encabezados, 'x-zernio-signature'), this.secretos)
  }

  leerWebhook(json: unknown): EventoWhatsApp[] {
    return leerWebhookZernio(json)
  }

  private registrar(
    clase: EnvioSimulado['clase'],
    destino: DestinoEnvio,
    contenido: unknown,
    opciones: OpcionesEnvio,
    texto: string,
  ): ResultadoEnvio {
    if (texto.includes('[falla-dudosa]')) {
      throw new ErrorProveedor('Simulado: 503 de Zernio (no se sabe si salió).', { dudoso: true, estadoHttp: 503 })
    }
    if (texto.includes('[falla]')) {
      throw new ErrorProveedor('Simulado: 400 de Zernio.', { dudoso: false, estadoHttp: 400 })
    }
    // La misma clave devuelve el mismo envío, como el Idempotency-Key de Zernio.
    const previo = this.enviados.find((e) => e.idempotencia === opciones.idempotencia)
    if (previo) return { mensajeId: previo.mensajeId, referencia: destino.referencia }
    const mensajeId = `sim.${randomUUID()}`
    this.enviados.push({ clase, destino, contenido, idempotencia: opciones.idempotencia, mensajeId })
    const referencia = destino.referencia.conversacionId
      ? destino.referencia
      : { conversacionId: `sim-conv-${(destino.telefono ?? '').replace(/\D/g, '')}`, cuentaId: 'sim-cuenta' }
    return { mensajeId, referencia }
  }

  async enviarTexto(destino: DestinoEnvio, texto: string, opciones: OpcionesEnvio): Promise<ResultadoEnvio> {
    return this.registrar('texto', destino, texto, opciones, texto)
  }

  async enviarMedia(destino: DestinoEnvio, media: EnvioMedia, opciones: OpcionesEnvio): Promise<ResultadoEnvio> {
    return this.registrar('media', destino, media, opciones, media.texto ?? '')
  }

  async enviarPlantilla(
    destino: DestinoEnvio,
    plantilla: EnvioPlantilla,
    opciones: OpcionesEnvio,
  ): Promise<ResultadoEnvio> {
    return this.registrar('plantilla', destino, plantilla, opciones, plantilla.parametros.join(' '))
  }

  async verificarConexion(): Promise<EstadoConexion> {
    return {
      conectado: true,
      detalle: 'Proveedor simulado: no hay número real detrás. Nada sale a WhatsApp.',
      numero: '+57 300 000 0000',
      nombre: 'ECOVIT (simulado)',
      calidad: null,
    }
  }

  async descargarAdjunto(adjunto: AdjuntoEntrante): Promise<ArchivoBajado | null> {
    if (adjunto.url.startsWith('simulado://') && adjunto.tipo === 'image') {
      return { bytes: PNG_1X1, mime: 'image/png' }
    }
    return null
  }
}
