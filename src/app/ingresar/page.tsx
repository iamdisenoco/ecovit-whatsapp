import type { Metadata } from 'next'
import { MarcaEcovit } from '@/components/ecovit/marca'
import { volverSeguro } from '@/lib/ecovit/ingreso'
import { Formulario } from './formulario'

export const metadata: Metadata = { title: 'Ingresar' }

type Params = Record<string, string | string[] | undefined>
const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/**
 * Ingreso propio, con el mismo usuario y la misma clave de ECOVIT. El
 * middleware manda acá cuando no hay sesión y la cookie no se comparte con
 * ECOVIT (sin `NEXT_PUBLIC_COOKIE_DOMAIN`). `volver` se valida acá, en el
 * servidor: solo rutas de esta app.
 */
export default async function IngresarPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const volver = volverSeguro(uno(params.volver))
  const baja = uno(params.motivo) === 'baja'

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <MarcaEcovit />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-foreground">Ingresar</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Entra con tu correo y tu contraseña de ECOVIT.
        </p>
        <Formulario volver={volver} baja={baja} />
      </div>
    </main>
  )
}
