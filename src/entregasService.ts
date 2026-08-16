import { PersistenceService } from './persistenceService';
import { SkydropxService } from './skydropxService';
import { WhatsappOtpService } from './whatsappOtpService';

/**
 * Resume el error de una llamada HTTP para el log. Cuando Skydropx responde con una
 * página HTML en vez de JSON (pasaba a diario contra el sandbox), volcar
 * `error.response.data` crudo escupía el documento entero — decenas de líneas con
 * `<meta>`, `csrf-token` y demás, que en los logs de producción parecían un intento
 * de intrusión. Se corta a un extracto y se conserva el status HTTP, que es lo
 * único accionable.
 */
function resumirError(error: any): string {
  const status = error.response?.status;
  const data = error.response?.data;
  const prefijo = status ? `HTTP ${status}` : 'sin respuesta';

  if (data == null) return `${prefijo}: ${error.message}`;
  if (typeof data === 'string') {
    const esHtml = /^\s*<(!doctype|html)/i.test(data);
    return esHtml
      ? `${prefijo}: el servicio devolvió HTML en vez de JSON (${data.length} bytes)`
      : `${prefijo}: ${data.slice(0, 300)}`;
  }
  return `${prefijo}: ${JSON.stringify(data).slice(0, 300)}`;
}

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
        const resultado = await SkydropxService.consultarEstadoEntrega(
          solicitud.tracking_number,
          solicitud.skydropx_carrier
        );

        if (!resultado.entregado) {
          sinCambios++;
          continue;
        }

        await PersistenceService.marcarEntregado(solicitud.id);
        await WhatsappOtpService.enviarPedidoEntregado(solicitud.celular, solicitud.cliente, solicitud.modelo);
        console.log(`[Entregas] Solicitud ${solicitud.id} (${solicitud.modelo}) marcada como Entregado.`);
        entregadas++;
      } catch (error: any) {
        console.error(
          `[Entregas] No se pudo revisar la solicitud ${solicitud.id}:`,
          resumirError(error)
        );
        fallidas++;
      }
    }

    return { entregadas, sinCambios, fallidas };
  }
}
