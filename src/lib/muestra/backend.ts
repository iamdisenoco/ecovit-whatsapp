/**
 * El servidor de mentira del modo muestra: contesta en el navegador, en
 * memoria, lo que la app le pediría a Supabase (PostgREST, funciones, Auth y
 * Realtime) y a sus propias rutas `/api`. Nada sale por la red: ni un pedido.
 *
 * Imita solo lo que las pantallas usan. Lo que no conoce lo contesta vacío
 * (y lo avisa en la consola con `[muestra]`), para que una pantalla que no
 * está pensada para la demostración se vea vacía en vez de rota.
 */
import { CONFIG_IA, USUARIO, YO, crearBase, nombreDe, usoIa, type Fila } from './datos'

type Base = Record<string, Fila[]>

let base: Base | null = null
function db(): Base {
  if (!base) base = crearBase()
  return base
}

/** Solo para las pruebas: vuelve a los datos de arranque. */
export function reiniciarBase() {
  base = null
}

const json = (cuerpo: unknown, status = 200, encabezados: Record<string, string> = {}) =>
  new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...encabezados },
  })

const errorPostgrest = (message: string, code = 'P0001', status = 400) =>
  json({ message, code, details: null, hint: null }, status)

const ahoraIso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Realtime: los cambios se avisan a los canales abiertos (ver `ws.ts`).
// ---------------------------------------------------------------------------
type Oyente = (tabla: string, tipo: 'INSERT' | 'UPDATE' | 'DELETE', fila: Fila, antes: Fila) => void
const oyentes = new Set<Oyente>()
export function escucharCambios(o: Oyente) {
  oyentes.add(o)
  return () => oyentes.delete(o)
}
function avisar(tabla: string, tipo: 'INSERT' | 'UPDATE' | 'DELETE', fila: Fila, antes: Fila = {}) {
  // Después de contestar el pedido, como llega de verdad.
  setTimeout(() => oyentes.forEach((o) => o(tabla, tipo, fila, antes)), 30)
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------
const RESERVADOS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function cumple(fila: Fila, columna: string, expr: string): boolean {
  const punto = expr.indexOf('.')
  let op = expr.slice(0, punto)
  let valor = expr.slice(punto + 1)
  let negado = false
  if (op === 'not') {
    negado = true
    const p2 = valor.indexOf('.')
    op = valor.slice(0, p2)
    valor = valor.slice(p2 + 1)
  }
  const v = fila[columna]
  const s = v === null || v === undefined ? null : String(v)
  let r: boolean
  switch (op) {
    case 'eq':
      r = s === valor
      break
    case 'neq':
      r = s !== valor
      break
    case 'in': {
      const lista = valor.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))
      r = s !== null && lista.includes(s)
      break
    }
    case 'is':
      r = valor === 'null' ? s === null : String(v) === valor
      break
    case 'gt':
      r = s !== null && s > valor
      break
    case 'gte':
      r = s !== null && s >= valor
      break
    case 'lt':
      r = s !== null && s < valor
      break
    case 'lte':
      r = s !== null && s <= valor
      break
    default:
      r = true // `or`, `ilike`, etc.: no filtran en la demostración
  }
  return negado ? !r : r
}

function filtrar(filas: Fila[], params: URLSearchParams): Fila[] {
  let out = filas
  params.forEach((expr, columna) => {
    if (RESERVADOS.has(columna) || columna === 'or' || columna === 'and') return
    out = out.filter((f) => cumple(f, columna, expr))
  })
  return out
}

function ordenar(filas: Fila[], orden: string | null): Fila[] {
  if (!orden) return filas
  const claves = orden.split(',').map((o) => {
    const [col, dir] = o.split('.')
    return { col, desc: dir === 'desc' }
  })
  return [...filas].sort((a, b) => {
    for (const { col, desc } of claves) {
      const x = String(a[col] ?? '')
      const y = String(b[col] ?? '')
      if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1)
    }
    return 0
  })
}

async function leerCuerpo(init?: RequestInit): Promise<unknown> {
  if (!init?.body || typeof init.body !== 'string') return null
  try {
    return JSON.parse(init.body)
  } catch {
    return null
  }
}

function encabezado(init: RequestInit | undefined, nombre: string): string {
  const h = new Headers(init?.headers)
  return h.get(nombre) ?? ''
}

