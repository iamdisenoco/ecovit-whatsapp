import { notFound, redirect } from 'next/navigation'

import { DESTINO_MUESTRA, modoMuestra } from '@/lib/muestra/modo'

/**
 * Entrada de la demostración con datos ficticios. Solo existe con
 * `NEXT_PUBLIC_MODO_MUESTRA=1` (ver `lib/muestra/modo.ts`); sin la variable,
 * 404, también en desarrollo.
 */
export default function MuestraPage() {
  if (!modoMuestra()) notFound()
  redirect(DESTINO_MUESTRA)
}
