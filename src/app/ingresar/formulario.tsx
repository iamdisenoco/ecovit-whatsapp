'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { mensajeErrorIngreso } from '@/lib/ecovit/ingreso'

const CAMPO =
  'h-11 w-full rounded-lg border border-input bg-card px-3 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-destructive disabled:opacity-60'

/**
 * Correo y contraseña contra Supabase, con el cliente de navegador de la app
 * (la misma cookie que lee el middleware). Al entrar, navegación completa a
 * `volver` —ya validado en el servidor— para que el middleware vea la sesión
 * nueva y aplique los controles de perfil y rol.
 */
export function Formulario({ volver, baja }: { volver: string; baja: boolean }) {
  const [error, setError] = useState<string | null>(
    baja ? 'Tu cuenta no tiene acceso a Conversaciones. Si crees que es un error, escríbele a la dirección.' : null,
  )
  const [enviando, setEnviando] = useState(false)

  // Llega con `motivo=baja` cuando tiene sesión pero no perfil activo: se
  // cierra acá para que pueda entrar con otra cuenta.
  useEffect(() => {
    if (baja) void createClient().auth.signOut({ scope: 'local' })
  }, [baja])

  async function entrar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (enviando) return
    setError(null)

    // Del formulario y no del estado: lo escrito antes de hidratar no se pierde.
    const datos = new FormData(e.currentTarget)
    const correo = String(datos.get('correo') ?? '').trim()
    const clave = String(datos.get('clave') ?? '')
    if (!correo || !clave) {
      setError('Escribe tu correo y tu contraseña.')
      return
    }

    setEnviando(true)
    try {
      const { error: falla } = await createClient().auth.signInWithPassword({
        email: correo,
        password: clave,
      })
      if (falla) {
        setError(mensajeErrorIngreso(falla.message))
        setEnviando(false)
        return
      }
    } catch {
      setError(mensajeErrorIngreso(null))
      setEnviando(false)
      return
    }
    window.location.assign(volver)
  }

  // method="post": si se envía antes de hidratar, la clave no termina en la URL.
  return (
    <form onSubmit={entrar} method="post" className="mt-6 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="correo" className="text-sm font-medium text-foreground">
          Correo
        </label>
        <input
          id="correo"
          name="correo"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          disabled={enviando}
          aria-invalid={Boolean(error) || undefined}
          className={CAMPO}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="clave" className="text-sm font-medium text-foreground">
          Contraseña
        </label>
        <input
          id="clave"
          name="clave"
          type="password"
          autoComplete="current-password"
          required
          disabled={enviando}
          aria-invalid={Boolean(error) || undefined}
          className={CAMPO}
        />
      </div>

      {/* El hueco se reserva: el formulario no salta al fallar. */}
      <div className="min-h-[20px]">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={enviando}
        className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-accion px-4 text-sm font-medium text-accion-foreground transition-colors hover:bg-accion-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {enviando ? 'Ingresando…' : 'Ingresar'}
      </button>
    </form>
  )
}
