import { PersistenceService } from './persistenceService';
import { StripeService } from './stripeService';
import { WhatsappOtpService } from './whatsappOtpService';

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

export class CobrosSemanalesService {
  /**
   * Manda por WhatsApp un recordatorio con la CLABE persistente (ver
   * `StripeService.crearReferenciaPagoPersistente`, asignada una sola vez al confirmar
   * el enganche) a cada solicitud que pagó el enganche por SPEI a la que le toque hoy —
   * ver `PersistenceService.getSolicitudesConCobroSpeiPendiente`. No genera nada nuevo
   * en Stripe: el envío es solo un recordatorio de la misma cuenta de siempre, el
   * progreso real (`semanas_pagadas`) lo confirma el webhook `invoice.paid` cuando el
   * cliente efectivamente deposita. Se llama desde el cron diario (`index.ts`) y
   * también desde el endpoint admin de disparo manual. Cada solicitud se procesa de
   * forma independiente: si una falla, no bloquea a las demás.
   */
  static async procesarPendientes(): Promise<{ procesadas: number; fallidas: number }> {
    const pendientes = await PersistenceService.getSolicitudesConCobroSpeiPendiente();

    console.log(`[Cobros Semanales SPEI] ${pendientes.length} solicitud(es) con recordatorio de cobro semanal pendiente hoy.`);

    let procesadas = 0;
    let fallidas = 0;

    for (const solicitud of pendientes) {
      const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
      try {
        // Reclama el turno ANTES de mandar nada — si otra corrida en paralelo ya lo tomó,
        // se retira sin duplicar el WhatsApp (ver el comentario en persistenceService.ts).
        const reclamado = await PersistenceService.reclamarCobroSemanal(
          solicitud.id, solicitud.proximo_cobro_semanal, new Date(Date.now() + SIETE_DIAS_MS)
        );
        if (!reclamado) {
          console.log(`[Cobros Semanales SPEI] La solicitud ${solicitud.id} ya la tomó otra corrida en paralelo — se omite.`);
          continue;
        }

        if (!solicitud.stripe_clabe_referencia) {
          throw new Error('La solicitud no tiene una CLABE de referencia asignada todavía.');
        }

        await WhatsappOtpService.enviarRecordatorioPagoSemanal(
          solicitud.id,
          solicitud.celular,
          solicitud.cliente,
          solicitud.stripe_clabe_referencia,
          Number(solicitud.pago_semanal),
          numeroSemana
        );

        console.log(`[Cobros Semanales SPEI] Recordatorio #${numeroSemana} enviado para la solicitud ${solicitud.id}.`);
        procesadas++;
      } catch (error: any) {
        console.error(`[Cobros Semanales SPEI] No se pudo procesar la solicitud ${solicitud.id}:`, error.message);
        fallidas++;
      }
    }

    return { procesadas, fallidas };
  }

  /**
   * Genera un voucher de OXXO nuevo (`StripeService.crearPagoSemanalOxxo`) y lo manda
   * por WhatsApp a cada solicitud que pagó el enganche por OXXO a la que le toque hoy —
   * ver `PersistenceService.getSolicitudesConCobroOxxoPendiente`. A diferencia de SPEI,
   * acá SÍ se genera algo nuevo en Stripe cada vez: OXXO no soporta pagos recurrentes
   * ni una referencia fija reutilizable (ver el comentario en
   * `StripeService.crearPagoSemanalOxxo`). Si el cliente no paga el voucher de esta
   * semana, simplemente no avanza `semanas_pagadas` — el de la semana que viene lo
   * reemplaza, no hay lógica de reintento especial. `origin` es el dominio del sitio,
   * necesario para armar `success_url`/`cancel_url` de la Checkout Session.
   */
  static async procesarPendientesOxxo(origin: string): Promise<{ procesadas: number; fallidas: number }> {
    const pendientes = await PersistenceService.getSolicitudesConCobroOxxoPendiente();

    console.log(`[Cobros Semanales OXXO] ${pendientes.length} solicitud(es) con voucher de cobro semanal pendiente hoy.`);

    let procesadas = 0;
    let fallidas = 0;

    for (const solicitud of pendientes) {
      const numeroSemana = Number(solicitud.semanas_pagadas || 0) + 1;
      try {
        // Mismo reclamo atómico que la rama SPEI, antes de generar nada en Stripe.
        const reclamado = await PersistenceService.reclamarCobroSemanal(
          solicitud.id, solicitud.proximo_cobro_semanal, new Date(Date.now() + SIETE_DIAS_MS)
        );
        if (!reclamado) {
          console.log(`[Cobros Semanales OXXO] La solicitud ${solicitud.id} ya la tomó otra corrida en paralelo — se omite.`);
          continue;
        }

        if (!solicitud.stripe_customer_id) {
          throw new Error('La solicitud no tiene un customer_id de Stripe guardado todavía.');
        }

        const usarProduccion = StripeService.usaProduccion(solicitud.email);
        const { url } = await StripeService.crearPagoSemanalOxxo(
          solicitud.id,
          solicitud.stripe_customer_id,
          Number(solicitud.pago_semanal),
          numeroSemana,
          origin,
          usarProduccion
        );

        await WhatsappOtpService.enviarLinkPagoSemanalOxxo(
          solicitud.id,
          solicitud.celular,
          solicitud.cliente,
          url,
          Number(solicitud.pago_semanal),
          numeroSemana
        );

        console.log(`[Cobros Semanales OXXO] Voucher #${numeroSemana} generado y enviado para la solicitud ${solicitud.id}.`);
        procesadas++;
      } catch (error: any) {
        console.error(`[Cobros Semanales OXXO] No se pudo procesar la solicitud ${solicitud.id}:`, error.message);
        fallidas++;
      }
    }

    return { procesadas, fallidas };
  }
}
