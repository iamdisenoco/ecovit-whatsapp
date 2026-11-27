/**
 * Por dónde se entra a Conversaciones.
 *
 * Hay dos formas, y las decide `NEXT_PUBLIC_COOKIE_DOMAIN`:
 *  · **Con** la variable (dominio propio compartido con ECOVIT, p. ej.
 *    `.ecovit.com.co`): la cookie de sesión sirve en las dos apps y se entra
 *    por la pantalla de ingreso de ECOVIT.
 *  · **Sin** la variable (p. ej. en `*.vercel.app`, que es un sufijo público y
 *    no deja compartir cookies): se entra por `/ingresar` de esta app, con el
 *    mismo correo y la misma clave de ECOVIT, contra la misma base.
 *
 * En los dos casos, después de entrar mandan los mismos controles: perfil
 * activo en ECOVIT y rol con acceso (ver `middleware.ts`).
 *
 * `NEXT_PUBLIC_ECOVIT_URL` es la raíz de ECOVIT (sin barra final), p. ej.
 * `https://comercial.ecovit.com.co`.
 */

/** La pantalla de ingreso propia. */
export const RUTA_INGRESO = '/ingresar'

/** A dónde se va después de entrar cuando no hay un `volver` válido. */
export const DESTINO_POR_DEFECTO = '/inbox'

/** Por SEGMENTO, no por prefijo de texto (regla de ECOVIT). */
export function enLista(ruta: string, lista: readonly string[]): boolean {
  return lista.some((p) => ruta === p || ruta.startsWith(`${p}/`))
}

/** Si la sesión es la de ECOVIT (cookie compartida) o la propia de esta app. */
export function sesionCompartida(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_COOKIE_DOMAIN?.trim())
}

export function ecovitUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_ECOVIT_URL?.trim().replace(/\/+$/, '')
  return url ? url : null
}

/**
 * La URL de ingreso de ECOVIT con `volver` apuntando a donde estaba la
 * persona. `volver` va como URL completa porque es otra app.
 */
export function urlIngresoEcovit(volver?: string): string | null {
  const base = ecovitUrl()
  if (!base) return null
  const destino = new URL(`${base}/ingresar`)
  if (volver) destino.searchParams.set('volver', volver)
  return destino.toString()
}

/**
 * El `volver` de `/ingresar` lo escribe cualquiera en la URL: solo vale una
 * ruta RELATIVA de esta app. Empieza con una sola barra, no sigue con otra ni
 * con `\` (el navegador la lee como `/`), no lleva caracteres de control (el
 * navegador los borra: `/\t/otro.com` se vuelve `//otro.com`) y, resuelta,
 * se queda en este mismo origen. Tampoco se vuelve a `/ingresar`, que sería
 * dar una vuelta en redondo. Si no, `porDefecto`.
 */
export function volverSeguro(
  pedida: string | null | undefined,
  porDefecto: string = DESTINO_POR_DEFECTO,
): string {
  if (!pedida) return porDefecto
  if (/[\u0000-\u001f\u007f]/.test(pedida)) return porDefecto
  if (!/^\/(?![/\\])/.test(pedida)) return porDefecto
  let url: URL
  try {
    url = new URL(pedida, 'https://esta-app.invalid')
  } catch {
    return porDefecto
  }
  if (url.origin !== 'https://esta-app.invalid') return porDefecto
  if (enLista(url.pathname, [RUTA_INGRESO])) return porDefecto
  return pedida
}

/**
 * A dónde se manda a quien no tiene sesión, dada la URL donde estaba. Con
 * sesión compartida, a ECOVIT (o a `/sin-sesion` si falta su URL); con sesión
 * propia, a `/ingresar?volver=<ruta relativa>`. Devuelve una URL absoluta
 * (ECOVIT) o una ruta de esta app.
 */
export function urlSinSesion(actual: string | URL): string {
  const aca = new URL(actual)
  if (sesionCompartida()) return urlIngresoEcovit(aca.href) ?? '/sin-sesion'
  const volver = volverSeguro(aca.pathname + aca.search, '')
  return volver ? `${RUTA_INGRESO}?volver=${encodeURIComponent(volver)}` : RUTA_INGRESO
}

/**
 * Para quien tiene sesión pero no perfil activo en ECOVIT. Con sesión
 * compartida, ECOVIT cierra la sesión y dice por qué; con la propia,
 * `/ingresar` la cierra acá (`motivo=baja`).
 */
export function urlSinPerfil(): string {
  if (sesionCompartida()) return urlIngresoEcovit() ?? '/sin-sesion'
  return `${RUTA_INGRESO}?motivo=baja`
}

/** A dónde va «Cerrar sesión». */
export function urlSalida(): string {
  if (sesionCompartida()) return urlIngresoEcovit() ?? '/sin-sesion'
  return RUTA_INGRESO
}

/** Roles de ECOVIT (`perfiles.rol`) que entran a Conversaciones. */
export const ROLES_CON_ACCESO = ['admin', 'vendedor'] as const

export function rolTieneAcceso(rol: string | null | undefined): boolean {
  return (ROLES_CON_ACCESO as readonly string[]).includes(rol ?? '')
}

/** El texto que ve quien no pudo entrar; nunca el error crudo de Auth. */
export function mensajeErrorIngreso(mensaje: string | null | undefined): string {
  const m = (mensaje ?? '').toLowerCase()
  if (m.includes('invalid')) return 'El correo o la contraseña no coinciden.'
  if (m.includes('not confirmed')) return 'Tu correo todavía no está confirmado. Revisa la invitación de ECOVIT.'
  return 'No pudimos iniciar tu sesión. Intenta de nuevo en un momento.'
}
