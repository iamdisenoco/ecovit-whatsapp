/**
 * La conexión a Supabase es la MISMA de ECOVIT: el mismo proyecto, la misma
 * clave publicable y la misma cookie de sesión. Esta app no tiene usuarios
 * propios; quien entra a ECOVIT entra acá.
 *
 * - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` es el nombre que usa ECOVIT.
 *   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (el de wacrm) queda de respaldo.
 * - `NEXT_PUBLIC_COOKIE_DOMAIN` (p. ej. `.ecovit.com.co`) hace que la cookie
 *   de sesión sirva en los dos subdominios. ECOVIT tiene que escribir su
 *   cookie con el MISMO dominio, o cada app verá una sesión distinta.
 */
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

export const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!

const dominio = process.env.NEXT_PUBLIC_COOKIE_DOMAIN?.trim()

/** Opciones de la cookie de sesión; vacías si no hay dominio compartido. */
export const cookieOptions = dominio ? { domain: dominio } : undefined
