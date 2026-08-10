import axios from 'axios';
import { PersistenceService } from './persistenceService';

const OTP_TTL_MINUTOS = 10;
const MAX_INTENTOS = 5;

export class WhatsappOtpService {
  private static ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  private static PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  private static TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE_NAME || 'movinex_otp';
  private static COBRO_TEMPLATE_NAME = process.env.WHATSAPP_COBRO_TEMPLATE_NAME || 'movinex_cobro_semanal';
  private static PAGO_CONFIRMADO_TEMPLATE_NAME = process.env.WHATSAPP_PAGO_CONFIRMADO_TEMPLATE_NAME || 'movinex_pago_confirmado';
  private static MOCK = process.env.WHATSAPP_OTP_MOCK === 'true' || !this.ACCESS_TOKEN || !this.PHONE_NUMBER_ID;
  private static GRAPH_URL = 'https://graph.facebook.com/v20.0';

  private static generarCodigo(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /**
   * Arma el número en el formato que espera la API de WhatsApp (código de país +
   * número, sin signos). Los clientes reales son mexicanos y solo cargan su celular
   * de 10 dígitos sin código de país, así que ese caso sigue asumiendo México (+52).
   * Si el número ya trae más de 10 dígitos, se asume que el código de país ya viene
   * incluido (ej. pruebas desde otros países) y se manda tal cual.
   */
  private static formatearNumero(celular: string): string {
    const soloDigitos = celular.replace(/\D/g, '');
    return soloDigitos.length === 10 ? `52${soloDigitos}` : soloDigitos;
  }

  /**
   * Envía un código OTP de 6 dígitos por WhatsApp usando una plantilla de tipo
   * Authentication ya aprobada por Meta. Requiere WHATSAPP_ACCESS_TOKEN +
   * WHATSAPP_PHONE_NUMBER_ID configurados y la plantilla (WHATSAPP_OTP_TEMPLATE_NAME)
   * dada de alta y aprobada en el WhatsApp Business Manager. Mientras eso no esté
   * listo, o en desarrollo local, cae al modo mock (loguea el código por consola).
   */
  static async enviarCodigo(celular: string): Promise<{ mock: boolean }> {
    const codigo = this.generarCodigo();
    const expiraEn = new Date(Date.now() + OTP_TTL_MINUTOS * 60 * 1000);

    await PersistenceService.guardarOtp(celular, codigo, expiraEn);

    if (this.MOCK) {
      console.log(`[WhatsApp OTP MOCK] Código para ${celular}: ${codigo} (válido ${OTP_TTL_MINUTOS} min)`);
      return { mock: true };
    }

    try {
      await axios.post(
        `${this.GRAPH_URL}/${this.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: this.formatearNumero(celular),
          type: 'template',
          template: {
            name: this.TEMPLATE_NAME,
            language: { code: 'es_MX' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: codigo }] },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: codigo }] }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`[WhatsApp OTP] Código enviado a ${celular}.`);
      return { mock: false };
    } catch (error: any) {
      console.error('[WhatsApp OTP] Error al enviar el código:', error.response?.data || error.message);
      throw new Error('No se pudo enviar el código de verificación por WhatsApp.');
    }
  }

  /**
   * Manda la referencia de pago (CLABE persistente) para el cobro semanal manual —
   * ver `StripeService.crearReferenciaPagoPersistente` y `cobrosSemanalesService.ts`.
   * Un mismo mensaje sirve para dos momentos: (1) una sola vez, apenas se confirma el
   * enganche, para avisarle al cliente su CLABE fija; (2) cada semana después, como
   * recordatorio con el mismo número — nunca cambia (decisión de negocio, reunión
   * 07/08: una referencia fija en vez de un link nuevo cada vez). Usa la plantilla
   * `WHATSAPP_COBRO_TEMPLATE_NAME`, con la CLABE como texto plano en el body.
   */
  static async enviarRecordatorioPagoSemanal(
    celular: string,
    cliente: string,
    clabe: string,
    monto: number,
    numeroSemana: number
  ): Promise<{ mock: boolean }> {
    if (this.MOCK) {
      console.log(`[WhatsApp Cobro Semanal MOCK] ${celular} (${cliente}) — semana #${numeroSemana}, $${monto} MXN a la CLABE ${clabe}`);
      return { mock: true };
    }

    try {
      await axios.post(
        `${this.GRAPH_URL}/${this.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: this.formatearNumero(celular),
          type: 'template',
          template: {
            name: this.COBRO_TEMPLATE_NAME,
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: cliente },
                  { type: 'text', text: String(numeroSemana) },
                  { type: 'text', text: monto.toLocaleString('es-MX') },
                  { type: 'text', text: clabe }
                ]
              }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`[WhatsApp Cobro Semanal] Recordatorio de la semana #${numeroSemana} enviado a ${celular}.`);
      return { mock: false };
    } catch (error: any) {
      console.error('[WhatsApp Cobro Semanal] Error al enviar el recordatorio:', error.response?.data || error.message);
      throw new Error('No se pudo enviar el recordatorio de pago semanal por WhatsApp.');
    }
  }

  /**
   * Avisa que el enganche pagado con OXXO/SPEI ya se confirmó, con un link para que el
   * cliente vuelva a completar su domicilio de envío. A diferencia de tarjeta (donde
   * Stripe lo redirige solo de vuelta al navegador vía success_url), el pago con
   * OXXO/SPEI se confirma horas o días después (webhook async_payment_succeeded) y el
   * cliente ya no está frente a la pantalla — sin este mensaje no se entera de que
   * puede continuar. El link va como texto plano, no como botón de URL dinámica: el
   * botón de WhatsApp solo admite variar un sufijo fijo sobre un dominio fijo, y este
   * link lleva una query string completa (?solicitud=X&modelo=Y).
   */
  static async enviarConfirmacionPago(celular: string, cliente: string, link: string): Promise<{ mock: boolean }> {
    if (this.MOCK) {
      console.log(`[WhatsApp Pago Confirmado MOCK] ${celular} (${cliente}) — link para continuar: ${link}`);
      return { mock: true };
    }

    try {
      await axios.post(
        `${this.GRAPH_URL}/${this.PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: this.formatearNumero(celular),
          type: 'template',
          template: {
            name: this.PAGO_CONFIRMADO_TEMPLATE_NAME,
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: cliente },
                  { type: 'text', text: link }
                ]
              }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`[WhatsApp Pago Confirmado] Confirmación de pago enviada a ${celular}.`);
      return { mock: false };
    } catch (error: any) {
      console.error('[WhatsApp Pago Confirmado] Error al enviar la confirmación:', error.response?.data || error.message);
      throw new Error('No se pudo enviar la confirmación de pago por WhatsApp.');
    }
  }

  static async verificarCodigo(celular: string, codigo: string): Promise<boolean> {
    const otp = await PersistenceService.getOtpVigente(celular);

    if (!otp) return false;
    if (otp.intentos >= MAX_INTENTOS) return false;

    if (otp.codigo !== codigo) {
      await PersistenceService.incrementarIntentoOtp(otp.id, otp.intentos + 1);
      return false;
    }

    // No se borra: queda marcado como verificado para que POST /api/solicitudes pueda
    // confirmar server-side que este número realmente pasó por el OTP (si solo lo
    // validáramos en el frontend, un bot podría pegarle directo a la API y saltárselo).
    // Sigue siendo válido solo hasta expira_en, la misma ventana de 10 minutos del código.
    await PersistenceService.marcarOtpVerificado(otp.id);
    return true;
  }
}
