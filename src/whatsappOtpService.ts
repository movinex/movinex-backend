import axios from 'axios';
import { PersistenceService } from './persistenceService';

const OTP_TTL_MINUTOS = 10;
const MAX_INTENTOS = 5;

export class WhatsappOtpService {
  private static ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  private static PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  private static TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE_NAME || 'movinex_otp';
  private static MOCK = process.env.WHATSAPP_OTP_MOCK === 'true' || !this.ACCESS_TOKEN || !this.PHONE_NUMBER_ID;
  private static GRAPH_URL = 'https://graph.facebook.com/v20.0';

  private static generarCodigo(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
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
          to: celular.startsWith('52') ? celular : `52${celular}`,
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
