'use client';

// El botón «Importar historial» de Configuración → WhatsApp (solo la
// dirección). El bucle vive en `lib/whatsapp/historial-cliente.ts`. Si un tramo
// falla, el último punto bueno queda guardado (estado y localStorage) y el
// botón ofrece «Seguir» desde ahí. Los textos no nombran al proveedor.

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  correrImportacion,
  type TramoHistorial,
} from '@/lib/whatsapp/historial-cliente';

const LLAVE = 'ecovit.historial-whatsapp.cursor';

function leerGuardado(): string | null {
  try {
    return window.localStorage.getItem(LLAVE);
  } catch {
    return null;
  }
}

function guardar(cursor: string | null) {
  try {
    if (cursor) window.localStorage.setItem(LLAVE, cursor);
    else window.localStorage.removeItem(LLAVE);
  } catch {
    /* sin almacenamiento: queda en el estado de la pantalla */
  }
}

const numero = (n: number) => n.toLocaleString('es-CO');
const chats = (n: number) => `${numero(n)} ${n === 1 ? 'chat' : 'chats'}`;
const mensajes = (n: number) =>
  `${numero(n)} ${n === 1 ? 'mensaje nuevo' : 'mensajes nuevos'}`;

async function pedirTramo(cursor: string | null): Promise<TramoHistorial> {
  const r = await fetch('/api/whatsapp/historial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor }),
  });
  const json = (await r.json().catch(() => ({}))) as Partial<TramoHistorial> & {
    error?: string;
  };
  if (!r.ok) throw new Error(json.error ?? 'No se pudo importar el historial.');
  return json as TramoHistorial;
}

export function ImportarHistorial() {
  const [corriendo, setCorriendo] = useState(false);
  const [avance, setAvance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lo que quedó a medias en otra visita. Este panel solo se pinta después de
  // leer la conexión en el navegador, así que no hay HTML del servidor que
  // desentone.
  const [pendiente, setPendiente] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : leerGuardado()
  );

  async function importar(desde: string | null) {
    setCorriendo(true);
    setError(null);
    setAvance(desde ? 'Siguiendo desde donde quedó…' : 'Empezando…');
    const fin = await correrImportacion(desde, {
      pedirTramo,
      guardarCursor: (c) => {
        setPendiente(c);
        guardar(c);
      },
      alAvanzar: ({ listas, nuevos, esperando }) =>
        setAvance(
          esperando
            ? `${chats(listas)} hasta ahora. Esperando un momento…`
            : `${chats(listas)} hasta ahora, ${mensajes(nuevos)}…`
        ),
    });
    if (fin.ok) {
      setAvance(
        `Listo: ${chats(fin.listas)} revisados y ${mensajes(fin.nuevos)}.`
      );
    } else {
      setError(
        `${fin.error} Lo que ya entró se conserva${fin.cursor ? ': puede seguir desde donde quedó.' : '.'}`
      );
    }
    setCorriendo(false);
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
      <div className="flex shrink-0 gap-2">
        {pendiente && !corriendo ? (
          <Button size="sm" onClick={() => void importar(pendiente)}>
            <History className="size-4" />
            Seguir
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void importar(null)}
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
    </div>
  );
}
