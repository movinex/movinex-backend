import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PersistenceService } from './persistenceService';
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
    const solicitud = await PersistenceService.saveSolicitud(req.body);
    return res.status(201).json({
      success: true,
      message: 'Solicitud de crédito registrada con éxito.',
      solicitud
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
app.post('/api/webhooks/conekta', (req: Request, res: Response) => {
  const signature = req.headers['x-conekta-signature'] as string;
  const rawBody = JSON.stringify(req.body);

  const isValid = verifyConektaSignature(rawBody, signature, CONEKTA_WEBHOOK_SECRET);

  if (!isValid) {
    console.warn('Firma de webhook de Conekta inválida.');
    return res.status(401).json({ error: 'Firma de webhook inválida' });
  }

  // Procesar evento (por ejemplo, pago aprobado)
  const event = req.body;
  console.log('Webhook de Conekta verificado con éxito:', event.type);

  return res.status(200).json({ received: true });
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

// POST: Proxy para reenviar la verificación de cliente a n8n de manera segura sin CORS (Simulación con Timeout)
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
