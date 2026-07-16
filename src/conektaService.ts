import axios from 'axios';

/**
 * Servicio encargado de la comunicación con la API de Conekta v2.
 */
export class ConektaService {
  private static API_KEY = process.env.CONEKTA_API_KEY;
  private static BASE_URL = 'https://api.conekta.io';

  /**
   * Crea un checkout (Link de Pago) seguro para el cobro del enganche.
   * @param cliente Nombre del cliente
   * @param email Correo electrónico
   * @param telefono Teléfono a 10 dígitos
   * @param modelo Modelo del celular
   * @param enganche Monto del enganche en pesos (ej. 375)
   * @returns La URL del Checkout de Conekta para redireccionar al cliente
   */
  static async crearCheckoutEnganche(
    cliente: string,
    email: string,
    telefono: string,
    modelo: string,
    enganche: number
  ): Promise<string> {
    try {
      if (!this.API_KEY) {
        throw new Error('CONEKTA_API_KEY no está configurado en el servidor.');
      }

      // Convertir enganche a centavos (Conekta requiere centavos)
      const montoCentavos = Math.round(enganche * 100);

      // Limpiar y validar teléfono
      const telefonoLimpio = telefono.replace(/\D/g, '');
      const telefonoFormateado = telefonoLimpio.startsWith('52') ? telefonoLimpio : `+52${telefonoLimpio}`;

      // Configurar fecha de expiración para 5 días en el futuro (Unix timestamp)
      const expiracionUnix = Math.floor(Date.now() / 1000) + (5 * 24 * 60 * 60);

      console.log(`[Conekta] Creando checkout de enganche para ${cliente} por un monto de $${enganche} MXN`);

      const payload = {
        name: `Enganche de celular - ${modelo}`,
        type: 'PaymentLink',
        recurrent: false,
        expires_at: expiracionUnix,
        allowed_payment_methods: ['card', 'cash', 'bank_transfer'], // Tarjeta, OXXO/Efectivo, SPEI
        needs_shipping_contact: false,
        order_template: {
          line_items: [
            {
              name: `Enganche inicial: ${modelo}`,
              unit_price: montoCentavos,
              quantity: 1
            }
          ],
          currency: 'MXN',
          customer_info: {
            name: cliente,
            email: email,
            phone: telefonoFormateado
          }
        }
      };

      const response = await axios.post(
        `${this.BASE_URL}/checkouts`,
        payload,
        {
          auth: {
            username: this.API_KEY,
            password: ''
          },
          headers: {
            'accept': 'application/vnd.conekta-v2.2.0+json',
            'content-type': 'application/json'
          }
        }
      );

      const checkoutUrl = response.data.url;
      console.log('[Conekta] Checkout creado de forma exitosa:', checkoutUrl);
      return checkoutUrl;

    } catch (error: any) {
      console.error('[Conekta] Error al crear checkout:', error.response?.data || error.message);
      throw new Error(error.response?.data?.details?.[0]?.message || 'Error al generar el link de pago de Conekta.');
    }
  }
}
