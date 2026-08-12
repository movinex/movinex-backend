import axios from 'axios';
import { PersistenceService } from './persistenceService';

const OTP_TTL_MINUTOS = 10;
const MAX_INTENTOS = 5;

export class WhatsappOtpService {
  private static ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  private static PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  private static TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE_NAME || 'movinex_otp';
  private static COBRO_TEMPLATE_NAME = process.env.WHATSAPP_COBRO_TEMPLATE_NAME || 'movinex_cobro_semanal';
  private static COBRO_OXXO_TEMPLATE_NAME = process.env.WHATSAPP_COBRO_OXXO_TEMPLATE_NAME || 'movinex_cobro_semanal_oxxo';
  private static PAGO_CONFIRMADO_TEMPLATE_NAME = process.env.WHATSAPP_PAGO_CONFIRMADO_TEMPLATE_NAME || 'movinex_pago_confirmado';
  private static ENVIADO_TEMPLATE_NAME = process.env.WHATSAPP_ENVIADO_TEMPLATE_NAME || 'movinex_pedido_enviado';
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
   * **Solo para clientes que pagaron el enganche por SPEI** (`metodo_pago_enganche:
   * 'customer_balance'`) — la CLABE nunca cambia semana a semana (decisión de negocio,
   * reunión 07/08: una referencia fija en vez de un link nuevo cada vez), así que este
   * mismo mensaje sirve de recordatorio todas las semanas. Los de OXXO usan
   * `enviarLinkPagoSemanalOxxo` en su lugar — OXXO no soporta una referencia fija
   * reutilizable (ver el comentario en `StripeService.crearPagoSemanalOxxo`). Usa la
   * plantilla `WHATSAPP_COBRO_TEMPLATE_NAME`, con la CLABE como texto plano en el body.
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

  /**
   * Recordatorio de pago semanal para clientes que pagaron el enganche con OXXO — a
   * diferencia de SPEI (`enviarRecordatorioPagoSemanal`, misma CLABE toda la vida),
   * cada semana hay un link nuevo (`StripeService.crearPagoSemanalOxxo`) porque OXXO no
   * soporta una referencia reutilizable. Necesita su propia plantilla porque el body es
   * distinto (manda un link, no una CLABE) — `WHATSAPP_COBRO_OXXO_TEMPLATE_NAME`.
   */
  static async enviarLinkPagoSemanalOxxo(
    celular: string,
    cliente: string,
    link: string,
    monto: number,
    numeroSemana: number
  ): Promise<{ mock: boolean }> {
    if (this.MOCK) {
      console.log(`[WhatsApp Cobro Semanal OXXO MOCK] ${celular} (${cliente}) — semana #${numeroSemana}, $${monto} MXN, link: ${link}`);
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
            name: this.COBRO_OXXO_TEMPLATE_NAME,
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: cliente },
                  { type: 'text', text: String(numeroSemana) },
                  { type: 'text', text: monto.toLocaleString('es-MX') },
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
      console.log(`[WhatsApp Cobro Semanal OXXO] Link de la semana #${numeroSemana} enviado a ${celular}.`);
      return { mock: false };
    } catch (error: any) {
      console.error('[WhatsApp Cobro Semanal OXXO] Error al enviar el link:', error.response?.data || error.message);
      throw new Error('No se pudo enviar el link de pago semanal (OXXO) por WhatsApp.');
    }
  }

  /**
   * Mensaje de cierre de ciclo: se manda cuando el admin marca la solicitud como
   * "Enviado" (paquete ya en manos de la paquetería) — avisa al cliente que su equipo
   * va en camino. Pedido de un compañero del equipo (vía WhatsApp interno, 10/08).
   */
  static async enviarPedidoEnviado(celular: string, cliente: string, modelo: string): Promise<{ mock: boolean }> {
    if (this.MOCK) {
      console.log(`[WhatsApp Pedido Enviado MOCK] ${celular} (${cliente}) — ${modelo} en camino.`);
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
            name: this.ENVIADO_TEMPLATE_NAME,
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: cliente },
                  { type: 'text', text: modelo }
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
      console.log(`[WhatsApp Pedido Enviado] Aviso de envío mandado a ${celular}.`);
      return { mock: false };
    } catch (error: any) {
      console.error('[WhatsApp Pedido Enviado] Error al enviar el aviso:', error.response?.data || error.message);
      throw new Error('No se pudo enviar el aviso de envío por WhatsApp.');
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
