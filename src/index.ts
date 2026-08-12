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

// Indicar a Express que confíe en los proxies (necesario en Railway / Heroku para rateLimit)
app.enable('trust proxy');

// DDoS Protection: Limitador de tasa (Rate Limiting)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Máximo 100 peticiones por IP en esta ventana
  standardHeaders: true, // Retorna info de límites en las cabeceras `RateLimit-*`
  legacyHeaders: false, // Desactiva cabeceras antiguas `X-RateLimit-*`
  message: {
    success: false,
    message: 'Demasiadas solicitudes desde esta IP, por favor intenta de nuevo en 15 minutos.'
  }
});

// Middleware de seguridad y parseo
app.use(helmet());
const ALLOWED_ORIGINS = [
  'https://www.movinex.mx',
  'https://movinex.mx',
  'http://localhost:10173',
];
app.use(cors({
  origin: ALLOWED_ORIGINS,
}));
app.use('/api/', apiLimiter); // Aplicar protección a todas las rutas bajo /api/

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
      tieneIneFrente: Boolean(solicitud.ine_frente),
      tieneIneReverso: Boolean(solicitud.ine_reverso),
      tieneSelfie: Boolean(solicitud.selfie),
      // null = todavía no se corrió esa verificación; false = corrió y no pasó (foto
      // ilegible o la cara no hizo match) — el frontend usa esto para no mostrar esas
      // fotos como "cargada correctamente" cuando en realidad son la causa de que la
      // solicitud haya quedado en revisión manual.
      ocrOk: solicitud.ocr_ok,
      biometricoOk: solicitud.biometrico_ok
    });
  } catch (error: any) {
    console.error('Error al obtener el resumen de la solicitud:', error);
    return res.status(500).json({ error: 'No se pudo obtener la solicitud.' });
  }
});

// PATCH: Guarda cada campo (email y/o fotos) apenas el cliente lo completa, sin esperar
// al submit final — así no se pierde nada si se cae del formulario a mitad de camino.
// El biométrico corre acá mismo en cuanto quedan disponibles frente + selfie (juntos en
// el mismo request, o uno ya guardado de una llamada anterior — en ese caso se
// descarga del bucket para volver a compararlo, porque el base64 original no se guarda).
app.patch('/api/solicitudes/:id/progreso', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email, ine_frente, ine_reverso, selfie } = req.body;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const emailActual = email !== undefined ? email : solicitud.email;

    // Paso rápido: subir lo que llegó al bucket y responder ya — Verificamex (OCR +
    // biométrico) pega a una API externa y puede tardar más de un segundo, no tiene
    // sentido que el cliente se quede mirando "Guardando..." en la foto todo ese
    // tiempo cuando lo único que de verdad hace falta ahí es que la imagen quede
    // guardada. La verificación corre después, en segundo plano (ver más abajo).
    const camposRapidos: Parameters<typeof PersistenceService.guardarProgresoSolicitud>[1] = {};
    if (email !== undefined) camposRapidos.email = email;
    if (ine_frente) camposRapidos.ine_frente = await PersistenceService.subirDocumentoKYC(ine_frente, 'ine_frente');
    if (ine_reverso) camposRapidos.ine_reverso = await PersistenceService.subirDocumentoKYC(ine_reverso, 'ine_reverso');
    if (selfie) camposRapidos.selfie = await PersistenceService.subirDocumentoKYC(selfie, 'selfie');

    const solicitudActualizada = await PersistenceService.guardarProgresoSolicitud(id, camposRapidos);
    res.status(200).json({ success: true, solicitud: solicitudActualizada });

    if (!ine_frente && !selfie) return;

    // Verificamex en segundo plano — ya se respondió, así que un error acá no debe
    // tirar una excepción no manejada hacia afuera de este handler.
    (async () => {
      try {
        const camposVerificacion: Parameters<typeof PersistenceService.guardarProgresoSolicitud>[1] = {};

        if (ine_frente) {
          const datosIne = await VerificamexService.leerDatosINE(ine_frente, emailActual);
          if (datosIne.nombre) camposVerificacion.cliente = datosIne.nombre;
          camposVerificacion.curp = datosIne.curp;
          // En modo mock (sin email "real") no se exige — ver el mismo criterio en /finalizar.
          camposVerificacion.ocr_ok = datosIne.rawData?.mock ? true : Boolean(datosIne.nombre) && Boolean(datosIne.curp);
        }

        const frenteB64 = ine_frente || (solicitud.ine_frente ? await PersistenceService.descargarDocumentoKYC(solicitud.ine_frente) : null);
        const selfieB64 = selfie || (solicitud.selfie ? await PersistenceService.descargarDocumentoKYC(solicitud.selfie) : null);
        if (frenteB64 && selfieB64) {
          const biometricResult = await VerificamexService.validarIdentidadBiometrica(frenteB64, selfieB64, emailActual);
          camposVerificacion.biometrico_ok = biometricResult.valido;
        }

        if (Object.keys(camposVerificacion).length > 0) {
          await PersistenceService.guardarProgresoSolicitud(id, camposVerificacion);
        }
      } catch (verificacionError: any) {
        console.error(`[Progreso] Verificamex falló en segundo plano para la solicitud ${id}:`, verificacionError.message);
      }
    })();
  } catch (error: any) {
    console.error('Error al guardar el progreso de la solicitud:', error);
    return res.status(500).json({ error: error.message || 'No se pudo guardar el progreso.' });
  }
});

