/**
 * Los datos ficticios del modo muestra. Ninguna persona, empresa, NIT ni
 * teléfono es real: las constructoras son inventadas y los números son de
 * relleno. Las horas se calculan contra «ahora» para que la bandeja se vea
 * viva el día que se abra.
 */

export type Fila = Record<string, unknown>

export const CUENTA_ID = 'cuenta-muestra'
export const YO = 'u-laura'

const MIN = 60_000
const HORA = 60 * MIN
const DIA = 24 * HORA

interface Persona {
  user_id: string
  perfil_id: string
  nombre: string
  correo: string
  rol: 'admin' | 'agent'
  presencia: 'online' | 'away' | null
}

const EQUIPO: Persona[] = [
  { user_id: YO, perfil_id: 'p-laura', nombre: 'Laura Gómez', correo: 'laura.gomez@demo.ecovit.local', rol: 'admin', presencia: 'online' },
  { user_id: 'u-andres', perfil_id: 'p-andres', nombre: 'Andrés Restrepo', correo: 'andres.restrepo@demo.ecovit.local', rol: 'agent', presencia: 'online' },
  { user_id: 'u-carolina', perfil_id: 'p-carolina', nombre: 'Carolina Mejía', correo: 'carolina.mejia@demo.ecovit.local', rol: 'agent', presencia: 'online' },
  { user_id: 'u-julian', perfil_id: 'p-julian', nombre: 'Julián Ospina', correo: 'julian.ospina@demo.ecovit.local', rol: 'agent', presencia: 'away' },
  { user_id: 'u-paula', perfil_id: 'p-paula', nombre: 'Paula Cárdenas', correo: 'paula.cardenas@demo.ecovit.local', rol: 'agent', presencia: null },
]

export function nombreDe(userId: string | null | undefined): string | null {
  return EQUIPO.find((p) => p.user_id === userId)?.nombre ?? null
}

export const USUARIO = {
  id: YO,
  aud: 'authenticated',
  role: 'authenticated',
  email: EQUIPO[0].correo,
  app_metadata: { provider: 'email' },
  user_metadata: { full_name: EQUIPO[0].nombre },
  created_at: '2026-09-01T12:00:00.000Z',
}

interface ChatSemilla {
  id: string
  contacto: { nombre: string | null; empresa: string | null; telefono: string }
  estado: 'open' | 'pending' | 'closed'
  asignado: string | null
  botPausado: boolean
  resumen?: string
  noLeidos: number
  enlace: { estado: string; detalle?: string }
  ecovit?: {
    cliente: string
    nit: string
    vendedor: string | null
    contacto: [string, string]
    oportunidades: { nombre: string; etapa: string; valor: number }[]
  }
  /** [quién, texto, hace cuántos minutos] */
  mensajes: ['cliente' | 'bot' | 'ia' | string, string, number][]
}

