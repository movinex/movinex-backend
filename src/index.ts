import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PersistenceService } from './persistenceService';
import { VerificamexService } from './verificamexService';
import { ConektaService } from './conektaService';
import { StripeService } from './stripeService';
import { CobrosSemanalesService } from './cobrosSemanalesService';
import { SkydropxService } from './skydropxService';
import { EntregasService } from './entregasService';
import { AcompanamientoService } from './acompanamientoService';
import { WhatsappOtpService } from './whatsappOtpService';
import { verifyConektaSignature, generateMdmCommandToken } from './security';
import { SuperadminService } from './superadminService';
import { requireAdminAuth } from './adminAuth';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10500;
const CONEKTA_PUBLIC_KEY = process.env.CONEKTA_PUBLIC_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_WEBHOOK_SECRET_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST || '';
const MDM_JWT_SECRET = process.env.MDM_JWT_SECRET || 'supersecretmdmjwtkey';
// URL pública de este mismo backend — la necesita Verificamex para poder llamarnos de
// vuelta con el resultado de la VerificationSession (no hay un req.headers.origin
// utilizable ahí, a diferencia del checkout de Stripe que sí lo arma desde el navegador).
const BACKEND_URL = process.env.BACKEND_URL || 'https://movinex-backend-production.up.railway.app';

// Medido contra Railway el 2026-08-16 (no asumido): la cadena que llega a la app es
// siempre `X-Forwarded-For: <IP real del cliente>, <IP interna de Railway>` — dos
// saltos — y Railway **descarta** el X-Forwarded-For que mande el cliente antes de
// armarla (se probó enviando uno falso: nunca aparece). O sea que acá la IP no se
// puede falsificar, y por eso hay que saltear 2 hops para quedarse con la del cliente.
//
// Con `1` se tomaba la IP interna de Railway, que **rota** entre .193 y .194: el rate
// limit contaba cada IP por separado y hacía falta el doble de intentos para bloquear,
// además de registrar en el log una IP inútil para investigar. Con `enable('trust
// proxy')` (confiar en todos) la IP salía bien, pero express-rate-limit lo marcaba como
// inseguro (ERR_ERL_PERMISSIVE_TRUST_PROXY) porque en otro hosting sí sería falsificable.
app.set('trust proxy', 2);

// DDoS Protection: Limitador de tasa (Rate Limiting)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  // Un cliente consume ~15 requests en el flujo completo (OTP, progreso de cada foto,
  // resumen, finalizar, checkout). Las operadoras móviles mexicanas hacen NAT, así que
  // muchos clientes reales comparten IP: con el límite viejo de 100 alcanzaban ~7
  // compradores simultáneos por operadora para empezar a bloquear ventas legítimas.
  max: 500,
  standardHeaders: true, // Retorna info de límites en las cabeceras `RateLimit-*`
  legacyHeaders: false, // Desactiva cabeceras antiguas `X-RateLimit-*`
  message: {
    success: false,
    message: 'Demasiadas solicitudes desde esta IP, por favor intenta de nuevo en 15 minutos.'
  }
});

// Límite propio y mucho más estricto para el login del panel: el global de 500 está
// pensado para el flujo de compra (un cliente consume ~15 requests), pero aplicado a un
// login son 500 intentos de contraseña por ventana. Acá cuentan solo los intentos
// fallidos (skipSuccessfulRequests), así que un admin que entra bien nunca se topa con
// el límite, y quien prueba contraseñas se queda sin margen enseguida.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados intentos de inicio de sesión. Espera 15 minutos e intenta de nuevo.'
  }
});

// Middleware de seguridad y parseo
app.use(helmet());
const ALLOWED_ORIGINS = [
  'https://www.movinex.mx',
  'https://movinex.mx',
  'http://localhost:10173',
  'http://localhost:50002',
];
app.use(cors({
  origin: ALLOWED_ORIGINS,
}));
// El webhook de Stripe queda fuera del rate limit: lo llama Stripe, no un navegador, y
// una ráfaga de eventos (varios pagos juntos) no debe recibir 429 — es la fuente de
// verdad del cobro.
app.use('/api/', (req: Request, res: Response, next) => {
  if (req.path.startsWith('/webhooks/')) return next();
  return apiLimiter(req, res, next);
});

// El webhook de Stripe necesita el body crudo (bytes exactos) para verificar la firma
// con stripe.webhooks.constructEvent — por eso se excluye del parser JSON global y usa
// su propio middleware express.raw() más abajo, en la propia ruta.
app.use((req: Request, res: Response, next) => {
  if (req.originalUrl === '/api/webhooks/stripe') {
    next();
  } else {
    express.json({ limit: '50mb' })(req, res, next);
  }
});

// Endpoint de verificación de salud
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// GET: Playground interactivo para simular cobro de enganches
app.get('/playground', (req: Request, res: Response) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Movinex - Simulador de Pagos (Conekta)</title>
      <style>
        body { font-family: sans-serif; background: #0f172a; color: #f1f5f9; padding: 40px; }
        .card { background: #1e293b; padding: 24px; border-radius: 12px; max-width: 600px; margin: auto; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
        h1 { color: #38bdf8; margin-top: 0; }
        input, button { width: 100%; padding: 12px; margin: 10px 0; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; }
        button { background: #0284c7; cursor: pointer; border: none; font-weight: bold; }
        button:hover { background: #0369a1; }
        #logs { background: #020617; padding: 15px; border-radius: 6px; font-family: monospace; height: 150px; overflow-y: auto; color: #a7f3d0; margin-top: 20px; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>⚡ Movinex Backend Playground</h1>
        <p>Esta herramienta permite simular la confirmación de pago (Webhook order.paid) para pruebas rápidas.</p>
        
        <label>Contacto del Cliente (Email o Celular):</label>
        <input type="text" id="contacto" placeholder="ejemplo@correo.com o 5512345678" required>
        
        <label>Monto de Pago Simulado ($ MXN):</label>
        <input type="number" id="monto" value="375">

        <label>Conekta Customer ID (opcional — para probar la suscripción semanal automática):</label>
        <input type="text" id="customerId" placeholder="cus_xxxxxxxxxxxx">

        <button onclick="enviarPago()">Simular Pago Exitoso (order.paid)</button>
        
        <div id="logs">Consola del simulador...</div>
      </div>

      <script>
        async function enviarPago() {
          const contacto = document.getElementById('contacto').value.trim();
          const monto = document.getElementById('monto').value;
          const customerId = document.getElementById('customerId').value.trim();
          const logs = document.getElementById('logs');

          if(!contacto) {
            alert('Ingresa el email o celular del cliente.');
            return;
          }

          logs.innerHTML += '\\n[Simulador] Desencadenando webhook order.paid...';

          try {
            const customerInfo = {
              name: 'Cliente Simulador',
              email: contacto.includes('@') ? contacto : 'simulado@movinex.mx',
              phone: !contacto.includes('@') ? contacto : '5500000000'
            };
            if (customerId) customerInfo.customer_id = customerId;

            const res = await fetch('/api/webhooks/conekta', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'order.paid',
                data: {
                  object: {
                    id: 'ord_simulated_' + Math.floor(Math.random() * 100000),
                    amount: parseFloat(monto) * 100,
                    customer_info: customerInfo
                  }
                }
              })
            });
            const data = await res.json();
            logs.innerHTML += '\\n[Respuesta Servidor] ' + JSON.stringify(data);
          } catch(err) {
            logs.innerHTML += '\\n[Error] ' + err.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Configuración dinámica de Swagger para listar y probar los Endpoints de la API
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Movinex Core API',
      version: '1.0.0',
      description: 'Documentación interactiva de endpoints para integraciones (Conekta, Verificamex, Upya, MDM)',
    },
    servers: [
      {
        url: 'https://movinex-backend-production.up.railway.app',
        description: 'Servidor de Producción en Railway'
      },
      {
        url: 'http://localhost:5000',
        description: 'Entorno de Desarrollo Local'
      }
    ],
  },
  apis: ['./src/index.ts', './dist/index.js'] // Soporte para TypeScript y JS compilado
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve as any, swaggerUi.setup(swaggerSpec) as any);



/**
 * @swagger
 * /api/solicitudes:
 *   get:
 *     summary: Obtener todas las solicitudes para el Backoffice
 *     responses:
 *       200:
 *         description: Lista de solicitudes crediticias registradas.
 */
app.get('/api/solicitudes', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const solicitudes = await PersistenceService.getSolicitudes();
    return res.status(200).json(solicitudes);
  } catch (error: any) {
    console.error('Error al obtener solicitudes:', error);
    return res.status(500).json({ error: error.message || 'Error al obtener solicitudes.' });
  }
});

/**
 * @swagger
 * /api/solicitudes/estatus:
 *   get:
 *     summary: Consultar únicamente si el pago del enganche ya fue confirmado (uso público, sin datos sensibles)
 *     parameters:
 *       - in: query
 *         name: celular
 *         schema:
 *           type: string
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Estatus de pago de la solicitud más reciente que coincide con el contacto.
 */
app.get('/api/solicitudes/estatus', async (req: Request, res: Response) => {
  try {
    const contacto = (req.query.celular || req.query.email) as string | undefined;
    if (!contacto) {
      return res.status(400).json({ error: 'Se requiere celular o email.' });
    }

    const solicitud = await PersistenceService.getEstatusPagoByContacto(contacto);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    return res.status(200).json({
      id: solicitud.id,
      pagoConfirmado: solicitud.pago_confirmado === true
    });
  } catch (error: any) {
    console.error('Error al consultar estatus de pago:', error);
    return res.status(500).json({ error: error.message || 'Error al consultar estatus de pago.' });
  }
});

/**
 * @swagger
 * /api/celulares:
 *   get:
 *     summary: Obtener catálogo de celulares desde Supabase
 *     responses:
 *       200:
 *         description: Catálogo completo de teléfonos móviles de la tienda.
 */
app.get('/api/celulares', async (req: Request, res: Response) => {
  try {
    const celulares = await PersistenceService.getCelulares();
    return res.status(200).json(celulares);
  } catch (error: any) {
    console.error('Error al obtener celulares:', error);
    return res.status(500).json({ error: error.message || 'Error al obtener celulares.' });
  }
});

// Una celda de CSV: se entrecomilla solo si hace falta (coma, comilla o salto de línea),
// mismo criterio que toCSV en el frontend (lib/csv.ts) — así el archivo abre bien tanto
// en Excel como en el validador de feeds de Meta.
function celdaCSV(valor: string | number | null | undefined): string {
  const texto = valor == null ? '' : String(valor);
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * Feed de catálogo para Meta Commerce Manager (Orígenes de datos → Archivo de datos),
 * reemplaza la carga manual producto por producto. Spec de campos:
 * https://www.facebook.com/business/help/120325381656392 — se arma en vivo desde
 * `celulares`, no hay ninguna tabla ni caché nueva. Público y sin auth a propósito: Meta
 * tiene que poder pedirlo solo, con su propio refresco programado (recomendado: diario).
 */
app.get('/feed/meta-catalogo.csv', async (req: Request, res: Response) => {
  try {
    const celulares = await PersistenceService.getCelulares();

    const columnas = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'brand'];
    const filas = celulares.map((c: any) => {
      // Las specs se cargan a mano en el catálogo y algunas traen tabs/espacios de más
      // pegados del Excel de origen — se normalizan acá, no se tocan en la base.
      const descripcion = [c.specs_ram_almacenamiento, c.specs_pantalla, c.specs_camara_trasera, c.specs_bateria]
        .map((s) => (s ? String(s).replace(/\s+/g, ' ').trim() : s))
        .filter(Boolean)
        .join(' · ') || `${c.marca || ''} ${c.modelo}`.trim();

      return [
        c.id,
        `${c.marca ? c.marca + ' ' : ''}${c.modelo}`,
        descripcion,
        // Sin contador de inventario por modelo hoy: se pide bajo demanda, así que
        // siempre está disponible para financiar. Si eso cambia, acá es donde se lee
        // el stock real.
        'in stock',
        'new',
        `${Number(c.precio_base).toFixed(2)} MXN`,
        c.precio_descuento ? `${Number(c.precio_descuento).toFixed(2)} MXN` : '',
        // El id de celulares es texto libre cargado a mano (no un UUID) — algunos
        // llevan espacios ("Motorola E15"), así que hay que codificarlo para la URL.
        `${ALLOWED_ORIGINS[0]}/cotizar/${encodeURIComponent(c.id)}`,
        c.imagen_url || c.imagen || '',
        c.marca || ''
      ].map(celdaCSV).join(',');
    });

    const csv = [columnas.join(','), ...filas].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // Nombre fijo: si Meta llega a cachear por nombre de archivo, que no cambie entre
    // corridas — el contenido sí se refresca en cada pedido, no el nombre.
    res.setHeader('Content-Disposition', 'inline; filename="meta-catalogo.csv"');
    return res.status(200).send(csv);
  } catch (error: any) {
    console.error('Error al generar el feed de Meta:', error);
    return res.status(500).send('No se pudo generar el feed.');
  }
});

