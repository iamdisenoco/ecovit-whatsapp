'use client';

// El botón «Importar historial» de Configuración → WhatsApp (solo la
// dirección). Llama a `POST /api/whatsapp/historial` en bucle, tramo a tramo,
// hasta que termina. Es idempotente: se puede volver a correr cuando se quiera
// (sirve para reintentar si se cortó). Los textos no nombran al proveedor.

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface Tramo {
  procesadas: number;
  mensajes: number;
  listas: number;
  cursor: string | null;
  terminado: boolean;
  esperarMs: number | null;
  error?: string;
}

const MAX_TRAMOS = 2000;

const numero = (n: number) => n.toLocaleString('es-CO');
const chats = (n: number) => `${numero(n)} ${n === 1 ? 'chat' : 'chats'}`;
const mensajes = (n: number) =>
  `${numero(n)} ${n === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}`;

export function ImportarHistorial() {
  const [corriendo, setCorriendo] = useState(false);
  const [avance, setAvance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importar() {
    setCorriendo(true);
    setError(null);
    setAvance('Empezando…');
    let cursor: string | null = null;
    let nuevos = 0;
    try {
      for (let i = 0; i < MAX_TRAMOS; i++) {
        const r = await fetch('/api/whatsapp/historial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor }),
        });
        const tramo = (await r.json().catch(() => ({}))) as Partial<Tramo>;
        if (!r.ok)
          throw new Error(tramo.error ?? 'No se pudo importar el historial.');
        nuevos += tramo.mensajes ?? 0;
        const listas = tramo.listas ?? 0;
        if (tramo.terminado) {
          setAvance(`Listo: ${chats(listas)} revisados y ${mensajes(nuevos)}.`);
          return;
        }
        cursor = tramo.cursor ?? null;
        if (tramo.esperarMs) {
          setAvance(`${chats(listas)} hasta ahora. Esperando un momento…`);
          await new Promise((ok) => setTimeout(ok, tramo.esperarMs!));
        }
        setAvance(`${chats(listas)} hasta ahora, ${mensajes(nuevos)}…`);
      }
      throw new Error('Se detuvo antes de terminar. Vuelva a intentarlo.');
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : String(e)} Lo que ya entró se conserva: puede volver a intentarlo.`
      );
    } finally {
      setCorriendo(false);
    }
  }

  return (
    <div className="border-border flex flex-col gap-2 border-t py-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">
          Historial de chats
        </p>
        <p className="text-muted-foreground text-sm">
          Trae a la bandeja las conversaciones que el número ya tenía antes de
          conectarlo. Se puede repetir sin que se dupliquen.
        </p>
        {avance ? (
          <p className="text-foreground mt-2 text-sm" aria-live="polite">
            {avance}
          </p>
        ) : null}
        {error ? (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void importar()}
        disabled={corriendo}
      >
        {corriendo ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <History className="size-4" />
        )}
        Importar historial
      </Button>
    </div>
  );
}