async function rest(url: URL, init?: RequestInit): Promise<Response> {
  const tabla = url.pathname.replace(/^\/rest\/v1\//, '')
  if (tabla.startsWith('rpc/')) return rpc(tabla.slice(4), (await leerCuerpo(init)) as Fila | null)

  const metodo = (init?.method ?? 'GET').toUpperCase()
  const d = db()
  d[tabla] ??= []
  const params = url.searchParams
  const unaSola = encabezado(init, 'Accept').includes('vnd.pgrst.object')
  const prefer = encabezado(init, 'Prefer')
  const devolver = prefer.includes('return=representation')

  const responder = (filas: Fila[], status = 200) => {
    if (unaSola) {
      if (filas.length !== 1) {
        return errorPostgrest('JSON object requested, multiple (or no) rows returned', 'PGRST116', 406)
      }
      return json(filas[0], status)
    }
    return json(filas, status, { 'Content-Range': `0-${Math.max(filas.length - 1, 0)}/${filas.length}` })
  }

  if (metodo === 'GET' || metodo === 'HEAD') {
    let filas = ordenar(filtrar(d[tabla], params), params.get('order'))
    const total = filas.length
    const desde = Number(params.get('offset') ?? 0)
    const limite = params.get('limit')
    filas = filas.slice(desde, limite ? desde + Number(limite) : undefined)
    if (metodo === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Range': `0-${Math.max(total - 1, 0)}/${total}` } })
    }
    return responder(filas)
  }

  if (metodo === 'PATCH') {
    const cambios = ((await leerCuerpo(init)) ?? {}) as Fila
    const tocadas = filtrar(d[tabla], params)
    for (const f of tocadas) {
      const antes = { ...f }
      Object.assign(f, cambios)
      avisar(tabla, 'UPDATE', f, antes)
    }
    return devolver ? responder(tocadas) : new Response(null, { status: 204 })
  }

  if (metodo === 'POST') {
    const cuerpo = await leerCuerpo(init)
    const nuevas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo ?? {}]).map((f: Fila) => ({
      id: crypto.randomUUID(),
      created_at: ahoraIso(),
      ...f,
    }))
    d[tabla].push(...nuevas)
    nuevas.forEach((f) => avisar(tabla, 'INSERT', f))
    return devolver ? responder(nuevas, 201) : new Response(null, { status: 201 })
  }

  if (metodo === 'DELETE') {
    const borrar = new Set(filtrar(d[tabla], params))
    d[tabla] = d[tabla].filter((f) => !borrar.has(f))
    borrar.forEach((f) => avisar(tabla, 'DELETE', {}, f))
    return devolver ? responder([...borrar]) : new Response(null, { status: 204 })
  }

  return errorPostgrest(`Método ${metodo} no soportado en la demostración`)
}

function conversacion(id: unknown): Fila | undefined {
  return db().conversations.find((c) => c.id === id)
}

/** Cambia la conversación, mueve su marca y avisa por Realtime. */
function tocarConversacion(c: Fila, cambios: Fila): string {
  const antes = { ...c }
  const marca = ahoraIso()
  Object.assign(c, cambios, { actualizado_en: marca, updated_at: marca })
  avisar('conversations', 'UPDATE', c, antes)
  return marca
}

