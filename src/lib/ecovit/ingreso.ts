/**
 * Esta app no tiene pantalla de ingreso: se entra por la de ECOVIT.
 *
 * `NEXT_PUBLIC_ECOVIT_URL` es la raíz de ECOVIT (sin barra final), p. ej.
 * `https://comercial.ecovit.com.co`. Si falta, se devuelve `null` y quien
 * llama muestra la pantalla local `/sin-sesion`, que lo explica.
 */
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

/** Roles de ECOVIT (`perfiles.rol`) que entran a Conversaciones. */
export const ROLES_CON_ACCESO = ['admin', 'vendedor'] as const

export function rolTieneAcceso(rol: string | null | undefined): boolean {
  return (ROLES_CON_ACCESO as readonly string[]).includes(rol ?? '')
}