// POST: Cierra el ciclo de la solicitud — sin body, todo lo demás ya se guardó
// progresivamente vía /progreso. Decide el estatus final con lo que ya quedó
// registrado (ocr_ok/biometrico_ok, null = ese paso nunca se completó, tratado como
// válido igual que hoy cuando faltan fotos).
app.post('/api/solicitudes/:id/finalizar', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { aceptaTerminos } = req.body;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const kycResult = await VerificamexService.validarTelefono(solicitud.celular);

    // `biometrico_ok`/`ocr_ok` pueden seguir en null acá aunque las fotos ya estén
    // subidas: el chequeo que dispara PATCH /progreso corre en segundo plano (fire-
    // and-forget, para que esa respuesta sea rápida) y todavía puede no haber
    // terminado si el cliente tocó "Enviar" muy rápido después de subir la selfie.
    // Tratar null como "válido" en ese caso es un bypass real de la verificación
    // (bug encontrado 2026-08-12: aprobó una solicitud con selfie de otra persona
    // porque el chequeo real terminó *después* de este endpoint). Si las fotos están
    // pero el resultado no llegó todavía, se corre acá mismo antes de decidir.
    let biometricoOkRaw = solicitud.biometrico_ok;
    let ocrOkRaw = solicitud.ocr_ok;
    let cliente = solicitud.cliente;
    let curp = solicitud.curp;

    if (solicitud.ine_frente && solicitud.selfie && biometricoOkRaw === null) {
      const [frenteB64, selfieB64] = await Promise.all([
        PersistenceService.descargarDocumentoKYC(solicitud.ine_frente),
        PersistenceService.descargarDocumentoKYC(solicitud.selfie)
      ]);
      const biometricResult = await VerificamexService.validarIdentidadBiometrica(frenteB64, selfieB64, solicitud.email);
      biometricoOkRaw = biometricResult.valido;

      if (ocrOkRaw === null) {
        const datosIne = await VerificamexService.leerDatosINE(frenteB64, solicitud.email);
        if (datosIne.nombre) cliente = datosIne.nombre;
        curp = datosIne.curp;
        ocrOkRaw = datosIne.rawData?.mock ? true : Boolean(datosIne.nombre) && Boolean(datosIne.curp);
      }
    }

    const biometricoOk = biometricoOkRaw !== false;
    const ocrOk = ocrOkRaw !== false;
    const esSolicitudValida = kycResult.valido && biometricoOk && ocrOk;
    const estatusFinal = esSolicitudValida ? 'Aprobado' : 'Pendiente';

    if (!esSolicitudValida) {
      console.warn(`[ALERTA DE RIESGO] Envío de alerta a desarrollo@movinex.mx: El cliente ${cliente} con teléfono ${solicitud.celular} no fue autorizado automáticamente por Verificamex (Teléfono: ${kycResult.valido ? 'OK' : 'RECHAZADO'}, Biometría: ${biometricoOk ? 'OK' : 'RECHAZADO'}, Lectura INE: ${ocrOk ? 'OK' : 'INCOMPLETA/ILEGIBLE'}).`);
    }

    const solicitudFinal = await PersistenceService.finalizarSolicitud(id, {
      cliente,
      curp,
      estatus: estatusFinal,
      acepta_terminos: Boolean(aceptaTerminos),
      ocr_ok: ocrOkRaw,
      biometrico_ok: biometricoOkRaw
    });

    return res.status(200).json({
      success: true,
      message: esSolicitudValida
        ? 'Solicitud de crédito aprobada y registrada con éxito.'
        : 'Solicitud registrada. Requiere verificación adicional.',
      solicitud: solicitudFinal
    });
  } catch (error: any) {
    console.error('Error al finalizar la solicitud:', error);
    return res.status(500).json({ error: error.message || 'No se pudo finalizar la solicitud.' });
  }
});