function rpc(fn: string, args: Fila | null): Response {
  const a = args ?? {}
  switch (fn) {
    case 'cliente_de_conversacion': {
      const clientes = db()._clientes[0] as Record<string, unknown>
      return json(clientes[String(a.p_conversacion)] ?? null)
    }
    case 'tomar_conversacion':
    case 'asignar_conversacion':
    case 'soltar_conversacion': {
      const c = conversacion(a.p_conversacion)
      if (!c) return errorPostgrest('No existe la conversación.', 'P0002', 404)
      if (a.p_visto !== c.actualizado_en) {
        const quien = nombreDe(c.assigned_agent_id as string) ?? 'nadie'
        return errorPostgrest(`Otra persona cambió este chat mientras lo mirabas. Ahora lo tiene ${quien}.`, '40001', 409)
      }
      let nuevo: string | null = null
      if (fn === 'tomar_conversacion') {
        if (c.assigned_agent_id) return errorPostgrest(`Este chat ya lo tiene ${nombreDe(c.assigned_agent_id as string)}.`)
        nuevo = YO
      } else if (fn === 'asignar_conversacion') {
        const perfil = db().profiles.find((p) => p.perfil_id === a.p_agente)
        if (!perfil) return errorPostgrest('Esa persona no tiene perfil de ECOVIT activo.')
        nuevo = perfil.user_id as string
      }
      return json(tocarConversacion(c, { assigned_agent_id: nuevo }))
    }
    default:
      // touch_presence y cualquier otra: no hay nada que devolver.
      return json(null)
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function auth(url: URL): Response {
  const ruta = url.pathname.replace(/^\/auth\/v1/, '')
  if (ruta === '/user') return json(USUARIO)
  if (ruta === '/logout') return new Response(null, { status: 204 })
  return json({})
}

/** Lo que contesta el «Supabase» de la demostración. */
export async function fetchSupabase(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null
  const url = new URL(req ? req.url : String(input))
  const opciones: RequestInit = req
    ? { method: req.method, headers: req.headers, body: init?.body ?? (req.body ? await req.text() : undefined) }
    : (init ?? {})
  if (url.pathname.startsWith('/rest/v1/')) return rest(url, opciones)
  if (url.pathname.startsWith('/auth/v1/')) return auth(url)
  console.info('[muestra] sin respuesta para', url.pathname)
  return json({})
}

// ---------------------------------------------------------------------------
// Las rutas /api de la app
// ---------------------------------------------------------------------------
export async function fetchApi(url: URL, init?: RequestInit): Promise<Response> {
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const ruta = url.pathname
  const cuerpo = ((await leerCuerpo(init)) ?? {}) as Fila

  if (ruta === '/api/whatsapp/conexion') return json({ conectado: true, proveedor: 'zernio' })
  if (ruta === '/api/whatsapp/health') {
    return json({ state: 'connected', displayPhoneNumber: '+57 604 000 0000', quality: 'GREEN', limit: { perDay: 1000 } })
  }
  if (ruta === '/api/ai/config') {
    return metodo === 'GET' ? json(CONFIG_IA) : json({ success: true, ...CONFIG_IA })
  }
  if (ruta === '/api/ai/usage') {
    const dias = Number(url.searchParams.get('days') ?? 30)
    return json(usoIa([7, 30, 90].includes(dias) ? dias : 30))
  }
  if (ruta === '/api/quick-replies') {
    return json({
      quick_replies: [
        { id: 'rr-1', account_id: 'cuenta-muestra', user_id: YO, title: 'Saludo', shortcut: 'hola', content: 'Hola, te habla el equipo comercial de ECOVIT. ¿En qué te ayudo?' },
        { id: 'rr-2', account_id: 'cuenta-muestra', user_id: YO, title: 'Cotización en camino', shortcut: 'coti', content: 'Ya estoy armando tu cotización. Te la envío hoy mismo.' },
      ],
    })
  }

  const autoreply = ruta.match(/^\/api\/ai\/autoreply\/([^/]+)$/)
  if (autoreply && metodo === 'POST') {
    const c = conversacion(decodeURIComponent(autoreply[1]))
    if (!c) return json({ error: 'No existe la conversación.' }, 404)
    if (cuerpo.visto !== c.actualizado_en) {
      return json({ error: 'Otra persona cambió este chat mientras lo mirabas. Recarga la conversación.' }, 409)
    }
    const tomar = cuerpo.accion === 'tomar'
    const asignado = tomar ? (c.assigned_agent_id ?? YO) : null
    const marca = tocarConversacion(c, { ai_autoreply_disabled: tomar, assigned_agent_id: asignado })
    return json({ success: true, paused: tomar, assigned_agent_id: asignado, actualizado_en: marca })
  }

  if (ruta === '/api/whatsapp/send' && metodo === 'POST') {
    const c = conversacion(cuerpo.conversation_id)
    if (!c) return json({ error: 'No existe la conversación.' }, 404)
    const texto =
      (cuerpo.content_text as string) ||
      (cuerpo.template_name ? `Plantilla: ${cuerpo.template_name}` : 'Adjunto')
    const fila: Fila = {
      id: crypto.randomUUID(),
      conversation_id: c.id,
      sender_type: 'agent',
      sender_id: YO,
      content_type: 'text',
      content_text: texto,
      status: 'sent',
      created_at: ahoraIso(),
      reply_to_message_id: cuerpo.reply_to_message_id ?? null,
      ai_generated: false,
    }
    db().messages.push(fila)
    avisar('messages', 'INSERT', fila)
    const antes = { ...c }
    Object.assign(c, { last_message_text: texto, last_message_at: fila.created_at, last_reply_at: fila.created_at })
    avisar('conversations', 'UPDATE', c, antes)
    // Que se vea «entregado» y «leído» como pasaría en WhatsApp.
    for (const [estado, ms] of [['delivered', 1500], ['read', 4000]] as const) {
      setTimeout(() => {
        const previo = { ...fila }
        fila.status = estado
        avisar('messages', 'UPDATE', fila, previo)
      }, ms)
    }
    return json({ success: true, message_id: fila.id })
  }

  if (ruta === '/api/ai/draft' && metodo === 'POST') {
    return json({ draft: 'Hola, con gusto. Ya te preparo la cotización con las referencias que me pediste.' })
  }

  console.info('[muestra] sin respuesta para', metodo, ruta)
  return metodo === 'GET' ? json({}) : json({ error: 'En la demostración esto no se guarda.' }, 400)
}
