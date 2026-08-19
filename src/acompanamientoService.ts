import { PersistenceService } from './persistenceService';
import { WhatsappOtpService } from './whatsappOtpService';

const HORA_MS = 60 * 60 * 1000;
const TREINTA_MIN_MS = 30 * 60 * 1000;
const UNA_SEMANA_MS = 7 * 24 * HORA_MS;

/**
 * Cron de "acompañamiento" — recordatorios de WhatsApp para quien se queda a mitad de
 * camino en el flujo de onboarding (pasos 2 a 7). Corre cada 15 minutos (no una vez al
 * día) para poder mandar el primer recordatorio pronto: 30 minutos después de su último
 * paso si no siguió — pedido explícito de Eduardo 2026-08-19, "para no dejar pasar
 * tanto tiempo". A partir de ese primer aviso, uno por semana mientras siga trabada en
 * el mismo paso (antes era uno por día — Jonathan lo bajó a semanal en la misma
 * conversación, para no mandar de más). Los avisos en tiempo real (pago confirmado,
 * verificación aprobada/rechazada, cancelación) NO pasan por acá — esos se disparan al
 * toque desde el webhook/endpoint correspondiente en index.ts, sin esperar a este cron.
 */
export class AcompanamientoService {
  static async procesarPendientes(origin: string): Promise<void> {
    const solicitudes = await PersistenceService.getSolicitudesActivasParaRecordatorio();
    const ahora = Date.now();

    for (const solicitud of solicitudes) {
      try {
        await this.procesarUna(solicitud, ahora, origin);
      } catch (error: any) {
        console.error(`[Acompañamiento] Error procesando la solicitud ${solicitud.id}:`, error.message);
      }
    }
  }

  // Primer recordatorio a los 30 min de inactividad en el paso actual; de ahí en más,
  // uno por semana mientras siga sin avanzar.
  private static puedeRecordar(s: any, ahora: number, transcurridoDesdeUltimoPaso: number): boolean {
    if (!s.ultimo_recordatorio_enviado_at) {
      return transcurridoDesdeUltimoPaso >= TREINTA_MIN_MS;
    }
    return (ahora - new Date(s.ultimo_recordatorio_enviado_at).getTime()) >= UNA_SEMANA_MS;
  }

  private static async procesarUna(s: any, ahora: number, origin: string): Promise<void> {
    if (s.estatus === 'Iniciada') {
      return this.procesarIniciada(s, ahora, origin);
    }
    if (s.estatus === 'Lista para pago') {
      return this.procesarListaParaPago(s, ahora, origin);
    }
    if (s.estatus === 'Verificando identidad') {
      return this.procesarVerificandoIdentidad(s, ahora, origin);
    }
  }

  // Pasos 2→3-4 y 4→5: distingue cuál de los dos según qué campos ya tiene guardados.
  private static async procesarIniciada(s: any, ahora: number, origin: string): Promise<void> {
    const transcurrido = ahora - new Date(s.created_at).getTime();
    if (!this.puedeRecordar(s, ahora, transcurrido)) return;

    const faltanDatosODireccion = !s.calle || !s.curp;
    const link = `${origin}/documentos?solicitud=${s.id}`;

    if (faltanDatosODireccion) {
      await WhatsappOtpService.enviarDatosPendientes(s.celular, s.modelo, link);
      await PersistenceService.registrarRecordatorioEnviado(s.id, 'datos_pendientes');
      return;
    }

    if (!s.acepta_terminos) {
      await WhatsappOtpService.enviarTerminosPendientes(s.celular, s.cliente, s.modelo, link);
      await PersistenceService.registrarRecordatorioEnviado(s.id, 'terminos_pendientes');
    }
  }

  // Paso 5→6: aceptó términos pero no pagó — primer recordatorio a los 30 min, después
  // uno por semana mientras siga así.
  private static async procesarListaParaPago(s: any, ahora: number, origin: string): Promise<void> {
    const transcurrido = ahora - new Date(s.created_at).getTime();
    if (!this.puedeRecordar(s, ahora, transcurrido)) return;

    const link = `${origin}/documentos?solicitud=${s.id}`;
    await WhatsappOtpService.enviarPagoPendiente(s.celular, s.cliente, s.modelo, Number(s.enganche), link);
    await PersistenceService.registrarRecordatorioEnviado(s.id, 'pago_pendiente');
  }

  // Paso 6→7: ya pagó, todavía no arrancó la verificación en vivo — el más urgente de
  // todos, primer recordatorio a los 30 min, después uno por semana. Ya no cubre el
  // caso "falló y le quedan reintentos": desde 2026-08-19 cualquier rechazo escala
  // directo a revisión manual (estatus pasa a "Pendiente"), así que una solicitud con
  // verificamex_status FAILED nunca sigue en "Verificando identidad" para que este
  // método la vea.
  private static async procesarVerificandoIdentidad(s: any, ahora: number, origin: string): Promise<void> {
    if (s.verificamex_session_id) return;

    const referencia = s.pago_confirmado_at ? new Date(s.pago_confirmado_at).getTime() : new Date(s.created_at).getTime();
    const transcurrido = ahora - referencia;
    if (!this.puedeRecordar(s, ahora, transcurrido)) return;

    const link = `${origin}/verificacion?solicitud=${s.id}&modelo=${encodeURIComponent(s.modelo)}`;
    await WhatsappOtpService.enviarVerificacionPendiente(s.celular, s.cliente, s.modelo, link);
    await PersistenceService.registrarRecordatorioEnviado(s.id, 'verificacion_pendiente');
  }
}
