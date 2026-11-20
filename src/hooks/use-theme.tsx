"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_MODE,
  MODE_STORAGE_KEY,
  TEMA_DE_MODO,
  modoDeTema,
  type Mode,
} from "@/lib/themes";

/**
 * ThemeProvider — el modo claro/oscuro de ECOVIT (`data-tema` en <html>).
 *
 * El script de arranque de `src/app/layout.tsx` ya dejó puesto el atributo
 * antes de pintar: lo guardado en `ecovit_tema` o, si no hay nada, lo que
 * diga `prefers-color-scheme`. Acá se lee lo que hay y se mantiene al día.
 * Mientras la persona no elija, el modo sigue al sistema también en vivo.
 */

interface ThemeContextValue {
  mode: Mode;
  setMode: (next: Mode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function leerGuardado(): Mode | null {
  try {
    return modoDeTema(localStorage.getItem(MODE_STORAGE_KEY));
  } catch {
    // localStorage puede fallar en incógnito o en un iframe aislado.
    return null;
  }
}

function readInitialMode(): Mode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  return modoDeTema(document.documentElement.dataset.tema) ?? leerGuardado() ?? DEFAULT_MODE;
}

function aplicar(mode: Mode) {
  document.documentElement.dataset.tema = TEMA_DE_MODO[mode];
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readInitialMode);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    if (typeof document !== "undefined") aplicar(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, TEMA_DE_MODO[next]);
    } catch {
      // Incógnito: el modo vive solo en esta pestaña.
    }
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  // Sin elección guardada, el modo sigue al sistema en vivo.
  useEffect(() => {
    const consulta = window.matchMedia("(prefers-color-scheme: dark)");
    function alCambiar(e: MediaQueryListEvent) {
      if (leerGuardado()) return;
      const next: Mode = e.matches ? "dark" : "light";
      setModeState(next);
      aplicar(next);
    }
    consulta.addEventListener("change", alCambiar);
    return () => consulta.removeEventListener("change", alCambiar);
  }, []);

  // Otra pestaña cambió el modo: esta se pone al día.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== MODE_STORAGE_KEY) return;
      const next = modoDeTema(e.newValue);
      if (next && next !== mode) {
        setModeState(next);
        aplicar(next);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      mode: DEFAULT_MODE,
      setMode: () => {},
      toggleMode: () => {},
    };
  }
  return ctx;
}
