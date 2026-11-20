import { modoMuestra } from "@/lib/muestra/modo";

/**
 * Marca del modo muestra junto al título: quien mira la demostración sabe que
 * los datos son inventados y que nada se guarda. Sin el modo, no pinta nada.
 * Va en la cabecera para no cambiar el alto de ninguna pantalla.
 */
export function AvisoMuestra() {
  if (!modoMuestra()) return null;
  return (
    <span
      role="note"
      title="Datos ficticios: nada se guarda ni se envía."
      className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
    >
      <span className="sm:hidden">Demo</span>
      <span className="hidden sm:inline">Demostración</span>
    </span>
  );
}