// El chat abierto de la demostración: el bot da precios de lista (T9), pasa
// la negociación al vendedor (T5) y el vendedor sigue.
const CHATS: ChatSemilla[] = [
  {
    id: 'chat-altos-del-rio',
    contacto: { nombre: 'Mauricio Salazar', empresa: 'Constructora Altos del Río', telefono: '+57 310 000 4417' },
    estado: 'open',
    asignado: 'u-andres',
    botPausado: true,
    resumen: 'Pide descuento por volumen para 120 apartamentos de la Torre 3. Lo revisa Andrés.',
    noLeidos: 0,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Constructora Altos del Río S.A.S.',
      nit: '901.000.417-3',
      vendedor: 'u-andres',
      contacto: ['Mauricio', 'Salazar'],
      oportunidades: [
        { nombre: 'Torre 3 · baños de apartamentos', etapa: 'cotizacion_enviada', valor: 186_400_000 },
        { nombre: 'Club house · baterías sanitarias', etapa: 'necesidad_identificada', valor: 42_000_000 },
      ],
    },
    mensajes: [
      ['cliente', 'Buenos días. Somos Constructora Altos del Río, estamos cotizando los baños de la Torre 3.', 190],
      ['ia', 'Buenos días, Mauricio. Con gusto te ayudo con la Torre 3. ¿Qué referencias necesitas?', 189],
      ['cliente', '¿Qué precio tiene el lavamanos de sobreponer Cascada V04 en blanco?', 186],
      ['bot', 'Precio de lista: $ 148.000 por unidad, antes de IVA.', 186],
      ['cliente', '¿Y la grifería monocontrol que va con ese lavamanos?', 184],
      ['bot', 'Precio de lista: $ 236.000 por unidad, antes de IVA.', 184],
      ['cliente', 'Son 120 apartamentos. ¿Qué descuento nos dan por volumen?', 181],
      ['bot', 'Eso lo revisa Andrés Restrepo. Ya tiene tu solicitud y te escribe.', 181],
      ['u-andres', 'Hola, Mauricio. Soy Andrés, de ECOVIT. Ya vi tu solicitud de la Torre 3.', 150],
      ['u-andres', 'Para 120 unidades te preparo la cotización con el combo lavamanos + grifería. ¿Me confirmas la fecha de entrega en obra?', 149],
      ['cliente', 'Primera entrega en febrero y el resto en abril. ¿Despachan a Rionegro?', 41],
      ['u-andres', 'Sí, despachamos a Rionegro. Hoy en la tarde te mando la cotización formal.', 12],
    ],
  },
  {
    id: 'chat-monteverde',
    contacto: { nombre: 'Natalia Ríos', empresa: 'Inversiones Monteverde', telefono: '+57 311 000 2290' },
    estado: 'open',
    asignado: null,
    botPausado: false,
    noLeidos: 2,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Inversiones Monteverde S.A.S.',
      nit: '900.000.229-1',
      vendedor: 'u-carolina',
      contacto: ['Natalia', 'Ríos'],
      oportunidades: [{ nombre: 'Conjunto Monteverde · etapa 2', etapa: 'primer_contacto', valor: 64_500_000 },],
    },
    mensajes: [
      ['cliente', 'Hola, ¿tienen sanitario de descarga dual en blanco?', 9],
      ['ia', 'Hola, Natalia. Sí, tenemos dos referencias de descarga dual en blanco. ¿Para cuántas unidades sería?', 9],
      ['cliente', 'Unas 60. ¿Me mandan fotos?', 4],
    ],
  },
  {
    id: 'chat-la-pradera',
    contacto: { nombre: 'Felipe Arango', empresa: 'Urbanizadora La Pradera', telefono: '+57 312 000 7781' },
    estado: 'pending',
    asignado: null,
    botPausado: true,
    resumen: 'Quiere hablar con un asesor sobre crédito a 60 días.',
    noLeidos: 1,
    enlace: { estado: 'sin_contacto' },
    mensajes: [
      ['cliente', 'Buenas tardes. ¿Manejan crédito a 60 días para constructoras?', 33],
      ['bot', 'Ya le avisé a tu asesor para que te escriba.', 33],
      ['cliente', 'Gracias, quedo atento.', 30],
    ],
  },
  {
    id: 'chat-obras-caribe',
    contacto: { nombre: 'Diana Pérez', empresa: 'Obras Civiles del Caribe', telefono: '+57 300 000 5530' },
    estado: 'open',
    asignado: 'u-carolina',
    botPausado: false,
    noLeidos: 0,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Obras Civiles del Caribe Ltda.',
      nit: '890.000.553-0',
      vendedor: 'u-carolina',
      contacto: ['Diana', 'Pérez'],
      oportunidades: [{ nombre: 'Hotel Bahía · 48 habitaciones', etapa: 'seguimiento_activo', valor: 97_800_000 }],
    },
    mensajes: [
      ['u-carolina', 'Diana, ¿te llegó la cotización del hotel?', 75],
      ['cliente', 'Sí, la estoy revisando con el arquitecto. Te confirmo el lunes.', 58],
    ],
  },
  {
    id: 'chat-edificaciones-andinas',
    contacto: { nombre: 'Sergio Londoño', empresa: 'Edificaciones Andinas', telefono: '+57 313 000 1902' },
    estado: 'open',
    asignado: YO,
    botPausado: true,
    noLeidos: 0,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Edificaciones Andinas S.A.',
      nit: '800.000.190-2',
      vendedor: 'u-julian',
      contacto: ['Sergio', 'Londoño'],
      oportunidades: [{ nombre: 'Colegio San Gabriel · baterías', etapa: 'listo_para_cotizar', valor: 58_300_000 }],
    },
    mensajes: [
      ['cliente', 'Laura, necesitamos la ficha técnica del orinal ahorrador.', 140],
      ['u-laura', 'Claro, Sergio. Te la mando en un rato con la cotización del colegio.', 120],
    ],
  },
  {
    id: 'chat-santa-lucia',
    contacto: { nombre: 'Marcela Torres', empresa: 'Grupo Constructor Santa Lucía', telefono: '+57 314 000 6618' },
    estado: 'pending',
    asignado: 'u-julian',
    botPausado: true,
    resumen: 'Pausado: espera la visita de obra del jueves.',
    noLeidos: 0,
    enlace: { estado: 'varios', detalle: 'El teléfono está en dos contactos de ECOVIT: Marcela Torres y Compras Santa Lucía.' },
    mensajes: [
      ['cliente', '¿Pueden venir a la obra el jueves a revisar los puntos hidráulicos?', 26 * 60],
      ['u-julian', 'Sí, Marcela. El jueves a las 9 a. m. estoy allá.', 25 * 60],
    ],
  },
  {
    id: 'chat-habitat-cafetero',
    contacto: { nombre: 'Luisa Fernanda Gil', empresa: 'Hábitat Cafetero', telefono: '+57 316 000 3374' },
    estado: 'open',
    asignado: null,
    botPausado: false,
    noLeidos: 1,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Hábitat Cafetero S.A.S.',
      nit: '901.000.337-4',
      vendedor: null,
      contacto: ['Luisa Fernanda', 'Gil'],
      oportunidades: [],
    },
    mensajes: [
      ['cliente', '¿Cuánto se demora un despacho a Manizales?', 18],
    ],
  },
  {
    id: 'chat-numero-nuevo',
    contacto: { nombre: null, empresa: null, telefono: '+57 315 000 4821' },
    estado: 'open',
    asignado: null,
    botPausado: false,
    noLeidos: 1,
    enlace: { estado: 'sin_contacto' },
    mensajes: [
      ['cliente', 'Hola, vi su catálogo en Instagram. ¿Venden al detal?', 2],
    ],
  },
  {
    id: 'chat-sabana-norte',
    contacto: { nombre: 'Jorge Patiño', empresa: 'Proyectos Sabana Norte', telefono: '+57 317 000 8845' },
    estado: 'closed',
    asignado: 'u-paula',
    botPausado: true,
    noLeidos: 0,
    enlace: { estado: 'enlazado' },
    ecovit: {
      cliente: 'Proyectos Sabana Norte S.A.S.',
      nit: '900.000.884-5',
      vendedor: 'u-paula',
      contacto: ['Jorge', 'Patiño'],
      oportunidades: [],
    },
    mensajes: [
      ['u-paula', 'Jorge, ya quedó facturado el pedido de Cajicá. ¡Gracias!', 3 * 24 * 60],
      ['cliente', 'Perfecto, gracias Paula.', 3 * 24 * 60 - 20],
    ],
  },
  {
    id: 'chat-ferreteria',
    contacto: { nombre: 'Camilo Duarte', empresa: 'Ferretería El Constructor', telefono: '+57 318 000 0927' },
    estado: 'closed',
    asignado: 'u-andres',
    botPausado: true,
    noLeidos: 0,
    enlace: { estado: 'telefono_invalido', detalle: 'El teléfono guardado en ECOVIT no tiene indicativo.' },
    mensajes: [
      ['cliente', 'Recibido el pedido, todo completo.', 6 * 24 * 60],
    ],
  },
]

