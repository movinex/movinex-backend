import { PersistenceService } from './persistenceService';
import { SkydropxService } from './skydropxService';
import { WhatsappOtpService } from './whatsappOtpService';

export class EntregasService {
  /**
   * Consulta el tracking de Skydropx para cada solicitud "Enviado" con guía generada
   * (ver PersistenceService.getSolicitudesEnviadasConTracking) y, si ya figura como
   * entregada, pasa el estatus a "Entregado" y avisa al cliente por WhatsApp. Se llama
   * desde el cron diario (index.ts) y también desde el endpoint admin de disparo
   * manual — mismo patrón que CobrosSemanalesService. Cada solicitud se procesa de
   * forma independiente: si una falla (ej. Skydropx no tiene el tracking todavía), no
   * bloquea a las demás.
   */
  static async procesarPendientes(): Promise<{ entregadas: number; sinCambios: number; fallidas: number }> {
    const pendientes = await PersistenceService.getSolicitudesEnviadasConTracking();

    console.log(`[Entregas] ${pendientes.length} solicitud(es) "Enviado" con guía para revisar.`);

    let entregadas = 0;
    let sinCambios = 0;
    let fallidas = 0;

    for (const solicitud of pendientes) {
      try {
        const usarProduccion = solicitud.email?.trim().toLowerCase() !== 'desarrollo@movinex.mx';
        const resultado = await SkydropxService.consultarEstadoEntrega(
          solicitud.skydropx_shipment_id,
          usarProduccion
        );

        if (!resultado.entregado) {
          console.log(`[Entregas] Solicitud ${solicitud.id}: Skydropx todavía la reporta como "${resultado.status || 'sin estado'}".`);
          sinCambios++;
          continue;
        }

        await PersistenceService.marcarEntregado(solicitud.id);
        await WhatsappOtpService.enviarPedidoEntregado(solicitud.celular, solicitud.cliente, solicitud.modelo);
        console.log(`[Entregas] Solicitud ${solicitud.id} (${solicitud.modelo}) marcada como Entregado.`);
        entregadas++;
      } catch (error: any) {
        console.error(`[Entregas] No se pudo revisar la solicitud ${solicitud.id}:`, error.response?.data || error.message);
        fallidas++;
      }
    }

    return { entregadas, sinCambios, fallidas };
  }
}
