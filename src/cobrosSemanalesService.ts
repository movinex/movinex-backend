import { PersistenceService } from './persistenceService';
import { WhatsappOtpService } from './whatsappOtpService';

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

export class CobrosSemanalesService {
  /**
   * Manda por WhatsApp un recordatorio con la CLABE persistente (ver
   * `StripeService.crearReferenciaPagoPersistente`, asignada una sola vez al confirmar
   * el enganche) a cada solicitud en cobro manual (enganche pagado con OXXO/SPEI) a la
   * que le toque hoy — ver `PersistenceService.getSolicitudesConCobroSemanalPendiente`.
   * No genera nada nuevo en Stripe: el envío es solo un recordatorio de la misma
   * cuenta de siempre, el progreso real (`semanas_pagadas`) lo confirma el webhook
   * `invoice.paid` cuando el cliente efectivamente deposita. Se llama desde el cron
   * diario (`index.ts`) y también desde el endpoint admin de disparo manual. Cada
   * solicitud se procesa de forma independiente: si una falla, no bloquea a las demás.
   */
  static async procesarPendientes(): Promise<{ procesadas: number; fallidas: number }> {
    const pendientes = await PersistenceService.getSolicitudesConCobroSemanalPendiente();

    console.log(`[Cobros Semanales] ${pendientes.length} solicitud(es) con recordatorio de cobro semanal pendiente hoy.`);

    let procesadas = 0;
    let fallidas = 0;

    for (const solicitud of pendientes) {
      const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
      try {
        if (!solicitud.stripe_clabe_referencia) {
          throw new Error('La solicitud no tiene una CLABE de referencia asignada todavía.');
        }

        await WhatsappOtpService.enviarRecordatorioPagoSemanal(
          solicitud.celular,
          solicitud.cliente,
          solicitud.stripe_clabe_referencia,
          Number(solicitud.pago_semanal),
          numeroSemana
        );

        await PersistenceService.programarProximoCobroSemanal(solicitud.id, new Date(Date.now() + SIETE_DIAS_MS));
        console.log(`[Cobros Semanales] Recordatorio #${numeroSemana} enviado para la solicitud ${solicitud.id}.`);
        procesadas++;
      } catch (error: any) {
        console.error(`[Cobros Semanales] No se pudo procesar la solicitud ${solicitud.id}:`, error.message);
        fallidas++;
      }
    }

    return { procesadas, fallidas };
  }
}