/**
 * @swagger
 * /api/solicitudes:
 *   post:
 *     summary: Crear solicitud de crédito de manera segura
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - cliente
 *               - celular
 *               - email
 *               - modelo
 *               - enganche
 *             properties:
 *               cliente:
 *                 type: string
 *               celular:
 *                 type: string
 *               email:
 *                 type: string
 *               modelo:
 *                 type: string
 *               enganche:
 *                 type: number
 *     responses:
 *       201:
 *         description: Solicitud creada con éxito y link de checkout generado.
 */
app.post('/api/solicitudes', async (req: Request, res: Response) => {
  try {
    const { celular, email } = req.body;
    let cliente = req.body.cliente || 'Pendiente de verificación';
    let curp: string | null = null;

    // Gate anti-bot: no aceptar la solicitud si este celular no verificó su OTP de
    // WhatsApp hace poco. Se valida server-side (no solo en el frontend) para que no
    // se pueda saltear pegándole directo a este endpoint.
    const otpVerificado = await PersistenceService.getOtpVerificado(celular);
    if (!otpVerificado) {
      return res.status(400).json({ error: 'Verifica tu número de WhatsApp antes de continuar.' });
    }

    console.log(`[Backend] Procesando nueva solicitud para: ${cliente} (${celular})`);

    // 1. Validar el teléfono usando Verificamex
    const kycResult = await VerificamexService.validarTelefono(celular);

    // 1b. Realizar la validación biométrica facial (INE vs Selfie) real usando Verificamex
    let biometricResult = { valido: true, score: 1 };
    if (req.body.ine_frente && req.body.selfie) {
      biometricResult = await VerificamexService.validarIdentidadBiometrica(req.body.ine_frente, req.body.selfie, email);
    }

    // 1c. Leer nombre y CURP reales del frente del INE por OCR (Verificamex)
    let ocrCompleto = true; // en modo mock (sin email "real") no exigimos OCR — ver abajo
    if (req.body.ine_frente) {
      const datosIne = await VerificamexService.leerDatosINE(req.body.ine_frente, email);
      if (datosIne.nombre) cliente = datosIne.nombre;
      curp = datosIne.curp;
      // Si la llamada fue real (no simulada) y no devolvió nombre y CURP, la foto salió
      // demasiado mala para leerla — no hay forma de confiar en la identidad del cliente,
      // así que no se aprueba automático aunque el biométrico haya dado match.
      if (!datosIne.rawData?.mock) {
        ocrCompleto = Boolean(datosIne.nombre) && Boolean(datosIne.curp);
      }
    }

    // Se aprueba de inmediato solo si el teléfono, el biométrico Y la lectura del INE
    // salieron bien — cualquiera de los tres puede tumbar la aprobación automática.
    const esSolicitudValida = kycResult.valido && biometricResult.valido && ocrCompleto;
    const estatusInicial = esSolicitudValida ? 'Aprobado' : 'Pendiente';

    // 2. Si no es autorizado, enviar alerta por email a desarrollo@movinex.mx (simulado por consola en backend)
    if (!esSolicitudValida) {
      console.warn(`[ALERTA DE RIESGO] Envío de alerta a desarrollo@movinex.mx: El cliente ${cliente} con teléfono ${celular} no fue autorizado automáticamente por Verificamex (Teléfono: ${kycResult.valido ? 'OK' : 'RECHAZADO'}, Biometría: ${biometricResult.valido ? 'OK' : 'RECHAZADO'}, Lectura INE: ${ocrCompleto ? 'OK' : 'INCOMPLETA/ILEGIBLE'}).`);
    }

    // 3. El link de pago real se genera después, en POST /:id/crear-orden-enganche
    // (Stripe Checkout Session), una vez que el frontend confirma que el cliente
    // quiere pagar. Este campo queda vacío a propósito — nunca lo consumió el frontend.
    const checkoutUrl = '';

    // 3b. Subir INE/selfie al bucket privado (ya no se guarda el base64 en la fila)
    const [ineFrentePath, ineReversoPath, selfiePath] = await Promise.all([
      req.body.ine_frente ? PersistenceService.subirDocumentoKYC(req.body.ine_frente, 'ine_frente') : Promise.resolve(req.body.ine_frente),
      req.body.ine_reverso ? PersistenceService.subirDocumentoKYC(req.body.ine_reverso, 'ine_reverso') : Promise.resolve(req.body.ine_reverso),
      req.body.selfie ? PersistenceService.subirDocumentoKYC(req.body.selfie, 'selfie') : Promise.resolve(req.body.selfie)
    ]);

    // 4. Guardar en base de datos con el estatus dictaminado y la URL de pago
    const solicitud = await PersistenceService.saveSolicitud({
      ...req.body,
      cliente,
      curp,
      ine_frente: ineFrentePath,
      ine_reverso: ineReversoPath,
      selfie: selfiePath,
      estatus: estatusInicial,
      checkout_url: checkoutUrl
    });

    // Adopta el mensaje de OTP (mandado antes de que esta solicitud existiera) — ver
    // vincularMensajesPendientes.
    await PersistenceService.vincularMensajesPendientes(celular, solicitud.id);

    return res.status(201).json({
      success: true,
      message: kycResult.valido 
        ? 'Solicitud de crédito aprobada y registrada con éxito.' 
        : 'Solicitud registrada. Requiere verificación adicional.',
      solicitud,
      checkoutUrl
    });
  } catch (error: any) {
    console.error('Error procesando solicitud:', error);
    return res.status(500).json({ error: error.message || 'Ocurrió un error inesperado al procesar la solicitud.' });
  }
});

// POST: Crea la solicitud apenas se verifica el OTP (antes de pedir email/INE/selfie),
// para no perder el lead si el cliente se cae del formulario a mitad de camino. El resto
// de los campos se completan después sobre esta misma fila vía PATCH /:id/progreso y
// POST /:id/finalizar — no se vuelve a insertar.
app.post('/api/solicitudes/iniciar', async (req: Request, res: Response) => {
  try {
    const { celular, modelo, enganche, semanas, pago_semanal, costoEnvio } = req.body;

    const otpVerificado = await PersistenceService.getOtpVerificado(celular);
    if (!otpVerificado) {
      return res.status(400).json({ error: 'Verifica tu número de WhatsApp antes de continuar.' });
    }

    const solicitud = await PersistenceService.crearSolicitudIniciada({
      celular,
      modelo,
      enganche,
      semanas,
      pago_semanal,
      costo_envio: costoEnvio
    });

    // Adopta el mensaje de OTP (mandado antes de que esta solicitud existiera) — ver
    // vincularMensajesPendientes.
    await PersistenceService.vincularMensajesPendientes(celular, solicitud.id);

    console.log(`[Backend] Solicitud ${solicitud.id} iniciada (OTP verificado) para ${celular}, modelo ${modelo}.`);
    return res.status(201).json({ success: true, solicitud });
  } catch (error: any) {
    console.error('Error al iniciar la solicitud:', error);
    return res.status(500).json({ error: error.message || 'No se pudo iniciar la solicitud.' });
  }
});

// GET: Resumen público para reanudar una solicitud desde el link de la URL
// (?solicitud=X) si el cliente refresca o vuelve más tarde — mismo modelo de confianza
// que /domicilio: el UUID en la URL es la credencial. No devuelve las imágenes en sí,
// solo si ya están cargadas.
app.get('/api/solicitudes/:id/resumen', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    return res.status(200).json({
      id: solicitud.id,
      celular: solicitud.celular,
      email: solicitud.email,
      modelo: solicitud.modelo,
      enganche: solicitud.enganche,
      semanas: solicitud.semanas,
      pagoSemanal: solicitud.pago_semanal,
      costoEnvio: solicitud.costo_envio,
      estatus: solicitud.estatus,
      pagoConfirmado: solicitud.pago_confirmado === true,
      // Pasos 3-4 (para poder resumir/prellenar el formulario si el cliente refresca).
      nombre: solicitud.nombre,
      apellidos: solicitud.apellidos,
      curp: solicitud.curp,
      fechaNacimiento: solicitud.fecha_nacimiento,
      genero: solicitud.genero,
      estadoCivil: solicitud.estado_civil,
      dependientesEconomicos: solicitud.dependientes_economicos,
      nivelEstudios: solicitud.nivel_estudios,
      calle: solicitud.calle,
      numeroExterior: solicitud.numero_exterior,
      numeroInterior: solicitud.numero_interior,
      codigoPostal: solicitud.codigo_postal,
      colonia: solicitud.colonia,
      alcaldiaMunicipio: solicitud.alcaldia_municipio,
      estado: solicitud.estado,
      aceptaTerminos: solicitud.acepta_terminos === true,
      // Paso 7: estado de la VerificationSession en vivo, para que /verificacion pueda
      // hacer polling hasta tener una respuesta definitiva en vez de un timeout optimista.
      verificamexStatus: solicitud.verificamex_status || null,
      verificamexIntentos: Number(solicitud.verificamex_intentos || 0),
      // null = todavía no se corrió esa verificación; false = corrió y no pasó — se
      // mantiene por compatibilidad con filas viejas del flujo anterior.
      ocrOk: solicitud.ocr_ok,
      biometricoOk: solicitud.biometrico_ok
    });
  } catch (error: any) {
    console.error('Error al obtener el resumen de la solicitud:', error);
    return res.status(500).json({ error: 'No se pudo obtener la solicitud.' });
  }
});

// PATCH: Guarda los datos del paso 3 (Datos del cliente) + email apenas el cliente los
// completa. Ya NO recibe fotos de INE/selfie — la verificación de identidad se mudó al
// paso 7 (VerificationSession en vivo de Verificamex, ver /crear-sesion-verificamex),
// así que este endpoint quedó puramente de guardado de texto, sin llamar a Verificamex.
app.patch('/api/solicitudes/:id/progreso', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email, nombre, apellidos, fecha_nacimiento, curp, genero, estado_civil, dependientes_economicos, nivel_estudios } = req.body;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const campos: Parameters<typeof PersistenceService.guardarProgresoSolicitud>[1] = {};
    if (email !== undefined) campos.email = email;
    if (nombre !== undefined) campos.nombre = nombre;
    if (apellidos !== undefined) campos.apellidos = apellidos;
    // "cliente" (nombre completo, ya usado en todo el admin) se arma acá solo cuando
    // llegan ambas mitades juntas — el frontend manda el paso 3 entero en un solo PATCH.
    if (nombre !== undefined && apellidos !== undefined) {
      campos.cliente = `${nombre} ${apellidos}`.trim();
    }
    if (fecha_nacimiento !== undefined) campos.fecha_nacimiento = fecha_nacimiento;
    if (curp !== undefined) campos.curp = curp;
    if (genero !== undefined) campos.genero = genero;
    if (estado_civil !== undefined) campos.estado_civil = estado_civil;
    if (dependientes_economicos !== undefined) campos.dependientes_economicos = Number(dependientes_economicos);
    if (nivel_estudios !== undefined) campos.nivel_estudios = nivel_estudios;

    const solicitudActualizada = await PersistenceService.guardarProgresoSolicitud(id, campos);
    return res.status(200).json({ success: true, solicitud: solicitudActualizada });
  } catch (error: any) {
    console.error('Error al guardar el progreso de la solicitud:', error);
    return res.status(500).json({ error: error.message || 'No se pudo guardar el progreso.' });
  }
});

