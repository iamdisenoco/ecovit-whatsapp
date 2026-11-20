import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Manrope } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import { MODE_STORAGE_KEY } from "@/lib/themes";

// La letra de ECOVIT (app/layout.tsx allá): Manrope.
const manrope = Manrope({
  variable: "--fuente-ecovit",
  subsets: ["latin"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  return {
    ...metadata,
    description: t("description"),
  };
}

const metadata: Metadata = {
  title: {
    default: "ECOVIT · Conversaciones",
    template: "%s · ECOVIT Conversaciones",
  },
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F5F7" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1113" },
  ],
  colorScheme: "light dark",
};

// Script de arranque: corre antes de pintar y deja `data-tema` puesto, igual
// que ECOVIT (lib/tema.ts allá): lo guardado en `ecovit_tema` o, si no hay
// nada, lo que diga el sistema. Sin él, cada carga destellaría el tema del
// servidor. Va como texto plano, sin dependencias.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var g = localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});
    var t = (g === "claro" || g === "oscuro") ? g
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro");
    d.setAttribute("data-tema", t);
  } catch (_e) {
    d.setAttribute("data-tema", "claro");
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${manrope.variable} h-full antialiased`}
      // El script de arranque pone `data-tema` antes de hidratar, así que
      // el <html> del cliente difiere a propósito del del servidor.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            {children}
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
