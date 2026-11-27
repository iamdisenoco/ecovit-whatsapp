import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Lo que el simulacro de Supabase devuelve -------------------------------
// `mockUser`         — lo que resuelve getUser() (null = sin sesión).
// `mockPerfil`       — la fila de `perfiles` de ECOVIT (rol y activo).
// `mockPerfilError`  — un fallo de lectura de `perfiles` (red, 500).
// `refreshedCookies` — cookies que Supabase escribe por setAll() al refrescar
//                      el token: tienen que sobrevivir a toda redirección.
let mockUser: { id: string } | null = null;
let mockPerfil: { rol: string; activo: boolean } | null = null;
let mockPerfilError: { message: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockPerfil, error: mockPerfilError }),
        }),
      }),
    }),
  }),
}));

const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "clave-publicable";
  process.env.NEXT_PUBLIC_ECOVIT_URL = "https://comercial.ecovit.test";
  // Por defecto, sesión compartida con ECOVIT; el bloque de ingreso propio la quita.
  process.env.NEXT_PUBLIC_COOKIE_DOMAIN = ".ecovit.test";
  mockUser = null;
  mockPerfil = null;
  mockPerfilError = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — con cookie compartida, sin sesión se entra por ECOVIT", () => {
  it("manda a /ingresar de ECOVIT con volver = la URL completa", async () => {
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox?c=1"));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.origin).toBe("https://comercial.ecovit.test");
    expect(destino.pathname).toBe("/ingresar");
    expect(destino.searchParams.get("volver")).toBe("https://wa.ecovit.test/inbox?c=1");
  });

  it("conserva el token rotado en la redirección", async () => {
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];
    const res = await middleware(new NextRequest("https://wa.ecovit.test/dashboard"));
    expect(res.status).toBe(307);
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("sin NEXT_PUBLIC_ECOVIT_URL cae a la pantalla local /sin-sesion", async () => {
    delete process.env.NEXT_PUBLIC_ECOVIT_URL;
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sin-sesion");
  });

  it("una API sin sesión responde 401, no redirige", async () => {
    const res = await middleware(new NextRequest("https://wa.ecovit.test/api/ai/draft"));
    expect(res.status).toBe(401);
  });

  it("el webhook pasa sin sesión (se cuida con su firma)", async () => {
    const res = await middleware(new NextRequest("https://wa.ecovit.test/api/whatsapp/webhook"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("/sin-acceso, /sin-sesion e /ingresar no piden sesión", async () => {
    for (const ruta of ["/sin-acceso", "/sin-sesion", "/ingresar", "/ingresar/"]) {
      const res = await middleware(new NextRequest(`https://wa.ecovit.test${ruta}`));
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("compara por segmento: /sin-sesionx sí pide sesión", async () => {
    const res = await middleware(new NextRequest("https://wa.ecovit.test/sin-sesionx"));
    expect(res.status).toBe(307);
  });
});

describe("middleware — sin cookie compartida, sin sesión se entra por /ingresar propio", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  });

  it("manda a /ingresar de esta app con volver = la ruta relativa", async () => {
    const res = await middleware(new NextRequest("https://wa.vercel.app/inbox?c=1"));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.origin).toBe("https://wa.vercel.app");
    expect(destino.pathname).toBe("/ingresar");
    expect(destino.searchParams.get("volver")).toBe("/inbox?c=1");
  });

  it("no manda a ECOVIT aunque NEXT_PUBLIC_ECOVIT_URL esté puesta", async () => {
    const res = await middleware(new NextRequest("https://wa.vercel.app/dashboard"));
    expect(new URL(res.headers.get("location")!).origin).toBe("https://wa.vercel.app");
  });

  it("/ingresar no pide sesión (no hay bucle)", async () => {
    const res = await middleware(new NextRequest("https://wa.vercel.app/ingresar?volver=%2Finbox"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("compara por segmento: /ingresarx sí pide sesión", async () => {
    const res = await middleware(new NextRequest("https://wa.vercel.app/ingresarx"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/ingresar");
  });

  it("una API sin sesión sigue respondiendo 401", async () => {
    const res = await middleware(new NextRequest("https://wa.vercel.app/api/ai/draft"));
    expect(res.status).toBe(401);
  });

  it("dado de baja va a /ingresar?motivo=baja, que cierra la sesión", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "vendedor", activo: false };
    const destino = new URL(
      (await middleware(new NextRequest("https://wa.vercel.app/inbox"))).headers.get("location")!,
    );
    expect(destino.origin).toBe("https://wa.vercel.app");
    expect(destino.pathname).toBe("/ingresar");
    expect(destino.searchParams.get("motivo")).toBe("baja");
  });

  it("administracion con sesión propia va a /sin-acceso", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "administracion", activo: true };
    const res = await middleware(new NextRequest("https://wa.vercel.app/inbox"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sin-acceso");
  });

  it("vendedor activo entra", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "vendedor", activo: true };
    const res = await middleware(new NextRequest("https://wa.vercel.app/inbox"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — con sesión manda el perfil de ECOVIT", () => {
  it.each(["admin", "vendedor"])("%s entra a la bandeja", async (rol) => {
    mockUser = { id: "u1" };
    mockPerfil = { rol, activo: true };
    refreshedCookies = [ROTATED];
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("administracion va a /sin-acceso", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "administracion", activo: true };
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sin-acceso");
  });

  it("administracion recibe 403 en la API", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "administracion", activo: true };
    const res = await middleware(new NextRequest("https://wa.ecovit.test/api/ai/draft"));
    expect(res.status).toBe(403);
  });

  it("dado de baja vuelve a ECOVIT, que lo explica", async () => {
    mockUser = { id: "u1" };
    mockPerfil = { rol: "vendedor", activo: false };
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(new URL(res.headers.get("location")!).origin).toBe("https://comercial.ecovit.test");
  });

  it("sin perfil vuelve a ECOVIT", async () => {
    mockUser = { id: "u1" };
    mockPerfil = null;
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/ingresar");
  });

  it("un fallo al leer perfiles no es una baja: deja pasar", async () => {
    mockUser = { id: "u1" };
    mockPerfilError = { message: "500" };
    const res = await middleware(new NextRequest("https://wa.ecovit.test/inbox"));
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — toda ruta del tablero pide sesión", () => {
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("encuentra el grupo de rutas", () => {
    expect(dashboardRoutes).toContain("/inbox");
  });

  it.each(dashboardRoutes)("sin sesión, %s va al ingreso de ECOVIT", async (route) => {
    const res = await middleware(new NextRequest(`https://wa.ecovit.test${route}`));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.origin).toBe("https://comercial.ecovit.test");
    expect(destino.pathname).toBe("/ingresar");
  });

  it.each(dashboardRoutes)("sin sesión ni cookie compartida, %s va al /ingresar propio", async (route) => {
    delete process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
    const res = await middleware(new NextRequest(`https://wa.vercel.app${route}`));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.origin).toBe("https://wa.vercel.app");
    expect(destino.pathname).toBe("/ingresar");
    expect(destino.searchParams.get("volver")).toBe(route);
  });
});
