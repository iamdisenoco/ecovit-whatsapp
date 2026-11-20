import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookieOptions, supabaseKey, supabaseUrl } from './config'
import { modoMuestra } from '@/lib/muestra/modo'
import { crearClienteMuestra, instalarFetchMuestra } from '@/lib/muestra/cliente'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

// Modo muestra (NEXT_PUBLIC_MODO_MUESTRA=1): las rutas /api se contestan en
// el navegador desde que carga el primer módulo, antes de cualquier efecto.
if (modoMuestra()) instalarFetchMuestra()

export function createClient() {
  if (browserClient) return browserClient

  browserClient = modoMuestra()
    ? crearClienteMuestra()
    : createBrowserClient(supabaseUrl, supabaseKey, { cookieOptions })

  return browserClient
}
