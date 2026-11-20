// Capturas y recorrido de la demostración (modo muestra) con Playwright.
//
// Uso: con la app corriendo en modo muestra (NEXT_PUBLIC_MODO_MUESTRA=1),
//   BASE=http://localhost:3100 node scripts/capturas-muestra.mjs [capturas|recorrido|todo]
//
// - «capturas» guarda en docs/capturas/panel/ la bandeja, un chat, «Asignar a…»,
//   las métricas de IA y el celular, a 1280×800 y 390×844, en claro y oscuro.
// - «recorrido» hace los clics de la reunión y comprueba que cada uno cambia lo
//   que tiene que cambiar.
// En las dos se anota todo pedido a otro host que no sea BASE: tiene que ser cero.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

// Playwright no es dependencia del repo: se usa el que ya está instalado en la
// máquina (require sigue NODE_PATH; import no).
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE ?? 'http://localhost:3100'
const modo = process.argv[2] ?? 'todo'
const DIR = 'docs/capturas/panel'
mkdirSync(DIR, { recursive: true })

const origenBase = new URL(BASE).origin
const fuera = []
const errores = []
let fallas = 0

function vigilar(page, etiqueta) {
  page.on('request', (r) => {
    const u = r.url()
    if (u.startsWith('data:') || u.startsWith('blob:')) return
    if (new URL(u).origin !== origenBase) fuera.push(`${etiqueta}: ${r.method()} ${u}`)
  })
  page.on('websocket', (ws) => fuera.push(`${etiqueta}: WebSocket ${ws.url()}`))
  page.on('pageerror', (e) => errores.push(`${etiqueta}: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errores.push(`${etiqueta} consola: ${m.text()}`)
  })
}

async function nuevaPagina(browser, { ancho, alto, tema }) {
  const ctx = await browser.newContext({
    viewport: { width: ancho, height: alto },
    deviceScaleFactor: 2,
    hasTouch: ancho < 500,
    isMobile: ancho < 500,
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    colorScheme: tema === 'oscuro' ? 'dark' : 'light',
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('ecovit_tema', t)
    } catch {}
  }, tema)
  const page = await ctx.newPage()
  vigilar(page, `${ancho}-${tema}`)
  return page
}

const chat = (page, nombre) => page.getByRole('button', { name: new RegExp(nombre) }).first()
const botonAsignar = (page) => page.locator('button:has(svg.lucide-user-plus)').first()

async function esperarBandeja(page) {
  await page.goto(`${BASE}/muestra`)
  await page.waitForURL('**/inbox**')
  await chat(page, 'Mauricio Salazar').waitFor()
  await page.waitForTimeout(600)
}

// La página no se desplaza: se desplaza <main> (el armazón ocupa la pantalla).
async function bajarAlFondo(page) {
  await page.evaluate(() => {
    const m = document.querySelector('main')
    if (m) m.scrollTop = m.scrollHeight
  })
}

async function foto(page, nombre, opciones = {}) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${DIR}/${nombre}.png`, ...opciones })
  console.log('captura', `${DIR}/${nombre}.png`)
}

