import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PersistenceService } from './persistenceService';
import { VerificamexService } from './verificamexService';
import { ConektaService } from './conektaService';
import { verifyConektaSignature, generateMdmCommandToken } from './security';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CONEKTA_WEBHOOK_SECRET = process.env.CONEKTA_WEBHOOK_SECRET || 'supersecretwebhookkey';
const MDM_JWT_SECRET = process.env.MDM_JWT_SECRET || 'supersecretmdmjwtkey';

// Middleware de seguridad y parseo
app.use(helmet());
app.use(cors({
  origin: '*' 
}));
app.use(express.json({ limit: '50mb' })); 

// Endpoint de verificación de salud
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// GET: Obtener todas las solicitudes para el Backoffice
app.get('/api/solicitudes', async (req: Request, res: Response) => {
  try {
    const solicitudes = await PersistenceService.getSolicitudes();
    return res.status(200).json(solicitudes);
  } catch (error: any) {
    console.error('Error al obtener solicitudes:', error);
    return res.status(500).json({ error: error.message || 'Error al obtener solicitudes.' });
  }
});

// GET: Obtener catálogo de celulares desde Supabase
app.get('/api/celulares', async (req: Request, res: Response) => {
  try {
    const celulares = await PersistenceService.getCelulares();
    return res.status(200).json(celulares);
  } catch (error: any) {
    console.error('Error al obtener celulares:', error);
    return res.status(500).json({ error: error.message || 'Error al obtener celulares.' });
  }
});

// POST: Crear solicitud de crédito de manera segura
app.post('/api/solicitudes', async (req: Request, res: Response) => {
  try {
    const { cliente, celular, email } = req.body;

    console.log(`[Backend] Procesando nueva solicitud para: ${cliente} (${celular})`);

    // 1. Validar el teléfono usando Verificamex
    const kycResult = await VerificamexService.validarTelefono(celular);
    
    // Si es válido, se aprueba de inmediato. Si no, queda como 'Pendiente' (o 'Rechazado' según política)
    // Para la demo, todas las solicitudes están aprobadas mientras verificamex de autorizado (valido === true).
    const estatusInicial = kycResult.valido ? 'Aprobado' : 'Pendiente';

    // 2. Si no es autorizado, enviar alerta por email a info@movinex.mx (simulado por consola en backend)
    if (!kycResult.valido) {
      console.warn(`[ALERTA DE RIESGO] Envío de alerta a info@movinex.mx: El cliente ${cliente} con teléfono ${celular} no fue autorizado automáticamente por Verificamex.`);
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

    // 4. Guardar en base de datos con el estatus dictaminado y la URL de pago
    const solicitud = await PersistenceService.saveSolicitud({
      ...req.body,
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

// PATCH: Actualizar estatus (Aprobar/Rechazar) desde el Backoffice
app.patch('/api/solicitudes/:id', async (req: Request, res: Response) => {
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

// POST: Endpoint seguro para recibir webhooks de Conekta (Verificamex/Pagos) con validación HMAC
app.post('/api/webhooks/conekta', async (req: Request, res: Response) => {
  const signature = req.headers['x-conekta-signature'] as string;
  const rawBody = JSON.stringify(req.body);

  // Validación de firma HMAC (seguridad para comprobar origen legítimo)
  const isValid = verifyConektaSignature(rawBody, signature, CONEKTA_WEBHOOK_SECRET);

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

      // Intentar actualizar el estatus de la solicitud a 'Aprobado' o 'Pagado' en Supabase
      if (email || phone) {
        const identificador = email || phone;
        const solicitudesActualizadas = await PersistenceService.updateEstatusByContacto(identificador, 'Aprobado');
        
        if (solicitudesActualizadas && solicitudesActualizadas.length > 0) {
          console.log(`[Conekta Webhook] Se actualizaron ${solicitudesActualizadas.length} solicitudes del cliente a 'Aprobado'.`);
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