/** La base en memoria. Se arma una vez por pestaña; recargar la deja como nueva. */
export function crearBase(ahora = Date.now()): Record<string, Fila[]> {
  const hace = (min: number) => new Date(ahora - min * MIN).toISOString()

  const profiles: Fila[] = EQUIPO.map((p) => ({
    id: `prof-${p.user_id}`,
    user_id: p.user_id,
    perfil_id: p.perfil_id,
    full_name: p.nombre,
    email: p.correo,
    avatar_url: null,
    role: p.rol,
    beta_features: [],
    account_id: CUENTA_ID,
    account_role: p.rol,
  }))

  const member_presence: Fila[] = EQUIPO.filter((p) => p.presencia).map((p) => ({
    account_id: CUENTA_ID,
    user_id: p.user_id,
    status: p.presencia,
    last_seen_at: hace(p.presencia === 'online' ? 0 : 25),
  }))

  const contacts: Fila[] = []
  const conversations: Fila[] = []
  const messages: Fila[] = []
  const clientes: Record<string, unknown> = {}

  CHATS.forEach((c, i) => {
    const contactId = `contacto-${c.id}`
    const contacto = {
      id: contactId,
      user_id: YO,
      account_id: CUENTA_ID,
      phone: c.contacto.telefono,
      name: c.contacto.nombre ?? undefined,
      company: c.contacto.empresa ?? undefined,
      created_at: hace(40 * 24 * 60 + i),
      updated_at: hace(60),
      telefono_e164: c.contacto.telefono.replace(/\s/g, ''),
      enlace_estado: c.enlace.estado,
      enlace_detalle: c.enlace.detalle ?? null,
      cliente_id: c.ecovit ? `cliente-${c.id}` : null,
      contact_tags: [],
    }
    contacts.push(contacto)

    c.mensajes.forEach(([quien, texto, min], j) => {
      const esCliente = quien === 'cliente'
      const esBot = quien === 'bot' || quien === 'ia'
      messages.push({
        id: `${c.id}-m${String(j + 1).padStart(2, '0')}`,
        conversation_id: c.id,
        sender_type: esCliente ? 'customer' : esBot ? 'bot' : 'agent',
        sender_id: esCliente || esBot ? null : quien,
        content_type: 'text',
        content_text: texto,
        status: esCliente ? 'delivered' : 'read',
        created_at: hace(min),
        // El bot real marca ai_generated también en los textos fijos (T5, T9).
        ai_generated: esBot,
      })
    })

    const ultimo = c.mensajes[c.mensajes.length - 1]
    const ultimoCliente = [...c.mensajes].reverse().find((m) => m[0] === 'cliente')
    const ultimoNuestro = [...c.mensajes].reverse().find((m) => m[0] !== 'cliente')
    conversations.push({
      id: c.id,
      user_id: YO,
      account_id: CUENTA_ID,
      contact_id: contactId,
      status: c.estado,
      assigned_agent_id: c.asignado,
      actualizado_en: hace(ultimo[2]),
      last_message_text: ultimo[1],
      last_message_at: hace(ultimo[2]),
      unread_count: c.noLeidos,
      last_inbound_at: ultimoCliente ? hace(ultimoCliente[2]) : null,
      last_reply_at: ultimoNuestro ? hace(ultimoNuestro[2]) : null,
      closed_at: c.estado === 'closed' ? hace(ultimo[2]) : null,
      created_at: hace(c.mensajes[0][2] + 1),
      updated_at: hace(ultimo[2]),
      ai_autoreply_disabled: c.botPausado,
      ai_reply_count: c.mensajes.filter((m) => m[0] === 'bot' || m[0] === 'ia').length,
      ai_handoff_summary: c.resumen ?? null,
      contact: contacto,
    })

    if (c.ecovit) {
      clientes[c.id] = {
        cliente: {
          id: `cliente-${c.id}`,
          nombre: c.ecovit.cliente,
          nit: c.ecovit.nit,
          vendedor_id: c.ecovit.vendedor ? `p-${c.ecovit.vendedor.slice(2)}` : null,
          vendedor_nombre: nombreDe(c.ecovit.vendedor),
        },
        contacto: { id: `ct-${c.id}`, nombre: c.ecovit.contacto[0], apellido: c.ecovit.contacto[1] },
        oportunidades: c.ecovit.oportunidades.map((o, k) => ({
          id: `op-${c.id}-${k}`,
          nombre: o.nombre,
          etapa: o.etapa,
          valor_proyectado: o.valor,
        })),
      }
    }
  })

  return {
    profiles,
    accounts: [{ id: CUENTA_ID, name: 'ECOVIT (demostración)', default_currency: 'COP' }],
    member_presence,
    contacts,
    conversations,
    messages,
    // `cliente_de_conversacion` por id de conversación (una fila con todo).
    _clientes: [clientes],
  }
}

