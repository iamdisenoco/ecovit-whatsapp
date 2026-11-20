import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { cookieOptions, supabaseKey, supabaseUrl } from '@/lib/supabase/config'
import { rolTieneAcceso, urlIngresoEcovit } from '@/lib/ecovit/ingreso'

/**
 * ECOVIT · Conversaciones no tiene usuarios propios: entra quien tiene sesión
 * en ECOVIT (mismo proyecto de Supabase, misma cookie). Sin sesión, se manda a
 * la pantalla de ingreso de ECOVIT con `volver` apuntando acá. Con sesión, se
 * mira `perfiles` (la autoridad de ECOVIT): dado de baja o sin perfil vuelve a
 * ECOVIT, que lo explica; `administracion` no entra a la bandeja.
 *
 * Es una primera barrera: la de verdad son las políticas de la base.
 */

/** Rutas sin sesión: las pantallas que explican por qué no se entra. */
const SIN_SESION = ['/sin-sesion', '/sin-acceso']

/** API que se cuidan solas (firma de Meta/Zernio, secreto del cron). */
const API_PROPIAS = ['/api/whatsapp/webhook', '/api/whatsapp/meta/webhook', '/api/automations/cron', '/api/flows/cron']

/** Por SEGMENTO, no por prefijo de texto (regla de ECOVIT). */
const enLista = (ruta: string, lista: string[]) =>
  lista.some((p) => ruta === p || ruta.startsWith(`${p}/`))

export async function middleware(request: NextRequest) {
  const ruta = request.nextUrl.pathname
  if (enLista(ruta, SIN_SESION) || enLista(ruta, API_PROPIAS)) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
      },
    },
  })

  // Un error que no es de Auth (cookie rota) cuenta como «sin sesión».
  const user = await supabase.auth
    .getUser()
    .then((r) => r.data.user, () => null)

  // getUser() puede refrescar el token y rotar la cookie (wacrm #288): toda
  // respuesta distinta de `supabaseResponse` tiene que llevarse esas cookies.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  const esApi = ruta === '/api' || ruta.startsWith('/api/')

  if (!user) {
    if (esApi) {
      return withRefreshedCookies(
        NextResponse.json({ error: 'Sin sesión' }, { status: 401 })
      )
    }
    const destino = urlIngresoEcovit(request.nextUrl.href)
    const url = destino ? new URL(destino) : new URL('/sin-sesion', request.url)
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Con sesión: el perfil de ECOVIT decide. Un fallo de lectura NO es una baja
  // (ECOVIT, HU-17): se deja pasar y mandan las políticas de la base.
  const { data: perfil, error } = await supabase
    .from('perfiles')
    .select('rol, activo')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (error) return supabaseResponse

  if (!perfil || !perfil.activo) {
    // ECOVIT cierra la sesión y dice por qué (baja o sin perfil).
    if (esApi) {
      return withRefreshedCookies(
        NextResponse.json({ error: 'Sin acceso' }, { status: 403 })
      )
    }
    const destino = urlIngresoEcovit()
    const url = destino ? new URL(destino) : new URL('/sin-sesion', request.url)
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  if (!rolTieneAcceso(perfil.rol)) {
    if (esApi) {
      return withRefreshedCookies(
        NextResponse.json({ error: 'Tu rol no tiene acceso a Conversaciones' }, { status: 403 })
      )
    }
    return withRefreshedCookies(
      NextResponse.redirect(new URL('/sin-acceso', request.url))
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)',
  ],
}