async function capturas(browser) {
  for (const tema of ['claro', 'oscuro']) {
    // Escritorio
    let page = await nuevaPagina(browser, { ancho: 1280, alto: 800, tema })
    await esperarBandeja(page)
    await foto(page, `bandeja-1280-${tema}`)
    await chat(page, 'Mauricio Salazar').click()
    await page.getByText('Precio de lista: $ 148.000 por unidad, antes de IVA.').waitFor()
    await page.getByText('Constructora Altos del Río S.A.S.').waitFor()
    await foto(page, `chat-1280-${tema}`)
    await botonAsignar(page).click()
    await page.getByRole('menuitem', { name: /Carolina Mejía/ }).waitFor()
    await foto(page, `asignar-1280-${tema}`)
    await page.keyboard.press('Escape')
    await page.goto(`${BASE}/agents`)
    await page.getByRole('tab', { name: 'Uso' }).click()
    await page.getByText('Chats que más gastaron').waitFor()
    await foto(page, `metricas-1280-${tema}`)
    await bajarAlFondo(page)
    await foto(page, `metricas-graficas-1280-${tema}`)
    await page.context().close()

    // Celular
    page = await nuevaPagina(browser, { ancho: 390, alto: 844, tema })
    await esperarBandeja(page)
    await foto(page, `bandeja-390-${tema}`)
    await chat(page, 'Mauricio Salazar').click()
    await page.getByText('Precio de lista: $ 148.000 por unidad, antes de IVA.').waitFor()
    await foto(page, `chat-390-${tema}`)
    await botonAsignar(page).click()
    await page.getByRole('menuitem', { name: /Carolina Mejía/ }).waitFor()
    await foto(page, `asignar-390-${tema}`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Cliente', exact: true }).click()
    await page.getByText('Constructora Altos del Río S.A.S.').waitFor()
    await foto(page, `cliente-390-${tema}`)
    await page.keyboard.press('Escape')
    await page.goto(`${BASE}/agents`)
    await page.getByRole('tab', { name: 'Uso' }).click()
    await page.getByText('Chats que más gastaron').waitFor()
    await foto(page, `metricas-390-${tema}`)
    await bajarAlFondo(page)
    await foto(page, `metricas-graficas-390-${tema}`)
    await page.context().close()
  }
}

function comprobar(cond, texto) {
  console.log(cond ? 'BIEN ' : 'MAL  ', texto)
  if (!cond) fallas++
}

async function recorrido(browser) {
  const page = await nuevaPagina(browser, { ancho: 1280, alto: 800, tema: 'claro' })
  await esperarBandeja(page)
  const filas = page.locator('button:has(span.truncate)')

  // 1. Abrir un chat y cambiar a otro.
  await chat(page, 'Mauricio Salazar').click()
  await page.getByText('Hoy en la tarde te mando la cotización formal.').last().waitFor()
  await chat(page, 'Natalia Ríos').click()
  await page.getByText('Unas 60. ¿Me mandan fotos?').last().waitFor()
  comprobar(page.url().includes('c=chat-monteverde'), 'cambiar de chat abre el de Natalia')

  // 2. El bot está activo y nadie lo tiene: «Tomar el control».
  await page.getByRole('button', { name: 'Tomar el control' }).click()
  await page.getByRole('button', { name: 'Retomar IA' }).waitFor()
  comprobar(await botonAsignar(page).textContent().then((t) => t.includes('Laura Gómez')), 'tomar el control deja el chat a nombre de Laura')
  await foto(page, 'recorrido-tomado-1280-claro')

  // 3. «Retomar IA» lo devuelve al bot y lo suelta.
  await page.getByRole('button', { name: 'Retomar IA' }).click()
  await page.getByRole('button', { name: 'Tomar el control' }).waitFor()
  comprobar(true, 'retomar IA vuelve a mostrar «Tomar el control»')

  // 4. «Asignar a…» Carolina: cambia el botón y sale de «Sin asignar».
  await page.getByRole('button', { name: /^Todas/ }).click()
  await page.getByRole('menuitem', { name: 'Sin asignar' }).click()
  const antes = await filas.allTextContents()
  comprobar(antes.some((t) => t.includes('Natalia Ríos')), 'Natalia aparece en «Sin asignar» antes de asignar')
  await botonAsignar(page).click()
  await page.getByRole('menuitem', { name: /Carolina Mejía/ }).click()
  await page.waitForTimeout(500)
  comprobar(await botonAsignar(page).textContent().then((t) => t.includes('Carolina Mejía')), 'el botón dice Carolina Mejía')
  const despues = await filas.allTextContents()
  comprobar(!despues.some((t) => t.includes('Natalia Ríos')), 'Natalia sale de «Sin asignar» en la bandeja')
  await foto(page, 'recorrido-asignado-1280-claro')
  await page.getByRole('button', { name: /^Sin asignar/ }).click()
  await page.getByRole('menuitem', { name: 'Todas' }).click()

  // 5. Escribir y mandar una respuesta.
  await chat(page, 'Mauricio Salazar').click()
  await page.getByText('Hoy en la tarde te mando la cotización formal.').last().waitFor()
  const texto = 'Mauricio, te acabo de enviar la cotización al correo.'
  await page.locator('textarea').first().fill(texto)
  await page.locator('textarea').first().press('Enter')
  await page.locator('main').getByText(texto).first().waitFor()
  await page.waitForTimeout(800)
  const fila = await chat(page, 'Mauricio Salazar').textContent()
  comprobar(fila.includes('te acabo de enviar'), 'la respuesta aparece en el hilo y en la vista previa de la bandeja')
  await foto(page, 'recorrido-enviado-1280-claro')

  // 6. Métricas con su filtro de días.
  await page.getByRole('link', { name: /Agentes|IA/ }).first().click().catch(() => page.goto(`${BASE}/agents`))
  await page.waitForURL('**/agents')
  await page.getByRole('tab', { name: 'Uso' }).click()
  await page.getByText('Chats que más gastaron').waitFor()
  const ventana30 = await page.getByText(/En los últimos \d+ días/).locator('..').textContent()
  await page.getByRole('combobox').first().click()
  await page.getByRole('option', { name: /7/ }).click()
  await page.getByText('En los últimos 7 días').waitFor()
  const ventana7 = await page.getByText(/En los últimos \d+ días/).locator('..').textContent()
  comprobar(ventana30 !== ventana7, `el filtro de días cambia el gasto (${ventana30} → ${ventana7})`)
  await foto(page, 'recorrido-metricas-7-1280-claro', { fullPage: true })

  // 7. El resto del menú abre sin romperse.
  for (const ruta of ['/dashboard', '/contacts', '/broadcasts', '/automations', '/flows', '/notifications', '/settings']) {
    await page.goto(`${BASE}${ruta}`)
    await page.waitForTimeout(1200)
    const roto = await page.getByText(/Application error|Something went wrong|Algo salió mal/i).count()
    comprobar(roto === 0, `${ruta} abre sin error de aplicación`)
  }
  await page.context().close()
}

const browser = await chromium.launch()
try {
  if (modo === 'capturas' || modo === 'todo') await capturas(browser)
  if (modo === 'recorrido' || modo === 'todo') await recorrido(browser)
} finally {
  await browser.close()
}

console.log(`\nPedidos a otro host: ${fuera.length}`)
fuera.forEach((f) => console.log('  ', f))
console.log(`Errores de página o consola: ${errores.length}`)
errores.slice(0, 30).forEach((e) => console.log('  ', e))
if (fuera.length) fallas++
process.exit(fallas ? 1 : 0)
