/**
 * El cliente de Supabase del modo muestra: el mismo `supabase-js` de la app,
 * pero con su `fetch`, su almacenamiento de sesión y su WebSocket cambiados
 * por los de la demostración. Los componentes no se enteran: piden lo mismo
 * de siempre y les contesta `backend.ts`, en memoria.
 */
import { createClient as crearSupabase, type SupabaseClient } from '@supabase/supabase-js'

import { fetchApi, fetchSupabase } from './backend'
import { USUARIO } from './datos'
import { WebSocketMuestra } from './ws'

/** Un host que no existe (.invalid está reservado): igual nunca se llama. */
export const URL_MUESTRA = 'https://muestra.invalid'
const CLAVE_SESION = 'sesion-muestra'

/** Un JWT con forma de JWT. Nadie lo verifica: el servidor es de mentira. */
function tokenFalso(): string {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USUARIO.id, role: 'authenticated', aud: 'authenticated', email: USUARIO.email, exp })}.muestra`
}

/** La sesión ya puesta: así `getSession()` la encuentra sin pedir nada. */
function almacenSesion() {
  const token = tokenFalso()
  const sesion = {
    access_token: token,
    refresh_token: 'muestra',
    token_type: 'bearer',
    expires_in: 365 * 24 * 3600,
    expires_at: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    user: USUARIO,
  }
  const mapa = new Map<string, string>([[CLAVE_SESION, JSON.stringify(sesion)]])
  return {
    getItem: (k: string) => mapa.get(k) ?? null,
    setItem: (k: string, v: string) => void mapa.set(k, v),
    removeItem: (k: string) => void mapa.delete(k),
  }
}

export function crearClienteMuestra(): SupabaseClient {
  instalarFetchMuestra()
  return crearSupabase(URL_MUESTRA, 'clave-de-muestra', {
    global: { fetch: fetchSupabase },
    auth: {
      storage: almacenSesion(),
      storageKey: CLAVE_SESION,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: { transport: WebSocketMuestra as never },
  })
}

let instalado = false

/**
 * Las rutas `/api` de la app las contesta la demostración. Lo demás (las
 * páginas y los recursos de Next, que son del mismo sitio) sigue su camino.
 * Cualquier pedido a otro host se corta: la demostración no sale a la red.
 */
export function instalarFetchMuestra() {
  if (instalado || typeof window === 'undefined') return
  instalado = true
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = new URL(req ? req.url : String(input), window.location.href)
    if (url.origin !== window.location.origin) {
      console.warn('[muestra] pedido a otro host cortado:', url.origin)
      return new Response(JSON.stringify({ error: 'Sin red en la demostración' }), { status: 503 })
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const opciones: RequestInit = req
        ? { method: req.method, headers: req.headers, body: init?.body ?? (req.body ? await req.text() : undefined) }
        : (init ?? {})
      return fetchApi(url, opciones)
    }
    return original(input, init)
  }
}
