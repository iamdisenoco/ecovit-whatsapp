import type { ReactNode } from 'react'
import { MarcaEcovit } from './marca'

/**
 * Pantalla sobria para cuando no se puede entrar: sin barra lateral, sin
 * llamadas a la base. La usan /sin-sesion y /sin-acceso.
 */
export function PantallaAviso({
  titulo,
  children,
  accion,
}: {
  titulo: string
  children: ReactNode
  accion?: { texto: string; href: string }
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
        <MarcaEcovit />
        <h1 className="mt-8 text-xl font-semibold tracking-tight text-foreground">{titulo}</h1>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
        {accion && (
          <a
            href={accion.href}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-accion px-4 text-sm font-medium text-accion-foreground transition-colors hover:bg-accion-hover"
          >
            {accion.texto}
          </a>
        )}
      </div>
    </main>
  )
}
