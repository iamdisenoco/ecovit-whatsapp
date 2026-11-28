<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Cómo se trabaja en este repo

- **Los textos que ve el cliente no le explican reglas ni seguridad; las protecciones van en el
  código, sin que se vean.** Jon, 20-nov: «Deja de poner tantas reglas de seguridad». Vale para
  los textos fijos del bot (`src/lib/bot-clientes/textos.ts`), el prompt y cualquier respuesta que
  llegue al cliente.
- **La app nunca nombra al proveedor de WhatsApp (Zernio) en lo que ve el usuario** (Jon, 28-nov:
  «en la aplicación nunca se debe mencionar Zernio, porque eso es para entregar al cliente»).
  Botones, avisos y errores dicen WhatsApp; el código y la base pueden decir zernio. Lo vigila
  `src/textos-sin-proveedor.test.ts`.
