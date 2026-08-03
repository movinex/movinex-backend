import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PersistenceService } from './persistenceService';
import { VerificamexService } from './verificamexService';
import { ConektaService } from './conektaService';
import { SkydropxService } from './skydropxService';
import { WhatsappOtpService } from './whatsappOtpService';
import { verifyConektaSignature, generateMdmCommandToken } from './security';
import { SuperadminService } from './superadminService';
import { requireAdminAuth } from './adminAuth';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10500;
const CONEKTA_PUBLIC_KEY = process.env.CONEKTA_PUBLIC_KEY || '';
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
app.use(express.json({ limit: '50mb' })); 

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

    console.log(`[Backend] Procesando nueva solicitud para: ${cliente} (${celular})`);

    // 1. Validar el teléfono usando Verificamex
    const kycResult = await VerificamexService.validarTelefono(celular);

    // 1b. Realizar la validación biométrica facial (INE vs Selfie) real usando Verificamex
    let biometricResult = { valido: true, score: 1 };
    if (req.body.ine_frente && req.body.selfie) {
      biometricResult = await VerificamexService.validarIdentidadBiometrica(req.body.ine_frente, req.body.selfie, email);
    }

    // 1c. Leer nombre y CURP reales del frente del INE por OCR (Verificamex)
    if (req.body.ine_frente) {
      const datosIne = await VerificamexService.leerDatosINE(req.body.ine_frente, email);
      if (datosIne.nombre) cliente = datosIne.nombre;
      curp = datosIne.curp;
    }

    // Si ambos son válidos, se aprueba de inmediato.
    const esSolicitudValida = kycResult.valido && biometricResult.valido;
    const estatusInicial = esSolicitudValida ? 'Aprobado' : 'Pendiente';

    // 2. Si no es autorizado, enviar alerta por email a desarrollo@movinex.mx (simulado por consola en backend)
    if (!esSolicitudValida) {
      console.warn(`[ALERTA DE RIESGO] Envío de alerta a desarrollo@movinex.mx: El cliente ${cliente} con teléfono ${celular} no fue autorizado automáticamente por Verificamex (Teléfono: ${kycResult.valido ? 'OK' : 'RECHAZADO'}, Biometría: ${biometricResult.valido ? 'OK' : 'RECHAZADO'}).`);
    }

    // 3. Generar Link de Pago en Conekta para el enganche
    let checkoutUrl = '';
    try {
      checkoutUrl = await ConektaService.crearCheckoutEnganche(
        cliente,
        email,
        celular,
        req.body.modelo,
        Number(req.body.enganche)
      );
    } catch (conektaError: any) {
      console.error('[Conekta] No se pudo generar el link de pago:', conektaError.message);
      // fallback temporal por si hay algún problema con la API Key en modo pruebas
      checkoutUrl = 'https://pay.conekta.com/checkout/simulado-tests';
    }

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

// POST: Enviar código OTP por WhatsApp (paso previo al pago del enganche)
app.post('/api/otp/enviar', async (req: Request, res: Response) => {
  try {
    const { celular } = req.body;
    if (!celular || String(celular).replace(/\D/g, '').length !== 10) {
      return res.status(400).json({ error: 'Se requiere un celular válido de 10 dígitos.' });
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

// POST: Crea la Orden del enganche para pagarla con el Checkout Component embebido de
// Conekta. La confirmación real del pago llega después por el webhook order.paid.
app.post('/api/solicitudes/:id/crear-orden-enganche', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const { orderId, checkoutId } = await ConektaService.crearOrdenEnganche(
      solicitud.cliente,
      solicitud.email,
      solicitud.celular,
      solicitud.modelo,
      Number(solicitud.enganche)
    );

    console.log(`[Conekta] Orden ${orderId} creada para la solicitud ${id}, esperando pago vía Checkout Component.`);
    return res.status(200).json({ success: true, checkoutId });
  } catch (error: any) {
    console.error('Error al crear la orden del enganche:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message || 'Ocurrió un error al iniciar el pago del enganche.' });
  }
});

// POST: Bypass TEMPORAL para marcar el enganche como pagado sin pasar por Conekta,
// mientras la cuenta de Conekta siga sin validar (ver Trello MX-0058) y el checkout
// no deje completar un pago real. Pensado solo para poder seguir probando el resto
// del flujo (Skydropx/Domicilio) — quitar en cuanto Conekta apruebe la cuenta.
app.post('/api/solicitudes/:id/aprobar-pago-manual', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const solicitud = await PersistenceService.getSolicitudById(id);
    if (!solicitud) {
      return res.status(404).json({ error: 'Solicitud no encontrada.' });
    }

    const identificador = solicitud.email || solicitud.celular;
    await PersistenceService.marcarPagoConfirmadoByContacto(identificador);

    console.warn(`[BYPASS MANUAL] Enganche de la solicitud ${id} (${identificador}) marcado como pagado SIN pasar por Conekta.`);
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

    const { trackingNumber, labelUrl, simulado } = await SkydropxService.crearEnvio(
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
    );

    if (simulado) {
      console.warn(`[Skydropx] Guía simulada para la solicitud ${id} — la llamada real a Skydropx falló o no está configurada.`);
    }

    const [solicitudesActualizadas] = await PersistenceService.updateEstatusByContacto(
      solicitud.email,
      'Preparando paquete',
      { tracking_number: trackingNumber, label_url: labelUrl }
    );

    return res.status(200).json({
      success: true,
      solicitud: solicitudesActualizadas || solicitud,
      trackingNumber,
      labelUrl
    });
  } catch (error: any) {
    console.error('Error al guardar domicilio y generar envío:', error);
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
    const { estatus } = req.body;

    if (estatus !== 'Aprobado' && estatus !== 'Rechazado') {
      return res.status(400).json({ error: 'Estatus no válido.' });
    }

    const solicitudActualizada = await PersistenceService.updateEstatus(id, estatus);
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

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor de Movinex corriendo de manera segura en http://localhost:${PORT}`);
});