// Verificación aprobada (FINISHED, auto o admin manual) — arma el envío real en
// Skydropx con la dirección ya guardada en el paso 4 y avisa por WhatsApp. Compartida
// entre el webhook de Verificamex y el PATCH manual del admin, para no repetir la
// lógica de "aprobar + disparar Skydropx" en dos lugares.
async function aprobarYActivarEnvio(solicitud: any, verificamexResult?: number | null, verificamexComments?: string | null, verificamexErrores?: any[] | null) {
  // Compare-and-swap: si devuelve null es que otro camino (webhook o polling) ya la
  // aprobó, y seguir de largo generaría una segunda guía de Skydropx por el mismo envío.
  const aprobada = await PersistenceService.aprobarVerificacion(solicitud.id, verificamexResult, verificamexComments, verificamexErrores);
  if (!aprobada) {
    console.log(`[Verificación] La solicitud ${solicitud.id} ya había sido aprobada por otro camino — no se vuelve a generar el envío.`);
    return;
  }

  try {
    await WhatsappOtpService.enviarVerificacionAprobada(solicitud.id, solicitud.celular, solicitud.cliente, solicitud.modelo);
  } catch (whatsappError: any) {
    console.error(`[Verificación] No se pudo avisar la aprobación por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
  }

  SkydropxService.crearEnvio(
    solicitud.cliente,
    solicitud.celular,
    solicitud.email,
    {
      calle: solicitud.calle,
      numeroExterior: solicitud.numero_exterior,
      numeroInterior: solicitud.numero_interior,
      colonia: solicitud.colonia,
      alcaldiaMunicipio: solicitud.alcaldia_municipio,
      estado: solicitud.estado,
      codigoPostal: solicitud.codigo_postal
    },
    solicitud.modelo
  )
    .then(async ({ trackingNumber, labelUrl, shipmentId, carrier, simulado }) => {
      if (simulado) {
        // No guardar un tracking falso — se veía indistinguible de uno real en el
        // panel (caso real 2026-08-18: la guía nunca se generó y nadie lo notó hasta
        // que el cliente reclamó). Se deja tracking_number/shipment_id vacíos para que
        // la solicitud quede visiblemente sin guía hasta que alguien la regenere.
        console.error(`[Skydropx] FALLÓ la generación real de la guía para la solicitud ${solicitud.id} — no se guardó ningún tracking, requiere atención manual.`);
        return;
      }
      await PersistenceService.guardarEnvio(solicitud.id, { tracking_number: trackingNumber, label_url: labelUrl, skydropx_carrier: carrier, skydropx_shipment_id: shipmentId });
      console.log(`[Skydropx] Guía generada en segundo plano para la solicitud ${solicitud.id}: ${trackingNumber}`);
    })
    .catch((skydropxError: any) => {
      console.error(`[Skydropx] No se pudo generar la guía en segundo plano para la solicitud ${solicitud.id}:`, skydropxError.message);
    });
}

// Paso 7: crea (o recrea, para un reintento) la VerificationSession en vivo de
// Verificamex y devuelve la URL hosteada a la que el frontend redirige — mismo patrón
// que crear-orden-enganche con Stripe. Se llama tanto para el primer intento como para
// cada uno de los reintentos (hasta 3 en total).
app.post('/api/solicitudes/:id/crear-sesion-verificamex', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }
    if (!solicitud.pago_confirmado) {
      return res.status(409).json({ error: 'Esta solicitud todavía no pagó el enganche.' });
    }
    if (Number(solicitud.verificamex_intentos || 0) >= 3) {
      return res.status(409).json({ error: 'Se agotaron los intentos de verificación — tu solicitud está en revisión manual.' });
    }

    const origin = (req.headers.origin as string) || ALLOWED_ORIGINS[0];
    const redirectUrl = `${origin}/verificacion?solicitud=${id}&modelo=${encodeURIComponent(solicitud.modelo)}`;
    const webhookUrl = `${BACKEND_URL}/api/webhooks/verificamex`;

    const sesion = await VerificamexService.crearSesionVerificacion(id, solicitud.email, redirectUrl, webhookUrl);
    await PersistenceService.guardarSesionVerificamex(id, sesion.sessionId || `sin-id-${id}`);

    if (sesion.mock) {
      // No hay página hosteada real que mostrar en mock — se resuelve como aprobada al
      // toque, y el frontend redirige él mismo a redirectUrl para seguir el mismo camino.
      await aprobarYActivarEnvio(solicitud);
      return res.status(200).json({ success: true, mock: true, redirectUrl });
    }

    return res.status(200).json({ success: true, mock: false, formUrl: sesion.formUrl });
  } catch (error: any) {
    console.error('Error al crear la sesión de Verificamex:', error);
    return res.status(500).json({ error: error.message || 'No se pudo iniciar la verificación de identidad.' });
  }
});

// POST: Enviar código OTP por WhatsApp (paso previo al pago del enganche)
app.post('/api/otp/enviar', async (req: Request, res: Response) => {
  try {
    const { celular, solicitudId } = req.body;
    const digitos = celular ? String(celular).replace(/\D/g, '') : '';
    // Solo clientes mexicanos: 10 dígitos, sin código de país. La única excepción es
    // el número de pruebas del equipo (ver WhatsappOtpService.formatearNumero), que
    // también son 10 dígitos y entra por acá sin necesidad de un caso aparte.
    if (digitos.length !== 10) {
      return res.status(400).json({ error: 'Se requiere un celular mexicano de 10 dígitos.' });
    }

    const { mock } = await WhatsappOtpService.enviarCodigo(celular, solicitudId || undefined);
    return res.status(200).json({ success: true, mock });
  } catch (error: any) {
    console.error('Error al enviar OTP:', error);
    return res.status(500).json({ error: error.message || 'No se pudo enviar el código de verificación.' });
  }
});

// POST: Verificar código OTP enviado por WhatsApp
app.post('/api/otp/verificar', async (req: Request, res: Response) => {
  try {
    const { celular, codigo } = req.body;
    if (!celular || !codigo) {
      return res.status(400).json({ error: 'Se requieren celular y código.' });
    }

    const verificado = await WhatsappOtpService.verificarCodigo(celular, String(codigo));
    if (!verificado) {
      return res.status(400).json({ verificado: false, error: 'Código incorrecto o expirado.' });
    }

    return res.status(200).json({ verificado: true });
  } catch (error: any) {
    console.error('Error al verificar OTP:', error);
    return res.status(500).json({ error: error.message || 'No se pudo verificar el código.' });
  }
});

// POST: Crea una Checkout Session de Stripe para el enganche (página hosteada por
// Stripe). El frontend redirige al cliente a la `checkoutUrl` devuelta; el cliente
// paga ahí y Stripe lo regresa solo a success_url. La confirmación real del pago
// llega después por el webhook checkout.session.completed, no por este response.
app.post('/api/solicitudes/:id/crear-orden-enganche', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    // Gates server-side, no solo en la UI: este endpoint es público (el cliente llega
    // por deep link, sin sesión) así que el frontend no alcanza para impedir que una
    // solicitud rechazada/en revisión pague, ni que una ya pagada pague dos veces.
    if (solicitud.pago_confirmado) {
      return res.status(409).json({ error: 'Esta solicitud ya tiene el enganche pagado.' });
    }
    // Ya no exige "Aprobado" (eso era del flujo viejo, verificación antes de pagar) —
    // ahora se paga apenas se completan los pasos 1-5 (datos, dirección, 2do OTP+términos).
    if (solicitud.estatus !== 'Lista para pago') {
      return res.status(409).json({ error: 'Esta solicitud todavía no está lista para pagar.' });
    }

    const origin = (req.headers.origin as string) || ALLOWED_ORIGINS[0];
    // Ya no vuelve a /domicilio (la dirección se pidió antes de pagar, en el paso 4) —
    // ahora vuelve a la verificación de identidad en vivo (paso 7).
    const successUrl = `${origin}/verificacion?solicitud=${id}&modelo=${encodeURIComponent(solicitud.modelo)}`;
    const cancelUrl = `${origin}/`;

    const { sessionId, url } = await StripeService.crearCheckoutSession(
      id,
      solicitud.cliente,
      solicitud.email,
      solicitud.celular,
      solicitud.modelo,
      Number(solicitud.enganche),
      successUrl,
      cancelUrl,
      Number(solicitud.costo_envio || 0)
    );

    console.log(`[Stripe] Checkout session ${sessionId} creada para la solicitud ${id}, esperando pago.`);
    return res.status(200).json({ success: true, checkoutUrl: url });
  } catch (error: any) {
    console.error('Error al crear el checkout de Stripe:', error.message);
    return res.status(500).json({ error: error.message || 'Ocurrió un error al iniciar el pago del enganche.' });
  }
});

/**
 * @swagger
 * /api/solicitudes/{id}/domicilio:
 *   post:
 *     summary: Guardar el domicilio de envío tras el pago y generar la guía real en Skydropx
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - calle
 *               - numero_exterior
 *               - colonia
 *               - alcaldia_municipio
 *               - estado
 *               - codigo_postal
 *             properties:
 *               calle:
 *                 type: string
 *               numero_exterior:
 *                 type: string
 *               numero_interior:
 *                 type: string
 *               colonia:
 *                 type: string
 *               alcaldia_municipio:
 *                 type: string
 *               estado:
 *                 type: string
 *               codigo_postal:
 *                 type: string
 *     responses:
 *       200:
 *         description: Domicilio guardado y guía de envío generada.
 */
// Paso 4 del flujo nuevo: se llama ANTES del pago, solo para guardar la dirección — ya
// no dispara Skydropx acá (antes lo hacía porque este paso ocurría después del pago).
// La guía real se genera recién cuando la verificación de Verificamex aprueba (ver
// aprobarYActivarEnvio más abajo), usando esta misma dirección ya guardada.
app.post('/api/solicitudes/:id/domicilio', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { calle, numero_exterior, numero_interior, colonia, alcaldia_municipio, estado, codigo_postal } = req.body;

    if (!calle || !numero_exterior || !colonia || !alcaldia_municipio || !estado || !codigo_postal) {
      return res.status(400).json({ error: 'Faltan campos obligatorios del domicilio.' });
    }

    const solicitud = await PersistenceService.saveDomicilio(id, {
      calle, numero_exterior, numero_interior, colonia, alcaldia_municipio, estado, codigo_postal
    });

    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    return res.status(200).json({ success: true, solicitud });
  } catch (error: any) {
    console.error('Error al guardar domicilio:', error);
    return res.status(500).json({ error: error.message || 'Ocurrió un error al procesar el domicilio.' });
  }
});

// Paso 5: confirma el 2do OTP + aceptación de términos. Mismo gate anti-bot que
// /iniciar (getOtpVerificado), y valida server-side que los pasos 3-4 ya estén
// completos — evita que alguien salte pasos pegándole directo a la API. Deja la
// solicitud en "Lista para pago", el único estatus que /crear-orden-enganche acepta.
app.post('/api/solicitudes/:id/confirmar-terminos', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { aceptaTerminos } = req.body;

    if (!aceptaTerminos) {
      return res.status(400).json({ error: 'Tenés que aceptar los términos y condiciones para continuar.' });
    }

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    // Solo se puede confirmar desde el tramo previo al pago. Sin este gate, cualquiera
    // con el link de una solicitud **cancelada** (que el admin ya reembolsó) o rechazada
    // podía revivirla volviendo a aceptar los términos, porque eso la dejaba de nuevo en
    // "Lista para pago" y habilitaba un pago nuevo. Se permite repetir desde "Lista para
    // pago" para que reintentar el mismo paso no falle.
    if (solicitud.estatus !== 'Iniciada' && solicitud.estatus !== 'Lista para pago') {
      return res.status(409).json({ error: 'Esta solicitud ya no puede continuar desde este paso.' });
    }

    const otpVerificado = await PersistenceService.getOtpVerificado(solicitud.celular);
    if (!otpVerificado) {
      return res.status(400).json({ error: 'Verifica tu número de WhatsApp de nuevo antes de continuar.' });
    }

    const faltantes: string[] = [];
    if (!solicitud.cliente || solicitud.cliente === 'Pendiente de verificación') faltantes.push('datos del cliente');
    if (!solicitud.curp) faltantes.push('CURP');
    if (!solicitud.email) faltantes.push('email');
    if (!solicitud.calle || !solicitud.codigo_postal) faltantes.push('dirección');
    if (faltantes.length > 0) {
      return res.status(400).json({ error: `Faltan completar: ${faltantes.join(', ')}.` });
    }

    // Un CURP = un crédito activo. El CURP está garantizado presente acá arriba, así que
    // este es el punto de enganche exacto para el bloqueo — antes de esto la solicitud
    // todavía puede terminar en nada (lead abandonado) y no debe bloquear a nadie.
    const creditoActivo = await PersistenceService.getCreditoActivoPorCurp(solicitud.curp);
    if (creditoActivo) {
      const solicitudDelCredito = await PersistenceService.getSolicitudById(creditoActivo.solicitud_id);
      const progreso = solicitudDelCredito
        ? `${solicitudDelCredito.semanas_pagadas ?? 0} de ${solicitudDelCredito.semanas} semanas`
        : 'en curso';
      const detalle = `Ya tiene un crédito activo (${progreso}).`;

      await PersistenceService.updateEstatus(id, 'Rechazado');
      await PersistenceService.registrarRechazo({
        solicitudId: id,
        curp: solicitud.curp,
        motivo: 'curp_con_credito_activo',
        detalle,
        creditoId: creditoActivo.id
      });

      console.log(`[Créditos] Solicitud ${id} rechazada: el CURP ya tiene un crédito activo (${creditoActivo.solicitud_id}).`);
      return res.status(409).json({
        error: 'Este CURP ya tiene un crédito activo con nosotros. Cuando termines de pagarlo vas a poder pedir otro equipo.',
        motivo: 'curp_con_credito_activo'
      });
    }

    const solicitudActualizada = await PersistenceService.confirmarTerminos(id);
    return res.status(200).json({ success: true, solicitud: solicitudActualizada });
  } catch (error: any) {
    console.error('Error al confirmar términos:', error);
    return res.status(500).json({ error: error.message || 'No se pudo confirmar. Intenta de nuevo.' });
  }
});

/**
 * @swagger
 * /api/solicitudes/{id}:
 *   patch:
 *     summary: Actualizar estatus (Aprobar/Rechazar) desde el Backoffice
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               estatus:
 *                 type: string
 *                 enum: [Aprobado, Rechazado]
 *     responses:
 *       200:
 *         description: Estatus actualizado.
 */
app.patch('/api/solicitudes/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { estatus, imei, celular } = req.body;

    if (imei !== undefined) {
      if (!String(imei).trim()) {
        return res.status(400).json({ error: 'El IMEI no puede estar vacío.' });
      }
      await PersistenceService.guardarImei(id, String(imei).trim());
    }

    if (celular !== undefined) {
      // Mismo criterio que POST /api/otp/enviar: celular mexicano de 10 dígitos, sin
      // código de país (así lo espera WhatsappOtpService.formatearNumero).
      const digitos = String(celular).replace(/\D/g, '');
      if (digitos.length !== 10) {
        return res.status(400).json({ error: 'Se requiere un celular mexicano de 10 dígitos.' });
      }
      await PersistenceService.guardarCelular(id, digitos);
    }

    if (estatus === undefined) {
      const solicitudActualizada = await PersistenceService.getSolicitudById(id);
      return res.status(200).json(solicitudActualizada);
    }

    const ESTATUS_VALIDOS = ['Aprobado', 'Rechazado', 'Pendiente de envío', 'Preparando paquete', 'Enviado'];
    if (!ESTATUS_VALIDOS.includes(estatus)) {
      return res.status(400).json({ error: 'Estatus no válido.' });
    }

    // No se puede marcar como Enviado sin haber cargado el IMEI antes — se valida acá
    // (no solo en el frontend) para que quede realmente exigido.
    if (estatus === 'Enviado') {
      const solicitudActual = await PersistenceService.getSolicitudById(id);
      const imeiFinal = imei !== undefined ? imei : solicitudActual?.imei;
      if (!imeiFinal || !String(imeiFinal).trim()) {
        return res.status(400).json({ error: 'Falta cargar el IMEI antes de marcar como enviado.' });
      }
    }

    // La solicitud a resolver puede venir de una revisión manual post-pago (ver
    // registrarFalloVerificamex/escalarRevisionManual) — si el admin la aprueba y ya
    // está pagada, no hay nada más que esperar: dispara Skydropx acá mismo en vez de
    // dejarla en un "Aprobado" de reposo (ese estado era para el flujo viejo, donde
    // "Aprobado" significaba "todavía falta que pague").
    const solicitudPrevia = await PersistenceService.getSolicitudById(id);
    const solicitudActualizada = await PersistenceService.updateEstatus(id, estatus);

    if (estatus === 'Aprobado' && solicitudPrevia?.pago_confirmado) {
      await aprobarYActivarEnvio(solicitudActualizada);
    }

    if (estatus === 'Enviado') {
      try {
        await WhatsappOtpService.enviarPedidoEnviado(solicitudActualizada.id, solicitudActualizada.celular, solicitudActualizada.cliente, solicitudActualizada.modelo);
      } catch (whatsappError: any) {
        console.error(`[Estatus] No se pudo avisar por WhatsApp que la solicitud ${id} fue enviada: ${whatsappError.message}`);
      }
    }

    return res.status(200).json(solicitudActualizada);
  } catch (error: any) {
    console.error('Error actualizando estatus:', error);
    return res.status(500).json({ error: error.message || 'Error al actualizar estatus.' });
  }
});

// GET: historial de WhatsApp mandados a una solicitud, para el detalle en /sadmin.
// Meta no expone ningún endpoint de consulta de mensajes ya enviados (la Cloud API es
// solo-envío) — esto es enteramente nuestro propio registro (WhatsappOtpService
// escribe una fila por intento en cada enviarXxx, vía PersistenceService.registrarMensajeWhatsapp).
app.get('/api/admin/solicitudes/:id/mensajes', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const mensajes = await PersistenceService.getMensajesDeSolicitud(id);
    return res.status(200).json(mensajes);
  } catch (error: any) {
    console.error('Error al consultar el historial de mensajes:', error.message);
    return res.status(500).json({ error: error.message || 'No se pudo consultar el historial de mensajes.' });
  }
});

// POST: Botón "Cancelar solicitud" del panel de admin — cancela todo, en Supabase y en
// Stripe (reembolsa el enganche si ya se pagó, cancela la suscripción semanal si llegó
// a armarse). No hay reembolso automático en ningún otro camino del flujo (ver
// aprobarYActivarEnvio/escalarRevisionManual) — esta es la única vía de reembolso, y es
// una decisión explícita del admin, no algo que dispare el sistema solo.
// POST: genera a mano un link de pago de tarjeta para el cobro semanal de una solicitud
// — mismo mecanismo que dispara invoice.payment_failed en el webhook
// (StripeService.crearLinkReintentoTarjeta), pero disponible desde el panel sin esperar a
// que Stripe avise (o mientras la plantilla de WhatsApp para el aviso automático todavía
// no esté aprobada por Meta). El link no se manda solo por WhatsApp acá — se devuelve
// para que el admin lo copie y lo mande a mano.
app.post('/api/admin/solicitudes/:id/link-pago-tarjeta', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }
    if (solicitud.metodo_pago_enganche !== 'card' || !solicitud.stripe_customer_id) {
      return res.status(409).json({ error: 'Esta solicitud no tiene una suscripción de tarjeta activa.' });
    }

    const usarProduccion = StripeService.usaProduccion(solicitud.email);
    const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
    const { url } = await StripeService.crearLinkReintentoTarjeta(
      id,
      solicitud.stripe_customer_id,
      Number(solicitud.pago_semanal),
      numeroSemana,
      ALLOWED_ORIGINS[0],
      usarProduccion
    );

    return res.status(200).json({ url });
  } catch (error: any) {
    console.error('Error al generar el link de pago de tarjeta:', error.message);
    return res.status(500).json({ error: error.message || 'No se pudo generar el link de pago.' });
  }
});

// POST: genera a mano un voucher OXXO para el cobro semanal de una solicitud — mismo
// mecanismo que corre el cron cada semana (StripeService.crearPagoSemanalOxxo), pero
// disponible desde el panel sin esperar al pase diario de las 9am. A diferencia de SPEI
// (CLABE fija reutilizable), OXXO no admite una referencia estable, así que cada llamada
// crea un voucher nuevo — es el comportamiento normal, no un problema: el cliente puede
// pagar cualquiera y el webhook los concilia por metadata.solicitud_id. El link no se
// manda solo por WhatsApp acá — se devuelve para que el admin lo copie y lo mande.
app.post('/api/admin/solicitudes/:id/link-pago-oxxo', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }
    if (solicitud.metodo_pago_enganche !== 'oxxo' || !solicitud.stripe_customer_id) {
      return res.status(409).json({ error: 'Esta solicitud no pagó el enganche con OXXO.' });
    }

    const usarProduccion = StripeService.usaProduccion(solicitud.email);
    const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
    const { url } = await StripeService.crearPagoSemanalOxxo(
      id,
      solicitud.stripe_customer_id,
      Number(solicitud.pago_semanal),
      numeroSemana,
      ALLOWED_ORIGINS[0],
      usarProduccion
    );

    return res.status(200).json({ url });
  } catch (error: any) {
    console.error('Error al generar el voucher OXXO:', error.message);
    return res.status(500).json({ error: error.message || 'No se pudo generar el link de pago.' });
  }
});

app.post('/api/admin/solicitudes/:id/cancelar', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const ESTATUS_TERMINALES = ['Enviado', 'Entregado', 'Cancelada'];
    if (ESTATUS_TERMINALES.includes(solicitud.estatus)) {
      return res.status(409).json({ error: `No se puede cancelar una solicitud en estatus "${solicitud.estatus}".` });
    }

    const usarProduccion = StripeService.usaProduccion(solicitud.email);

    if (solicitud.stripe_subscription_id) {
      try {
        await StripeService.cancelarSuscripcion(solicitud.stripe_subscription_id, usarProduccion);
      } catch (stripeError: any) {
        console.error(`[Cancelar] No se pudo cancelar la suscripción de Stripe de la solicitud ${id}: ${stripeError.message}`);
      }
    }

    if (solicitud.pago_confirmado && solicitud.stripe_payment_intent_id) {
      try {
        await StripeService.reembolsarPago(solicitud.stripe_payment_intent_id, usarProduccion);
      } catch (stripeError: any) {
        console.error(`[Cancelar] No se pudo reembolsar el pago de la solicitud ${id}: ${stripeError.message}`);
        return res.status(500).json({ error: 'No se pudo reembolsar el pago en Stripe — la solicitud NO se canceló. Revisa el dashboard de Stripe antes de reintentar.' });
      }
    }

    // Best-effort, no bloquea la cancelación: lo que de verdad protege al cliente (dejar
    // de cobrarle, devolverle el enganche) ya se resolvió arriba con Stripe. Si Skydropx
    // no responde o el endpoint de cancelación no se comporta como documentado (todavía
    // sin confirmar contra la cuenta real, ver skydropxService.ts), la solicitud igual
    // se cancela y queda logueado para revisar la guía a mano.
    if (solicitud.skydropx_shipment_id) {
      try {
        // Mismo criterio de email que Stripe (usarProduccion, ya calculado arriba) —
        // Skydropx usa la misma regla desarrollo@movinex.mx → sandbox, cualquier otro → real.
        await SkydropxService.cancelarEnvio(solicitud.skydropx_shipment_id, usarProduccion);
      } catch (skydropxError: any) {
        console.error(`[Cancelar] No se pudo cancelar la guía de Skydropx de la solicitud ${id} (shipment ${solicitud.skydropx_shipment_id}): ${skydropxError.message}`);
      }
    }

    const solicitudCancelada = await PersistenceService.cancelarSolicitud(id);

    try {
      await WhatsappOtpService.enviarSolicitudCancelada(solicitud.id, solicitud.celular, solicitud.cliente, solicitud.modelo);
    } catch (whatsappError: any) {
      console.error(`[Cancelar] No se pudo avisar la cancelación por WhatsApp a la solicitud ${id}: ${whatsappError.message}`);
    }

    return res.status(200).json({ success: true, solicitud: solicitudCancelada });
  } catch (error: any) {
    console.error('Error al cancelar la solicitud:', error);
    return res.status(500).json({ error: error.message || 'No se pudo cancelar la solicitud.' });
  }
});

// POST: Login para Super Administradores
app.post('/api/admin/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) {
      return res.status(400).json({ success: false, message: 'Usuario y clave requeridos.' });
    }

    const authResult = await SuperadminService.login(usuario, clave);
    if (!authResult.success) {
      // Se registra la IP de origen para poder distinguir a un admin que se equivocó de
      // tecla de alguien probando contraseñas desde afuera. Sin esto, el log solo decía
      // "Contraseña incorrecta" y no había forma de investigar (caso real: 2026-08-16).
      console.warn(`[Login] Intento fallido para "${usuario}" desde IP ${req.ip}`);
      return res.status(401).json(authResult);
    }

    console.log(`[Login] Acceso concedido a "${usuario}" desde IP ${req.ip}`);

    return res.status(200).json(authResult);
  } catch (error: any) {
    console.error('Error en login superadmin:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error en el servidor.' });
  }
});

// GET/PUT: parámetros de negocio (enganche/tasa/IVA/cargo semanal) que usa
// catalogo-view.tsx al calcular precios sugeridos — antes hardcodeados en el frontend.
// Cambiar esto solo afecta a celulares que se agreguen/reguarden desde ahora; los que
// ya están en el catálogo conservan sus montos guardados hasta que alguien los reguarde.
/**
 * Fuente de datos del tablero de cartera de /sadmin: las solicitudes con el enganche
 * pagado más TODOS sus pagos, en una sola respuesta.
 *
 * No se reusa GET /api/solicitudes a propósito: ese firma una URL del bucket de KYC por
 * cada fila (ver PersistenceService.getSolicitudes), lo que lo hace lento a medida que
 * crece la cartera y encima manda documentos de identidad a una pantalla de analítica
 * que no los necesita. Acá se seleccionan solo las columnas del crédito.
 */
app.get('/api/admin/cartera', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const [solicitudes, pagos] = await Promise.all([
      PersistenceService.getSolicitudesParaCartera(),
      PersistenceService.getTodosLosPagos()
    ]);
    return res.status(200).json({ solicitudes, pagos });
  } catch (error: any) {
    console.error('Error al obtener la cartera:', error.message);
    return res.status(500).json({ error: 'No se pudo obtener la cartera.' });
  }
});

/**
 * Historial de intentos bloqueados por CURP-ya-con-crédito-activo, para la vista de
 * Rechazos de /sadmin. El join con la solicitud (cliente, celular) lo arma el frontend
 * contra la lista de solicitudes que ya tiene cargada — igual que /api/admin/cartera
 * deja el join de pagos para lib/cartera.ts.
 */
app.get('/api/admin/rechazos', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const rechazos = await PersistenceService.getRechazos();
    return res.status(200).json({ rechazos });
  } catch (error: any) {
    console.error('Error al obtener los rechazos:', error.message);
    return res.status(500).json({ error: 'No se pudo obtener el historial de rechazos.' });
  }
});

app.get('/api/admin/configuracion', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const config = await PersistenceService.getConfiguracion();
    return res.status(200).json(config);
  } catch (error: any) {
    console.error('Error al obtener la configuración:', error.message);
    return res.status(500).json({ error: 'No se pudo obtener la configuración.' });
  }
});

app.put('/api/admin/configuracion', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { enganche_pct, tasa_anual_pct, iva_pct, cargo_semanal_nombre, cargo_semanal_monto } = req.body;
    const numeros = [enganche_pct, tasa_anual_pct, iva_pct, cargo_semanal_monto];
    if (numeros.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      return res.status(400).json({ error: 'Los valores numéricos deben ser mayores o iguales a 0.' });
    }
    if (!cargo_semanal_nombre || typeof cargo_semanal_nombre !== 'string') {
      return res.status(400).json({ error: 'Falta el nombre del cargo semanal.' });
    }

    const config = await PersistenceService.actualizarConfiguracion({
      enganche_pct, tasa_anual_pct, iva_pct, cargo_semanal_nombre, cargo_semanal_monto
    });
    return res.status(200).json(config);
  } catch (error: any) {
    console.error('Error al actualizar la configuración:', error.message);
    return res.status(500).json({ error: 'No se pudo actualizar la configuración.' });
  }
});

// Cotizador interno (/sadmin/cotizador): guarda cotizaciones como referencia/historial
// del equipo. No crea ninguna solicitud ni crédito real — eso solo pasa a través del
// flujo real del cliente (OTP, pago por Stripe, verificación de Verificamex).
app.get('/api/admin/cotizaciones', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const cotizaciones = await PersistenceService.getCotizacionesInternas();
    return res.status(200).json(cotizaciones);
  } catch (error: any) {
    console.error('Error al obtener las cotizaciones:', error.message);
    return res.status(500).json({ error: 'No se pudieron obtener las cotizaciones.' });
  }
});

app.post('/api/admin/cotizaciones', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { marca, modelo, almacenamientoColor, precioContado, plazoSemanas, enganche, pagoSemanal } = req.body;
    if (!marca || !modelo || !precioContado || !plazoSemanas || enganche == null || !pagoSemanal) {
      return res.status(400).json({ error: 'Faltan datos de la cotización.' });
    }

    const guardada = await PersistenceService.guardarCotizacionInterna({
      marca, modelo, almacenamiento_color: almacenamientoColor || null,
      precio_contado: precioContado, plazo_semanas: plazoSemanas, enganche, pago_semanal: pagoSemanal
    });
    return res.status(201).json(guardada);
  } catch (error: any) {
    console.error('Error al guardar la cotización:', error.message);
    return res.status(500).json({ error: 'No se pudo guardar la cotización.' });
  }
});

app.delete('/api/admin/cotizaciones/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await PersistenceService.eliminarCotizacionInterna(req.params.id);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error al eliminar la cotización:', error.message);
    return res.status(500).json({ error: 'No se pudo eliminar la cotización.' });
  }
});

// POST: Subir imagen de un celular al Storage de Supabase (el frontend ya no habla con Supabase directo)
app.post('/api/celulares/imagen', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { imagen } = req.body;
    if (!imagen) {
      return res.status(400).json({ error: 'Se requiere la imagen en base64.' });
    }

    const url = await PersistenceService.subirImagenCelular(imagen);
    return res.status(200).json({ success: true, url });
  } catch (error: any) {
    console.error('Error al subir imagen de celular:', error);
    return res.status(500).json({ error: error.message || 'Error al subir la imagen.' });
  }
});

// POST: Crear nuevo celular en el catálogo
app.post('/api/celulares', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const celular = await PersistenceService.createCelular(req.body);
    return res.status(201).json({ success: true, celular });
  } catch (error: any) {
    console.error('Error creando celular:', error);
    return res.status(500).json({ error: error.message || 'Error al crear celular.' });
  }
});

// PUT: Actualizar celular del catálogo
app.put('/api/celulares/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const celular = await PersistenceService.updateCelular(id, req.body);
    return res.status(200).json({ success: true, celular });
  } catch (error: any) {
    console.error('Error editando celular:', error);
    return res.status(500).json({ error: error.message || 'Error al actualizar celular.' });
  }
});

// DELETE: Eliminar celular del catálogo
app.delete('/api/celulares/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await PersistenceService.deleteCelular(id);
    return res.status(200).json({ success: true, message: 'Celular eliminado con éxito.' });
  } catch (error: any) {
    console.error('Error eliminando celular:', error);
    return res.status(500).json({ error: error.message || 'Error al eliminar celular.' });
  }
});

// POST: Endpoint seguro para recibir webhooks de Conekta (Verificamex/Pagos) con validación HMAC
app.post('/api/webhooks/conekta', async (req: Request, res: Response) => {
  const signature = req.headers['x-conekta-signature'] as string;
  const rawBody = JSON.stringify(req.body);

  // Validación de firma HMAC usando llave pública RSA de Conekta
  const isValid = verifyConektaSignature(rawBody, signature, CONEKTA_PUBLIC_KEY);

  if (!isValid) {
    console.warn('[Conekta Webhook] Firma de webhook de Conekta inválida.');
    return res.status(401).json({ error: 'Firma de webhook inválida' });
  }

  const event = req.body;
  console.log('[Conekta Webhook] Evento recibido y verificado:', event.type);

  try {
    // Si el evento indica que una orden fue pagada con éxito
    if (event.type === 'order.paid') {
      const order = event.data.object;
      const customerInfo = order.customer_info;
      const email = customerInfo?.email;
      const phone = customerInfo?.phone;

      console.log(`[Conekta Webhook] Orden pagada con éxito: ${order.id}. Monto: $${(order.amount / 100).toFixed(2)} MXN`);
      console.log(`[Conekta Webhook] Cliente: ${customerInfo?.name}. Contacto: ${email} / ${phone}`);

      // Marcar el pago como confirmado. El envío en Skydropx se genera después,
      // cuando el cliente llena el formulario de Domicilio (POST /api/solicitudes/:id/domicilio),
      // ya que en este punto todavía no tenemos su dirección real.
      if (email || phone) {
        const identificador = email || phone;

        const solicitudesActualizadas = await PersistenceService.getSolicitudesByContacto(identificador);
        for (const s of solicitudesActualizadas) {
          await PersistenceService.marcarPagoConfirmado(s.id);
        }

        if (solicitudesActualizadas && solicitudesActualizadas.length > 0) {
          console.log(`[Conekta Webhook] Pago confirmado para ${solicitudesActualizadas.length} solicitud(es) del cliente.`);

          // Conekta arma un Customer aun en HostedPayment cuando la orden incluye customer_info,
          // y lo devuelve como customer_info.customer_id en este mismo evento. En cuanto esa cuenta
          // tenga Early Access a Tarjetas Guardadas y ese customer traiga una tarjeta por default,
          // esto arma el Plan + Subscription semanal sin que haya que tocar código de nuevo.
          const conektaCustomerId = customerInfo?.customer_id;

          if (conektaCustomerId) {
            for (const solicitud of solicitudesActualizadas) {
              try {
                const { planId, subscriptionId } = await ConektaService.crearSuscripcionSemanal(
                  solicitud.id,
                  conektaCustomerId,
                  Number(solicitud.pago_semanal),
                  Number(solicitud.semanas)
                );
                await PersistenceService.guardarSuscripcionConekta(solicitud.id, conektaCustomerId, subscriptionId);
                console.log(`[Conekta Webhook] Suscripción semanal ${subscriptionId} (plan ${planId}) creada para la solicitud ${solicitud.id}.`);
              } catch (subError: any) {
                console.error(
                  `[Conekta Webhook] No se pudo crear la suscripción semanal de la solicitud ${solicitud.id}: ` +
                  `${subError.response?.data?.details?.[0]?.message || subError.message}. ` +
                  `El enganche ya quedó cobrado y confirmado igual — si el error menciona una tarjeta o ` +
                  `payment source por default, es porque la cuenta de Conekta aún no tiene Early Access a Tarjetas Guardadas.`
                );
              }
            }
          } else {
            console.warn(`[Conekta Webhook] La orden ${order.id} no trajo customer_id — no se puede armar la suscripción semanal automática todavía.`);
          }
        } else {
          console.warn(`[Conekta Webhook] No se encontró ninguna solicitud de crédito que coincida con el contacto: ${identificador}`);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (webhookError: any) {
    console.error('[Conekta Webhook] Error al procesar webhook:', webhookError.message);
    return res.status(500).json({ error: 'Error procesando webhook' });
  }
});

// POST: Endpoint seguro para recibir webhooks de Stripe (pagos) — fuente de verdad del
// pago del enganche, igual que /api/webhooks/conekta antes. Usa express.raw() en vez
// del JSON parser global (ver arriba) porque Stripe firma sobre los bytes exactos del
// body; stripe.webhooks.constructEvent rechaza la petición si la firma no cuadra.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;

  let event;
  try {
    if (!STRIPE_WEBHOOK_SECRET && !STRIPE_WEBHOOK_SECRET_TEST) {
      throw new Error('STRIPE_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET_TEST no están configurados en el servidor.');
    }
    event = StripeService.construirEventoWebhook(req.body as Buffer, signature, [STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET_TEST]);
  } catch (err: any) {
    console.warn('[Stripe Webhook] Firma inválida o no verificable:', err.message);
    return res.status(401).json({ error: 'Firma de webhook inválida' });
  }

  // El evento trae livemode (true = cuenta real, false = modo de prueba) — se usa
  // para llamar de vuelta a Stripe con el cliente correcto (ver StripeService.usaProduccion).
  const usarProduccion = event.livemode;
  console.log(`[Stripe Webhook] Evento recibido y verificado: ${event.type} (${usarProduccion ? 'LIVE' : 'test'})`);

  try {
    // Tarjeta cobra síncrono: checkout.session.completed ya trae payment_status "paid".
    // OXXO/SPEI son de cobro diferido (el cliente paga horas/días después con el
    // voucher o la CLABE) — en ese caso completed llega con payment_status "unpaid" y
    // la confirmación real llega más tarde en checkout.session.async_payment_succeeded.
    // Ambos eventos comparten la misma Session como payload, así que se procesan igual.
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as any;

      if (session.payment_status !== 'paid') {
        console.log(`[Stripe Webhook] Sesión ${session.id} todavía no está pagada (payment_status: ${session.payment_status}) — esperando confirmación (OXXO/SPEI).`);
        return res.status(200).json({ received: true });
      }

      const solicitudId: string | undefined = session.metadata?.solicitud_id;
      const customerId: string | undefined = session.customer;
      const paymentIntentId: string | undefined = session.payment_intent;

      console.log(`[Stripe Webhook] Sesión pagada con éxito: ${session.id}. Solicitud: ${solicitudId}.`);

      if (!solicitudId) {
        console.warn('[Stripe Webhook] La sesión no trae solicitud_id en metadata — no se puede confirmar el pago.');
        return res.status(200).json({ received: true });
      }

      // Un voucher semanal de OXXO (StripeService.crearPagoSemanalOxxo) dispara este
      // mismo evento — hay que procesarlo distinto del enganche: solo cuenta la semana
      // pagada, no toca pago_confirmado ni intenta armar ninguna Subscription.
      if (session.metadata?.tipo === 'cobro_semanal') {
        const resultado = await PersistenceService.registrarPagoSemanalManual(solicitudId, session.id);
        if (resultado.yaProcesada) {
          console.log(`[Stripe Webhook] Voucher OXXO ${session.id} de la solicitud ${solicitudId} ya se había procesado — reintento del webhook, se ignora.`);
          return res.status(200).json({ received: true });
        }
        console.log(`[Stripe Webhook] Pago semanal OXXO confirmado para la solicitud ${solicitudId} (${resultado.semanas_pagadas}/${resultado.semanas}).`);
        // Las semanas de OXXO no generan invoice (cada una es una Session suelta), así
        // que esta es la única forma de que queden en el historial.
        await PersistenceService.registrarPago({
          solicitudId,
          tipo: 'semanal',
          numeroSemana: Number(session.metadata?.numero_semana) || resultado.semanas_pagadas,
          monto: Number(session.amount_total || 0) / 100,
          fecha: new Date(),
          metodo: 'oxxo',
          stripeId: session.id
        });

        // OXXO no tiene Subscription que cancelar (ver comentario más abajo), pero el
        // CURP igual tiene que liberarse cuando termina de pagar por este método.
        if (resultado.semanas_pagadas >= resultado.semanas) {
          await PersistenceService.liquidarCredito(solicitudId);
          console.log(`[Stripe Webhook] Plan completo por OXXO (${resultado.semanas_pagadas}/${resultado.semanas}) para la solicitud ${solicitudId} — crédito liquidado.`);
        }
        return res.status(200).json({ received: true });
      }

      const solicitud = await PersistenceService.getSolicitudById(solicitudId);
      if (!solicitud) {
        console.warn(`[Stripe Webhook] No se encontró la solicitud ${solicitudId}.`);
        return res.status(200).json({ received: true });
      }

      await PersistenceService.marcarPagoConfirmado(solicitudId, paymentIntentId);
      console.log(`[Stripe Webhook] Pago confirmado para la solicitud ${solicitudId}.`);

      // Nace el crédito real. Si el CURP viniera vacío acá sería un dato corrupto (ya se
      // exige en confirmar-terminos), así que solo se intenta si está presente.
      if (solicitud.curp) {
        await PersistenceService.crearCredito({
          solicitudId: solicitud.id,
          curp: solicitud.curp,
          montoSemanal: Number(solicitud.pago_semanal) || 0,
          semanas: Number(solicitud.semanas) || 0
        });
      }

      // Arma el cobro semanal automático a partir de cómo se pagó el enganche.
      // - Tarjeta: Subscription clásica cobrando la tarjeta guardada.
      // - SPEI (customer_balance): CLABE persistente + Subscription "send_invoice" que
      //   se cobra sola del saldo cuando el cliente deposita — el cliente recibe esa
      //   CLABE una vez por WhatsApp y la reutiliza todas las semanas.
      // - OXXO: nada de Subscription ni CLABE — OXXO no soporta cobro recurrente ni una
      //   referencia fija reutilizable (confirmado en la documentación de Stripe), así
      //   que solo se guarda el customer_id para poder generarle un voucher nuevo cada
      //   semana (ver cobrosSemanalesService.ts → procesarPendientesOxxo).
      // Mismo link para los tres métodos: es adonde sigue el flujo después de pagar.
      const linkContinuar = `${ALLOWED_ORIGINS[0]}/verificacion?solicitud=${solicitud.id}&modelo=${encodeURIComponent(solicitud.modelo)}`;

      if (customerId && paymentIntentId) {
        try {
          const { paymentMethodId, tipo, receiptUrl } = await StripeService.obtenerMetodoPagoDeIntent(paymentIntentId, usarProduccion);
          await PersistenceService.guardarMetodoPagoEnganche(solicitud.id, tipo);
          if (receiptUrl) {
            await PersistenceService.guardarReciboPago(solicitud.id, receiptUrl);
          }

          // El enganche va al historial con el monto REAL cobrado (amount_total, que
          // incluye el costo de envío si lo hubo), no con la columna `enganche` — para
          // el flujo de caja importa lo que entró, no lo que se había presupuestado.
          await PersistenceService.registrarPago({
            solicitudId: solicitud.id,
            tipo: 'enganche',
            monto: Number(session.amount_total || 0) / 100,
            fecha: new Date(),
            metodo: tipo,
            stripeId: paymentIntentId
          });

          if (tipo === 'oxxo') {
            await PersistenceService.guardarStripeCustomerId(solicitud.id, customerId);
            // Mismo criterio que SPEI: el primer cobro real vence en 7 días, el cron
            // (cobrosSemanalesService.ts) genera el primer voucher ese día, no acá.
            await PersistenceService.programarProximoCobroSemanal(solicitud.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

            try {
              await WhatsappOtpService.enviarConfirmacionPago(solicitud.id, solicitud.celular, solicitud.cliente, linkContinuar);
            } catch (whatsappError: any) {
              console.error(`[Stripe Webhook] No se pudo avisar la confirmación de pago por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
            }

            console.log(`[Stripe Webhook] La solicitud ${solicitud.id} pagó el enganche con OXXO — cobro semanal por voucher nuevo cada semana, sin Subscription.`);
          } else if (tipo === 'customer_balance') {
            const { clabe } = await StripeService.crearReferenciaPagoPersistente(customerId, usarProduccion);
            const { subscriptionId } = await StripeService.crearSuscripcionConSaldo(
              solicitud.id,
              customerId,
              Number(solicitud.pago_semanal),
              Number(solicitud.semanas),
              usarProduccion
            );
            await PersistenceService.guardarSuscripcionStripe(solicitud.id, customerId, subscriptionId);
            await PersistenceService.guardarReferenciaPagoPersistente(solicitud.id, clabe);
            // No se manda el aviso de la CLABE acá mismo: el primer pago real recién vence
            // en 7 días (fin del trial), así que este mismo programarProximoCobroSemanal ya
            // deja el primer recordatorio real armado para ese día — lo manda el cron
            // (cobrosSemanalesService.ts), no este webhook. Mandarlo apenas se confirma el
            // enganche sonaba a "ya te toca pagar" cuando en realidad todavía falta una
            // semana entera.
            await PersistenceService.programarProximoCobroSemanal(solicitud.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

            // El pago con SPEI se confirma horas o días después de que el cliente salió
            // del navegador (a diferencia de tarjeta, que Stripe redirige solo vía
            // success_url) — sin este aviso, nadie le dice que ya puede volver a cargar
            // su domicilio. Mismo link que usa crear-orden-enganche para success_url.
            try {
              await WhatsappOtpService.enviarConfirmacionPago(solicitud.id, solicitud.celular, solicitud.cliente, linkContinuar);
            } catch (whatsappError: any) {
              console.error(`[Stripe Webhook] No se pudo avisar la confirmación de pago por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
            }

            console.log(
              `[Stripe Webhook] La solicitud ${solicitud.id} pagó el enganche con SPEI — ` +
              `CLABE persistente ${clabe} asignada, suscripción ${subscriptionId} armada (send_invoice).`
            );
          } else {
            await StripeService.fijarMetodoPagoDefault(customerId, paymentMethodId, usarProduccion);

            const { subscriptionId } = await StripeService.crearSuscripcionSemanal(
              solicitud.id,
              customerId,
              paymentMethodId,
              Number(solicitud.pago_semanal),
              Number(solicitud.semanas),
              usarProduccion
            );
            await PersistenceService.guardarSuscripcionStripe(solicitud.id, customerId, subscriptionId);
            // Igual que OXXO/SPEI arriba: el primer cobro real vence en 7 días (fin del
            // trial) — sin esto Cobranza no tenía ninguna fecha que mostrar para tarjeta.
            await PersistenceService.programarProximoCobroSemanal(solicitud.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

            // Tarjeta también recibe la confirmación. La versión original no la mandaba
            // acá porque Stripe redirige solo al cliente vía success_url, pero eso solo
            // sirve si sigue frente a la pantalla: si cerró la pestaña o perdió señal al
            // volver, se quedaba sin ningún aviso ni forma de retomar el flujo.
            try {
              await WhatsappOtpService.enviarConfirmacionPago(solicitud.id, solicitud.celular, solicitud.cliente, linkContinuar);
            } catch (whatsappError: any) {
              console.error(`[Stripe Webhook] No se pudo avisar la confirmación de pago por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
            }

            console.log(`[Stripe Webhook] Suscripción semanal ${subscriptionId} creada para la solicitud ${solicitud.id}.`);
          }
        } catch (subError: any) {
          console.error(
            `[Stripe Webhook] No se pudo armar el cobro semanal (automático o manual) de la solicitud ${solicitud.id}: ${subError.message}. ` +
            `El enganche ya quedó cobrado y confirmado igual.`
          );
        }
      } else {
        console.warn(`[Stripe Webhook] La sesión ${session.id} no trajo customer/payment_intent — no se puede armar el cobro semanal.`);
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object as any;
      const tipoPago = session.metadata?.tipo || 'enganche';
      console.warn(`[Stripe Webhook] El pago diferido (OXXO/SPEI) de la sesión ${session.id} (solicitud ${session.metadata?.solicitud_id}, tipo "${tipoPago}") falló o expiró — el cliente tendrá que pagar de nuevo.`);
    } else if (event.type === 'invoice.paid') {
      // Factura semanal pagada — de CUALQUIERA de las dos Subscriptions (tarjeta,
      // cobro automático; o "send_invoice" por saldo/CLABE persistente): las dos se
      // crean con el mismo metadata.solicitud_id (ver crearSuscripcionSemanal y
      // crearSuscripcionConSaldo), y `invoice.parent.subscription_details.metadata`
      // es el snapshot de esos metadata al momento de facturar.
      const invoice = event.data.object as any;
      const solicitudId: string | undefined = invoice.parent?.subscription_details?.metadata?.solicitud_id;

      if (!solicitudId) {
        console.log(`[Stripe Webhook] Invoice ${invoice.id} pagada, pero no trae solicitud_id (no es de una suscripción nuestra) — se ignora.`);
        return res.status(200).json({ received: true });
      }

      // Stripe genera y "paga" automáticamente una factura de $0 el día que arranca el
      // trial de 7 días (billing_reason: "subscription_create", solo notifica que el
      // período de prueba empezó) — esa NO es una semana real pagada, así que no cuenta.
      // Sin este chequeo, esa factura de $0 se contaba como la semana #1 apenas se
      // pagaba el enganche, días antes de que el cliente pagara nada de verdad.
      if (Number(invoice.amount_paid) === 0) {
        console.log(`[Stripe Webhook] Invoice ${invoice.id} de la solicitud ${solicitudId} es de $0 (billing_reason: ${invoice.billing_reason}) — no cuenta como semana pagada, se ignora.`);
        return res.status(200).json({ received: true });
      }

      const resultado = await PersistenceService.registrarPagoSemanalManual(solicitudId, invoice.id);
      if (resultado.yaProcesada) {
        console.log(`[Stripe Webhook] Invoice ${invoice.id} ya se había procesado antes para la solicitud ${solicitudId} — reintento del webhook, se ignora.`);
        return res.status(200).json({ received: true });
      }

      console.log(`[Stripe Webhook] Pago semanal confirmado para la solicitud ${solicitudId} (${resultado.semanas_pagadas}/${resultado.semanas}).`);

      // Fecha de CAJA real: `status_transitions.paid_at` es cuándo se acreditó de verdad,
      // que en SPEI puede ser días después de emitida la factura. Viene en segundos.
      const pagadaEn = invoice.status_transitions?.paid_at;
      await PersistenceService.registrarPago({
        solicitudId,
        tipo: 'semanal',
        numeroSemana: resultado.semanas_pagadas,
        monto: Number(invoice.amount_paid) / 100,
        fecha: pagadaEn ? new Date(pagadaEn * 1000) : new Date(),
        metodo: invoice.collection_method === 'send_invoice' ? 'customer_balance' : 'card',
        stripeId: invoice.id
      });

      // Plan completo: cancelar la Subscription para que Stripe deje de cobrar — no
      // trae `cancel_at` propio, así que sin esto seguiría facturando cada semana
      // indefinidamente.
      if (resultado.semanas_pagadas >= resultado.semanas) {
        try {
          const solicitudCompleta = await PersistenceService.getSolicitudById(solicitudId);
          if (solicitudCompleta?.stripe_subscription_id) {
            await StripeService.cancelarSuscripcion(solicitudCompleta.stripe_subscription_id, usarProduccion);
            console.log(`[Stripe Webhook] Plan completo (${resultado.semanas_pagadas}/${resultado.semanas}) — Subscription ${solicitudCompleta.stripe_subscription_id} cancelada para la solicitud ${solicitudId}.`);
          } else {
            console.warn(`[Stripe Webhook] Plan completo para la solicitud ${solicitudId} pero no hay stripe_subscription_id guardado — no se pudo cancelar.`);
          }
        } catch (cancelError: any) {
          console.error(`[Stripe Webhook] No se pudo cancelar la Subscription de la solicitud ${solicitudId} tras completar el plan: ${cancelError.message}`);
        }

        // Libera el CURP: ya terminó de pagar, puede pedir otro equipo.
        await PersistenceService.liquidarCredito(solicitudId);
      } else {
        // Tarjeta: a diferencia de OXXO/SPEI (donde el cron ya programa la próxima fecha
        // al mandar el recordatorio/voucher), acá el invoice.paid es la única señal de
        // que tocaba cobrar esta semana — se aprovecha para dejar la próxima fecha
        // visible en Cobranza y limpiar cualquier marca de cobro fallido previa.
        await PersistenceService.programarProximoCobroSemanal(solicitudId, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      }
    } else if (event.type === 'invoice.payment_failed') {
      // El cobro automático de tarjeta falló — Stripe reintenta solo en el fondo (Smart
      // Retries), pero el equipo no tenía ninguna visibilidad ni forma de mandarle un
      // link alternativo al cliente. Solo aplica a tarjeta: SPEI/OXXO no tienen un cargo
      // automático que pueda "fallar" de esta forma (send_invoice espera saldo, no cobra).
      const invoice = event.data.object as any;
      const solicitudId: string | undefined = invoice.parent?.subscription_details?.metadata?.solicitud_id;

      if (!solicitudId) {
        console.log(`[Stripe Webhook] invoice.payment_failed ${invoice.id} sin solicitud_id — se ignora.`);
        return res.status(200).json({ received: true });
      }

      const solicitud = await PersistenceService.getSolicitudById(solicitudId);
      if (!solicitud || solicitud.metodo_pago_enganche !== 'card' || !solicitud.stripe_customer_id) {
        console.log(`[Stripe Webhook] invoice.payment_failed ${invoice.id} de la solicitud ${solicitudId} no es de una Subscription de tarjeta con customer guardado — se ignora.`);
        return res.status(200).json({ received: true });
      }

      // Nunca cobrarle ni escribirle a alguien que ya canceló. No debería llegar acá
      // (cancelarSolicitud cancela la Subscription en Stripe), pero esa llamada se traga
      // sus errores y solo los loguea: si alguna vez falla, la Subscription queda viva,
      // Stripe la reintenta, y sin este guard le mandaríamos un link de pago a un cliente
      // cancelado. Mismo criterio que el cron de cobranza semanal
      // (getSolicitudesConCobroSpeiPendiente/Oxxo en persistenceService.ts).
      if (solicitud.estatus === 'Cancelada' || solicitud.estatus === 'Rechazado') {
        console.warn(
          `[Stripe Webhook] invoice.payment_failed ${invoice.id} de la solicitud ${solicitudId}, que está en "${solicitud.estatus}" — ` +
          `no se le avisa nada al cliente. Revisar por qué su Subscription ${solicitud.stripe_subscription_id} sigue viva en Stripe.`
        );
        return res.status(200).json({ received: true });
      }

      // Deduplicado por invoice.id + attempt_count: Stripe garantiza entrega "al menos
      // una vez" de sus webhooks, y una redelivery de este evento en particular coincide
      // típicamente con un restart del backend (Railway no llegó a responder 200 antes
      // de bajar, o el evento quedó en cola durante el tiempo que el server estuvo abajo
      // y Stripe lo reintenta apenas vuelve a levantar) — sin este chequeo, cada
      // redelivery volvía a mandar el WhatsApp Y generaba un link de reintento de
      // tarjeta nuevo en Stripe, no solo a duplicar una fila del historial. A diferencia
      // de invoice.paid (dedup por invoice.id solo, porque una factura se paga una sola
      // vez), acá se necesita también attempt_count: Smart Retries sí vuelve a fallar la
      // MISMA invoice varios días seguidos, y cada intento real sigue queriendo avisar.
      const attemptCount = Number(invoice.attempt_count || 0);
      const esNuevo = await PersistenceService.registrarFalloInvoiceSiNuevo(solicitudId, invoice.id, attemptCount);
      if (!esNuevo) {
        console.log(`[Stripe Webhook] invoice.payment_failed ${invoice.id} (intento ${attemptCount}) de la solicitud ${solicitudId} ya se había procesado antes — reintento del webhook, se ignora.`);
        return res.status(200).json({ received: true });
      }

      console.warn(`[Stripe Webhook] Falló el cobro automático de tarjeta para la solicitud ${solicitudId} (invoice ${invoice.id}).`);
      await PersistenceService.marcarCobroSemanalFallido(solicitudId);

      // Queda en el historial como intento fallido: no suma a lo cobrado, pero deja ver
      // cuántas veces rebotó la tarjeta de un cliente antes de que pagara.
      await PersistenceService.registrarPago({
        solicitudId,
        tipo: 'semanal',
        numeroSemana: Number(solicitud.semanas_pagadas || 0) + 1,
        monto: Number(invoice.amount_due || 0) / 100,
        fecha: new Date(),
        metodo: 'card',
        estado: 'fallido',
        stripeId: `${invoice.id}_fallido_${invoice.attempt_count || 0}`
      });

      try {
        const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
        const { url } = await StripeService.crearLinkReintentoTarjeta(
          solicitudId,
          solicitud.stripe_customer_id,
          Number(solicitud.pago_semanal),
          numeroSemana,
          ALLOWED_ORIGINS[0],
          usarProduccion
        );
        await WhatsappOtpService.enviarLinkReintentoTarjeta(solicitud.id, solicitud.celular, solicitud.cliente, url, Number(solicitud.pago_semanal), numeroSemana);
        console.log(`[Stripe Webhook] Link de reintento de tarjeta generado y enviado para la solicitud ${solicitudId}.`);
      } catch (fallbackError: any) {
        console.error(`[Stripe Webhook] No se pudo generar/enviar el link de reintento de tarjeta para la solicitud ${solicitudId}: ${fallbackError.message}`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (webhookError: any) {
    console.error('[Stripe Webhook] Error al procesar webhook:', webhookError.message);
    return res.status(500).json({ error: 'Error procesando webhook' });
  }
});

// POST: Enviar comando de bloqueo/desbloqueo a dispositivo (MDM) firmado criptográficamente con JWT
app.post('/api/mdm/command', (req: Request, res: Response) => {
  const { deviceId, action } = req.body;

  if (!deviceId || (action !== 'LOCK' && action !== 'UNLOCK')) {
    return res.status(400).json({ error: 'Dispositivo o comando de acción inválidos.' });
  }

  // Generar token firmado
  const token = generateMdmCommandToken(deviceId, action, MDM_JWT_SECRET);
  console.log(`Comando ${action} generado y firmado para dispositivo ${deviceId}`);

  return res.status(200).json({
    success: true,
    deviceId,
    action,
    signedToken: token
  });
});

// POST: Verificación de identidad del cliente (respuesta simulada, hardcodeada)
// Verificamex limita a 30 llamadas por minuto **por endpoint y por token** — o sea, el
// tope es de toda la cuenta, no por cliente. La pantalla /verificacion consulta cada
// pocos segundos, así que sin freno un solo cliente verificando ya se comería la mayor
// parte de esa cuota y dos en paralelo la reventarían (dejando a todos sin poder
// verificar). Acá se limita a una consulta real cada 10s por sesión: entre medio se
// responde con lo último guardado, que igual se actualiza solo apenas llega el webhook.
const ultimaConsultaVerificamex = new Map<string, number>();
const INTERVALO_MIN_CONSULTA_MS = 10_000;

function puedeConsultarVerificamex(sessionId: string): boolean {
  const ahora = Date.now();
  const ultima = ultimaConsultaVerificamex.get(sessionId);
  if (ultima && ahora - ultima < INTERVALO_MIN_CONSULTA_MS) return false;

  ultimaConsultaVerificamex.set(sessionId, ahora);
  // La sesión de verificación dura minutos, no días: se limpian las entradas viejas para
  // que este Map no crezca sin límite en un proceso que corre semanas seguidas.
  if (ultimaConsultaVerificamex.size > 500) {
    for (const [id, ts] of ultimaConsultaVerificamex) {
      if (ahora - ts > 60 * 60 * 1000) ultimaConsultaVerificamex.delete(id);
    }
  }
  return true;
}

// GET: Estado de la verificación en vivo, para que la pantalla /verificacion lo consulte
// mientras espera. **No se limita a leer la base**: si la sesión sigue OPEN/VERIFYING
// para nosotros, le pregunta a Verificamex cómo va y aplica el resultado en el momento.
// Ese fallback es lo que hace que el flujo no dependa de que el webhook llegue —
// imprescindible en local (Verificamex no puede alcanzar localhost) y una red de
// seguridad en producción, donde un webhook perdido dejaría la solicitud colgada.
app.get('/api/solicitudes/:id/estado-verificacion', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const enCurso = solicitud.verificamex_status === 'OPEN' || solicitud.verificamex_status === 'VERIFYING';
    if (enCurso && solicitud.verificamex_session_id && puedeConsultarVerificamex(solicitud.verificamex_session_id)) {
      const sesion = await VerificamexService.consultarSesion(solicitud.verificamex_session_id);
      if (sesion && sesion.status !== solicitud.verificamex_status) {
        console.log(`[Verificamex] Polling: la sesión ${solicitud.verificamex_session_id} pasó a ${sesion.status}${sesion.comments ? ` (${sesion.comments})` : ''}.`);
        await procesarResultadoVerificamex(solicitud, sesion.status, sesion.result, sesion.comments, sesion.errores);
        solicitud = await PersistenceService.getSolicitudById(id);
      }
    }

    return res.status(200).json({
      estatus: solicitud.estatus,
      pagoConfirmado: solicitud.pago_confirmado === true,
      verificamexStatus: solicitud.verificamex_status || null,
      verificamexIntentos: Number(solicitud.verificamex_intentos || 0)
    });
  } catch (error: any) {
    console.error('Error al consultar el estado de la verificación:', error);
    return res.status(500).json({ error: 'No se pudo consultar el estado de la verificación.' });
  }
});

// Aplica el resultado de una VerificationSession a la solicitud. Compartida entre el
// webhook de Verificamex (camino rápido) y el polling de /estado-verificacion (camino
// confiable) — los dos tienen que hacer exactamente lo mismo, así que vive en un solo
// lugar. Es idempotente para los estados finales: si ya se procesó antes (estatus fuera
// de "Verificando identidad", o verificamex_status ya final) no vuelve a disparar
// Skydropx ni a contar el fallo de nuevo.
// Puntaje mínimo (0-100) para aprobar automático aunque el status ya diga FINISHED —
// Verificamex marca FINISHED cuando el *proceso* terminó, no cuando todos los chequeos
// pasaron: encontrado en vivo 2026-08-19 que 3 de 4 sesiones reales tenían status
// FINISHED con result 0 (Lista Nominal del INE inválida) y se habían aprobado igual,
// porque antes de esto solo se miraba el status. Confirmado con el usuario (70).
const VERIFICAMEX_PUNTAJE_MINIMO = 70;

async function procesarResultadoVerificamex(solicitud: any, status: string | undefined, result?: number | null, comments?: string | null, errores?: any[] | null) {
  if (status !== 'FINISHED' && status !== 'FAILED') {
    return; // OPEN/VERIFYING: todavía en curso, nada que hacer.
  }

  if (solicitud.verificamex_status === 'FINISHED' || solicitud.estatus !== 'Verificando identidad') {
    console.log(`[Verificamex] La solicitud ${solicitud.id} ya no está esperando verificación (estatus: ${solicitud.estatus}) — se ignora el resultado repetido.`);
    return;
  }

  let statusEfectivo = status;
  let commentsEfectivo = comments;

  if (status === 'FINISHED' && typeof result === 'number' && result < VERIFICAMEX_PUNTAJE_MINIMO) {
    console.warn(`[Verificamex] Puntaje insuficiente para la solicitud ${solicitud.id}: ${result} < ${VERIFICAMEX_PUNTAJE_MINIMO}.`);
    statusEfectivo = 'FAILED';
    commentsEfectivo = comments || `Puntaje de verificación insuficiente (${result}/100).`;
  }

  // Antes de aprobar, comparar el CURP que el cliente tipeó a mano (paso "Datos del
  // cliente") contra el que Verificamex validó de verdad contra RENAPO — no el OCR
  // crudo del INE, la consulta oficial. A diferencia de un puntaje bajo (arriba, que sí
  // deja reintentar), un CURP que no coincide pasa DIRECTO a revisión manual sin gastar
  // ninguno de los 3 intentos — decisión explícita del usuario: esto lo tiene que
  // resolver el equipo de atención al cliente a mano en /sadmin, no queda librado a que
  // el cliente reintente solo (podría ser un typo, pero también podría ser un documento
  // de otra persona). `null` (no se pudo determinar — sesión mock, error de red) no
  // cuenta como mismatch, solo se ignora el chequeo esa vez.
  if (statusEfectivo === 'FINISHED' && solicitud.curp && solicitud.verificamex_session_id) {
    const curpValidado = await VerificamexService.obtenerCurpValidado(solicitud.verificamex_session_id);
    if (curpValidado && curpValidado !== String(solicitud.curp).trim().toUpperCase()) {
      console.warn(`[Verificamex] CURP no coincide para la solicitud ${solicitud.id}: cliente tipeó "${solicitud.curp}", Verificamex validó "${curpValidado}" — pasa directo a revisión manual, sin gastar reintentos.`);
      const comentarioMismatch = `El CURP capturado (${solicitud.curp}) no coincide con el validado por RENAPO (${curpValidado}).`;
      await PersistenceService.registrarFalloVerificamex(solicitud.id, result, comentarioMismatch, errores);
      await PersistenceService.escalarRevisionManual(solicitud.id);
      try {
        await WhatsappOtpService.enviarVerificacionRevision(solicitud.id, solicitud.celular, solicitud.cliente);
      } catch (whatsappError: any) {
        console.error(`[Verificación] No se pudo avisar la revisión manual por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
      }
      return;
    }
  }

  if (statusEfectivo === 'FINISHED') {
    await aprobarYActivarEnvio(solicitud, result, comments, errores);
    return;
  }

  // FAILED (incluye puntaje insuficiente y CURP no coincidente de arriba): si ya se
  // contó este mismo fallo (el webhook y el polling pueden llegar los dos), no se
  // vuelve a incrementar el contador de intentos.
  if (solicitud.verificamex_status === 'FAILED') {
    console.log(`[Verificamex] El fallo de la solicitud ${solicitud.id} ya estaba registrado — no se cuenta dos veces.`);
    return;
  }

  const intentos = await PersistenceService.registrarFalloVerificamex(solicitud.id, result, commentsEfectivo, errores);
  if (intentos === null) {
    console.log(`[Verificamex] El fallo de la solicitud ${solicitud.id} lo registró otro camino en paralelo — no se cuenta dos veces.`);
    return;
  }
  console.log(`[Verificamex] Verificación fallida para la solicitud ${solicitud.id} (intento ${intentos}).`);

  // Sin reintentos automáticos: cualquier rechazo (puntaje bajo, FAILED real de
  // Verificamex) escala directo a revisión manual desde el primer intento — decisión
  // explícita del usuario 2026-08-19, mismo criterio que ya se usa para el CURP no
  // coincidente más arriba. `verificamex_intentos` se sigue incrementando solo como
  // historial/auditoría, ya no como gate para decidir cuándo escalar.
  await PersistenceService.escalarRevisionManual(solicitud.id);
  try {
    await WhatsappOtpService.enviarVerificacionRevision(solicitud.id, solicitud.celular, solicitud.cliente);
  } catch (whatsappError: any) {
    console.error(`[Verificación] No se pudo avisar la revisión manual por WhatsApp a la solicitud ${solicitud.id}: ${whatsappError.message}`);
  }
}

// Webhook real de Verificamex: recibe el objeto VerificationSession actualizado cada
// vez que cambia de estado. `optionals.solicitud_id` viaja desde que se creó la sesión
// (ver crear-sesion-verificamex) — se usa como forma principal de encontrar la
// solicitud, con el session id guardado como respaldo si por algo faltara.
app.post('/api/webhooks/verificamex', async (req: Request, res: Response) => {
  try {
    const sesion = req.body?.data || req.body;
    const status: string | undefined = sesion?.status;
    const sessionId: string | undefined = sesion?.id;
    const solicitudId: string | undefined = sesion?.optionals?.solicitud_id;
    const result: number | null = sesion?.result ?? null;
    const comments: string | null = sesion?.comments ?? null;
    const errores: any[] | null = sesion?.errors ?? null;

    console.log(`[Verificamex Webhook] Sesión ${sessionId} (solicitud ${solicitudId}) → status: ${status}`);

    let solicitud = solicitudId ? await PersistenceService.getSolicitudById(solicitudId) : null;
    if (!solicitud && sessionId) {
      solicitud = await PersistenceService.getSolicitudByVerificamexSessionId(sessionId);
    }
    if (!solicitud) {
      console.warn(`[Verificamex Webhook] No se encontró ninguna solicitud para la sesión ${sessionId}.`);
      return res.status(200).json({ received: true });
    }

    await procesarResultadoVerificamex(solicitud, status, result, comments, errores);

    return res.status(200).json({ received: true });
  } catch (error: any) {
    console.error('Error procesando webhook de Verificamex:', error);
    return res.status(500).json({ error: 'Error procesando webhook' });
  }
});

// POST: Dispara a mano el envío de links de pago semanal pendientes (OXXO/SPEI) — la
// misma lógica que corre sola todos los días por cron, expuesta para poder probarla
// sin esperar al horario programado.
app.post('/api/admin/cobros-semanales/procesar', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const origin = (req.headers.origin as string) || ALLOWED_ORIGINS[0];
    const [spei, oxxo] = await Promise.all([
      CobrosSemanalesService.procesarPendientes(),
      CobrosSemanalesService.procesarPendientesOxxo(origin),
    ]);
    return res.status(200).json({ success: true, spei, oxxo });
  } catch (error: any) {
    console.error('Error al procesar cobros semanales:', error.message);
    return res.status(500).json({ error: error.message || 'No se pudieron procesar los cobros semanales.' });
  }
});

// POST: dispara el mismo chequeo de entregas que corre solo por cron (ver más abajo),
// para poder probarlo sin esperar al horario programado.
app.post('/api/admin/entregas/procesar', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const resultado = await EntregasService.procesarPendientes();
    return res.status(200).json({ success: true, ...resultado });
  } catch (error: any) {
    console.error('Error al procesar entregas:', error.message);
    return res.status(500).json({ error: error.message || 'No se pudieron procesar las entregas.' });
  }
});

// Cron dos veces al día (9am y 9pm hora de Ciudad de México) que manda los
// recordatorios/vouchers de pago semanal pendientes por WhatsApp a quienes pagaron el
// enganche con OXXO/SPEI — ver cobrosSemanalesService.ts (SPEI reenvía la misma CLABE,
// OXXO genera un voucher nuevo cada vez). El segundo pase de las 21:00 (pedido de
// Eduardo 2026-08-28) achica la ventana entre que un cobro "vence" y que el cliente
// recibe el link: un vencimiento a media mañana ya no espera hasta el otro día.
// Correrlo dos veces es seguro y no duplica nada: `reclamarCobroSemanal` avanza
// `proximo_cobro_semanal` +7 días de forma atómica al mandar el aviso, así que el
// segundo pase del mismo día ya no lo agarra; y una vez que el plan está pagado
// (`semanas_pagadas >= semanas`) el filtro de getSolicitudesConCobro*Pendiente lo
// excluye. Corre en el mismo proceso porque Railway mantiene este servidor Express
// siempre corriendo (no es una función serverless).
cron.schedule('0 9,21 * * *', () => {
  console.log('[Cron] Procesando cobros semanales pendientes...');
  CobrosSemanalesService.procesarPendientes().catch((error) => {
    console.error('[Cron] Error al procesar cobros semanales (SPEI):', error.message);
  });
  CobrosSemanalesService.procesarPendientesOxxo(ALLOWED_ORIGINS[0]).catch((error) => {
    console.error('[Cron] Error al procesar cobros semanales (OXXO):', error.message);
  });
}, { timezone: 'America/Mexico_City' });

// Cron de recordatorios de acompañamiento del onboarding (pasos 2 a 7) — ver
// acompanamientoService.ts. Corre cada 15 minutos (antes: una vez al día a las 10am) para
// poder mandar el primer aviso a los 30 min de inactividad, pedido explícito de Eduardo
// 2026-08-19 ("para no dejar pasar tanto tiempo") — la lógica interna de
// AcompanamientoService es la que decide caso por caso si de verdad toca mandar algo
// (30 min para el primero, 1 por semana después), así que correr seguido es seguro, no
// manda de más. Los avisos en tiempo real (pago confirmado, verificación
// aprobada/rechazada, cancelación) no pasan por acá — esos disparan al toque desde el
// webhook/endpoint correspondiente, no dependen de este cron.
cron.schedule('*/15 * * * *', () => {
  console.log('[Cron] Procesando recordatorios de acompañamiento...');
  AcompanamientoService.procesarPendientes(ALLOWED_ORIGINS[0]).catch((error) => {
    console.error('[Cron] Error al procesar recordatorios de acompañamiento:', error.message);
  });
}, { timezone: 'America/Mexico_City' });

// Endpoint manual para probar el cron de acompañamiento sin esperar al horario.
app.post('/api/admin/acompanamiento/procesar', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await AcompanamientoService.procesarPendientes((req.headers.origin as string) || ALLOWED_ORIGINS[0]);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error al procesar recordatorios de acompañamiento a mano:', error);
    return res.status(500).json({ error: error.message || 'No se pudo procesar.' });
  }
});

// Cron diario que borra los códigos OTP ya expirados (no se usan para nada
// una vez pasado expira_en — ver PersistenceService.getOtpVerificado). Evita
// que otp_codigos crezca sin límite.
cron.schedule('0 4 * * *', () => {
  console.log('[Cron] Borrando códigos OTP expirados...');
  PersistenceService.eliminarOtpExpirados()
    .then((count) => console.log(`[Cron] ${count} códigos OTP expirados borrados.`))
    .catch((error) => {
      console.error('[Cron] Error al borrar códigos OTP expirados:', error.message);
    });
}, { timezone: 'America/Mexico_City' });

// Revisa el tracking de Skydropx de cada solicitud "Enviado" y, si ya figura como
// entregada, pasa el estatus a "Entregado" y avisa al cliente por WhatsApp — ver
// entregasService.ts. Polling en vez de webhook: no se confirmó si Skydropx Pro
// soporta webhooks de entrega para esta cuenta (ver conversación 2026-08-14).
//
// 4 veces al día (9, 13, 17 y 21 hora de CDMX) en vez de una sola a las 11: con una
// corrida diaria, un paquete entregado a las 11:05 recién se marcaba 24 h después y el
// cliente recibía el aviso al otro día. Con esta cadencia el peor caso baja a 4 h, y
// cubre la franja en que los paqueteros entregan de verdad. Cuesta poco: solo consulta
// los envíos que siguen en "Enviado" (hoy son 3) y no escribe nada si no cambió el
// estado.
cron.schedule('0 9,13,17,21 * * *', () => {
  console.log('[Cron] Revisando entregas pendientes de confirmar...');
  EntregasService.procesarPendientes().catch((error) => {
    console.error('[Cron] Error al procesar entregas:', error.message);
  });
}, { timezone: 'America/Mexico_City' });

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de Movinex corriendo de manera segura en http://localhost:${PORT}`);
});