/** Lo que devuelve `GET /api/ai/usage` para una ventana de `dias`. */
export function usoIa(dias: number, ahora = Date.now()) {
  // Serie fija y creíble: más uso entre semana, nada los domingos.
  const daily = Array.from({ length: dias }, (_, i) => {
    const fecha = new Date(ahora - (dias - 1 - i) * DIA)
    const domingo = fecha.getDay() === 0
    const base = domingo ? 0 : 18 + ((i * 7 + 3) % 11)
    const calls = base
    const tokens = calls * (2300 + ((i * 131) % 900))
    return {
      date: fecha.toISOString().slice(0, 10),
      calls,
      tokens,
      usd: Math.round(tokens * 0.0000054 * 10_000) / 10_000,
    }
  })
  const calls = daily.reduce((s, d) => s + d.calls, 0)
  const tokens = daily.reduce((s, d) => s + d.tokens, 0)
  const usd = Math.round(daily.reduce((s, d) => s + d.usd, 0) * 100) / 100
  const prompt = Math.round(tokens * 0.82)
  const autoCalls = Math.round(calls * 0.86)
  const autoTokens = Math.round(tokens * 0.88)

  // El mes de Bogotá en curso: lo único que se compara con el tope.
  const bogota = new Date(ahora - 5 * HORA)
  const diaDelMes = bogota.getUTCDate()
  const mes = bogota.toISOString().slice(0, 7)
  const gastoMes = Math.round(diaDelMes * 0.41 * 100) / 100

  const porChat = [
    ['chat-altos-del-rio', 0.4312, 14],
    ['chat-monteverde', 0.2875, 9],
    ['chat-habitat-cafetero', 0.1934, 6],
    ['chat-la-pradera', 0.1207, 4],
    ['chat-numero-nuevo', 0.0618, 2],
  ] as const

  return {
    window_days: dias,
    truncated: false,
    totals: { calls, prompt_tokens: prompt, completion_tokens: tokens - prompt, total_tokens: tokens },
    by_mode: {
      auto_reply: { calls: autoCalls, tokens: autoTokens },
      draft: { calls: calls - autoCalls, tokens: tokens - autoTokens },
    },
    by_model: [
      { model: 'claude-sonnet-5-5', provider: 'anthropic', calls: autoCalls, tokens: autoTokens },
      { model: 'claude-haiku-4-5', provider: 'anthropic', calls: calls - autoCalls, tokens: tokens - autoTokens },
    ],
    daily,
    gasto: {
      total_usd: usd,
      sin_costo: 0,
      por_chat: porChat.map(([conversation_id, factor, llamadas]) => ({
        conversation_id,
        usd: Math.round(usd * factor * 10_000) / 10_000,
        llamadas: Math.max(1, Math.round((llamadas * dias) / 30)),
      })),
      tope_usd_mes: 25,
      mes,
      gasto_mes_usd: gastoMes,
    },
  }
}

export const CONFIG_IA = {
  configured: true,
  has_key: true,
  has_embeddings_key: false,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  is_active: true,
  auto_reply_enabled: true,
  system_prompt: 'Eres el asistente de ECOVIT. Respondes sobre el catálogo con precios de lista.',
  temperature: 0.3,
  max_reply_per_conversation: 8,
}