// POST: Enviar código OTP por WhatsApp (paso previo al pago del enganche)
app.post('/api/otp/enviar', async (req: Request, res: Response) => {
  try {
    const { celular } = req.body;
    const digitos = celular ? String(celular).replace(/\D/g, '') : '';
    // 10 dígitos: celular mexicano sin código de país (el caso real de un cliente).
    // 11-15: número con código de país incluido (ej. pruebas desde otros países).
    if (digitos.length < 10 || digitos.length > 15) {
      return res.status(400).json({ error: 'Se requiere un celular válido.' });
    }

    const { mock } = await WhatsappOtpService.enviarCodigo(celular);
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

    const origin = (req.headers.origin as string) || ALLOWED_ORIGINS[0];
    const successUrl = `${origin}/domicilio?solicitud=${id}&modelo=${encodeURIComponent(solicitud.modelo)}`;
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

// POST: Bypass TEMPORAL para marcar el enganche como pagado sin pasar por el
// procesador de pagos — pensado solo para poder seguir probando el resto del flujo
// (Skydropx/Domicilio) sin cobrar una tarjeta real. Quitar antes de ir a producción
// definitiva (ver Trello MX-0061).
app.post('/api/solicitudes/:id/aprobar-pago-manual', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const identificador = solicitud.email || solicitud.celular;
    await PersistenceService.marcarPagoConfirmadoByContacto(identificador);

    console.warn(`[BYPASS MANUAL] Enganche de la solicitud ${id} (${identificador}) marcado como pagado SIN pasar por el procesador de pagos.`);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error en aprobar-pago-manual:', error.message);
    return res.status(500).json({ error: 'No se pudo aprobar el pago manualmente.' });
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

    // Responder ya con el domicilio guardado — la guía de Skydropx (cotizar → elegir
    // tarifa → generar guía, con polling en cada paso) puede tardar varios segundos y no
    // hace falta que el cliente la espere en esta pantalla. Se genera atrás, sin bloquear
    // la respuesta; el admin la va a ver aparecer sola (guardarEnvio) apenas termine. El
    // pequeño delay es solo para que la pantalla no pegue el salto de "guardando..." a
    // "listo" de forma demasiado brusca.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res.status(200).json({ success: true, solicitud });

    SkydropxService.crearEnvio(
      solicitud.cliente,
      solicitud.celular,
      solicitud.email,
      {
        calle,
        numeroExterior: numero_exterior,
        numeroInterior: numero_interior,
        colonia,
        alcaldiaMunicipio: alcaldia_municipio,
        estado,
        codigoPostal: codigo_postal
      },
      solicitud.modelo
    )
      .then(async ({ trackingNumber, labelUrl, simulado }) => {
        if (simulado) {
          console.warn(`[Skydropx] Guía simulada para la solicitud ${id} — la llamada real a Skydropx falló o no está configurada.`);
        }
        // No se toca el estatus acá: lo mueve el admin a mano (Preparando paquete ->
        // Pendiente de envío -> Enviado). Esto solo guarda la guía.
        await PersistenceService.guardarEnvio(id, { tracking_number: trackingNumber, label_url: labelUrl });
        console.log(`[Skydropx] Guía generada en segundo plano para la solicitud ${id}: ${trackingNumber}`);
      })
      .catch((skydropxError: any) => {
        console.error(`[Skydropx] No se pudo generar la guía en segundo plano para la solicitud ${id}:`, skydropxError.message);
      });
  } catch (error: any) {
    console.error('Error al guardar domicilio:', error);
    return res.status(500).json({ error: error.message || 'Ocurrió un error al procesar el domicilio.' });
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
    const { estatus, imei } = req.body;

    if (imei !== undefined) {
      if (!String(imei).trim()) {
        return res.status(400).json({ error: 'El IMEI no puede estar vacío.' });
      }
      await PersistenceService.guardarImei(id, String(imei).trim());
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

    const solicitudActualizada = await PersistenceService.updateEstatus(id, estatus);

    if (estatus === 'Enviado') {
      try {
        await WhatsappOtpService.enviarPedidoEnviado(solicitudActualizada.celular, solicitudActualizada.cliente, solicitudActualizada.modelo);
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

// POST: Login para Super Administradores
app.post('/api/admin/login', async (req: Request, res: Response) => {
  try {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) {
      return res.status(400).json({ success: false, message: 'Usuario y clave requeridos.' });
    }

    const authResult = await SuperadminService.login(usuario, clave);
    if (!authResult.success) {
      return res.status(401).json(authResult);
    }

    return res.status(200).json(authResult);
  } catch (error: any) {
    console.error('Error en login superadmin:', error);
    return res.status(500).json({ success: false, message: error.message || 'Error en el servidor.' });
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

        const solicitudesActualizadas = await PersistenceService.marcarPagoConfirmadoByContacto(identificador);

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
        return res.status(200).json({ received: true });
      }

      const solicitud = await PersistenceService.getSolicitudById(solicitudId);
      if (!solicitud) {
        console.warn(`[Stripe Webhook] No se encontró la solicitud ${solicitudId}.`);
        return res.status(200).json({ received: true });
      }

      const identificador = solicitud.email || solicitud.celular;
      await PersistenceService.marcarPagoConfirmadoByContacto(identificador);
      console.log(`[Stripe Webhook] Pago confirmado para la solicitud ${solicitudId}.`);

      // Arma el cobro semanal automático a partir de cómo se pagó el enganche.
      // - Tarjeta: Subscription clásica cobrando la tarjeta guardada.
      // - SPEI (customer_balance): CLABE persistente + Subscription "send_invoice" que
      //   se cobra sola del saldo cuando el cliente deposita — el cliente recibe esa
      //   CLABE una vez por WhatsApp y la reutiliza todas las semanas.
      // - OXXO: nada de Subscription ni CLABE — OXXO no soporta cobro recurrente ni una
      //   referencia fija reutilizable (confirmado en la documentación de Stripe), así
      //   que solo se guarda el customer_id para poder generarle un voucher nuevo cada
      //   semana (ver cobrosSemanalesService.ts → procesarPendientesOxxo).
      if (customerId && paymentIntentId) {
        try {
          const { paymentMethodId, tipo, receiptUrl } = await StripeService.obtenerMetodoPagoDeIntent(paymentIntentId, usarProduccion);
          await PersistenceService.guardarMetodoPagoEnganche(solicitud.id, tipo);
          if (receiptUrl) {
            await PersistenceService.guardarReciboPago(solicitud.id, receiptUrl);
          }

          if (tipo === 'oxxo') {
            await PersistenceService.guardarStripeCustomerId(solicitud.id, customerId);
            // Mismo criterio que SPEI: el primer cobro real vence en 7 días, el cron
            // (cobrosSemanalesService.ts) genera el primer voucher ese día, no acá.
            await PersistenceService.programarProximoCobroSemanal(solicitud.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

            try {
              const linkContinuar = `${ALLOWED_ORIGINS[0]}/domicilio?solicitud=${solicitud.id}&modelo=${encodeURIComponent(solicitud.modelo)}`;
              await WhatsappOtpService.enviarConfirmacionPago(solicitud.celular, solicitud.cliente, linkContinuar);
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
              const linkContinuar = `${ALLOWED_ORIGINS[0]}/domicilio?solicitud=${solicitud.id}&modelo=${encodeURIComponent(solicitud.modelo)}`;
              await WhatsappOtpService.enviarConfirmacionPago(solicitud.celular, solicitud.cliente, linkContinuar);
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
app.post('/api/webhooks/verificacion-cliente', async (req: Request, res: Response) => {
  try {
    console.log('Iniciando simulación de verificación KYC...');
    
    // Simular un retraso/timeout de 3 segundos para el análisis biométrico
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Simulación completada con éxito. Cliente verificado.');

    // Responder con un JSON de éxito idéntico a una validación real
    return res.status(200).json({
      success: true,
      score: 0.98,
      status: "APPROVED",
      message: "Verificación de identidad simulada exitosamente."
    });
  } catch (error: any) {
    console.error('Error en simulación:', error);
    return res.status(500).json({ error: 'Error al conectar con el servidor de verificación.' });
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

// Cron diario (9am hora de Ciudad de México) que manda los recordatorios/vouchers de
// pago semanal pendientes por WhatsApp a quienes pagaron el enganche con OXXO/SPEI —
// ver cobrosSemanalesService.ts (SPEI reenvía la misma CLABE, OXXO genera un voucher
// nuevo cada vez). Corre en el mismo proceso porque Railway mantiene este servidor
// Express siempre corriendo (no es una función serverless).
cron.schedule('0 9 * * *', () => {
  console.log('[Cron] Procesando cobros semanales pendientes...');
  CobrosSemanalesService.procesarPendientes().catch((error) => {
    console.error('[Cron] Error al procesar cobros semanales (SPEI):', error.message);
  });
  CobrosSemanalesService.procesarPendientesOxxo(ALLOWED_ORIGINS[0]).catch((error) => {
    console.error('[Cron] Error al procesar cobros semanales (OXXO):', error.message);
  });
}, { timezone: 'America/Mexico_City' });

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

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de Movinex corriendo de manera segura en http://localhost:${PORT}`);
});
