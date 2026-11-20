/**
 * El Realtime de la demostración: un WebSocket de mentira que nunca abre una
 * conexión. Habla el protocolo de Phoenix (mensajes en arreglo, vsn 2.0.0) lo
 * justo para que los canales de la app queden suscritos, y les reenvía los
 * cambios que hace `backend.ts`. Así la bandeja se entera de una respuesta o
 * de una asignación igual que con la base de verdad.
 */
import { escucharCambios } from './backend'

type Mensaje = [string | null, string | null, string, string, Record<string, unknown>]

interface Filtro {
  event: string
  schema?: string
  table?: string
  filter?: string
}

let siguienteId = 1

export class WebSocketMuestra {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = 0
  binaryType = 'arraybuffer'
  protocol = ''
  url: string
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  /** topic → [joinRef, filtros con su id de servidor] */
  private canales = new Map<string, { joinRef: string | null; filtros: (Filtro & { id: number })[] }>()
  private soltar: () => void

  constructor(url: string) {
    this.url = url
    this.soltar = escucharCambios((tabla, tipo, fila, antes) => this.cambio(tabla, tipo, fila, antes))
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }

  addEventListener() {}
  removeEventListener() {}

  private enviar(m: Mensaje) {
    if (this.readyState !== 1) return
    const data = JSON.stringify(m)
    setTimeout(() => this.onmessage?.({ data }), 0)
  }

  send(raw: string) {
    let m: Mensaje
    try {
      const p = JSON.parse(raw)
      m = (Array.isArray(p) ? p : [p.join_ref, p.ref, p.topic, p.event, p.payload]) as Mensaje
    } catch {
      return
    }
    const [joinRef, ref, topic, event, payload] = m
    if (event === 'phx_join') {
      const config = (payload?.config ?? {}) as { postgres_changes?: Filtro[] }
      const filtros = (config.postgres_changes ?? []).map((f) => ({ ...f, id: siguienteId++ }))
      this.canales.set(topic, { joinRef, filtros })
      this.enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: filtros } }])
      return
    }
    if (event === 'phx_leave') this.canales.delete(topic)
    // heartbeat, access_token, presence, phx_leave: todo «ok».
    this.enviar([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }])
  }

  private cambio(tabla: string, tipo: 'INSERT' | 'UPDATE' | 'DELETE', fila: Record<string, unknown>, antes: Record<string, unknown>) {
    for (const [topic, canal] of this.canales) {
      const ids = canal.filtros
        .filter((f) => (f.table === undefined || f.table === tabla) && (f.event === '*' || f.event === tipo))
        .filter((f) => {
          if (!f.filter) return true
          const [col, expr] = f.filter.split('=')
          const valor = expr?.replace(/^eq\./, '')
          return String((tipo === 'DELETE' ? antes : fila)[col]) === valor
        })
        .map((f) => f.id)
      if (ids.length === 0) continue
      this.enviar([
        null,
        null,
        topic,
        'postgres_changes',
        {
          ids,
          data: {
            schema: 'public',
            table: tabla,
            commit_timestamp: new Date().toISOString(),
            type: tipo,
            columns: [],
            record: tipo === 'DELETE' ? {} : { ...fila },
            old_record: { ...antes },
            errors: null,
          },
        },
      ])
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.soltar()
    this.canales.clear()
    setTimeout(() => this.onclose?.({ code, reason, wasClean: true }), 0)
  }
}
