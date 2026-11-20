import { cn } from '@/lib/utils'

/**
 * «ECOVIT · Conversaciones». El logo de ECOVIT vive en su app; acá va el
 * nombre en la letra y el azul de la marca, con un sello cuadrado.
 */
export function MarcaEcovit({ className, compacta = false }: { className?: string; compacta?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-marca text-[13px] font-extrabold tracking-tight text-marca-foreground"
      >
        E
      </span>
      {!compacta && (
        <span className="text-[15px] font-semibold leading-tight tracking-tight text-foreground">
          ECOVIT <span className="font-normal text-muted-foreground">· Conversaciones</span>
        </span>
      )}
    </div>
  )
}
