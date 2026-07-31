import axios from 'axios';

export class ConektaService {
  private static API_KEY = process.env.CONEKTA_API_KEY;
  private static BASE_URL = 'https://api.conekta.io';

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

      const montoCentavos = Math.round(enganche * 100);
      const telefonoLimpio = telefono.replace(/\D/g, '');
      const telefonoFormateado = telefonoLimpio.startsWith('52') ? telefonoLimpio : `+52${telefonoLimpio}`;
      const expiracionUnix = Math.floor(Date.now() / 1000) + (5 * 24 * 60 * 60);

      console.log(`[Conekta] Creando checkout de enganche para ${cliente} por un monto de $${enganche} MXN`);

      const payload = {
        name: `Enganche de celular - ${modelo}`,
        type: 'PaymentLink',
        recurrent: false,
        expires_at: expiracionUnix,
        allowed_payment_methods: ['card', 'cash', 'bank_transfer'],
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

  private static get headers() {
    return {
      auth: { username: this.API_KEY as string, password: '' },
      headers: {
        'accept': 'application/vnd.conekta-v2.2.0+json',
        'content-type': 'application/json'
      }
    };
  }

  /**
   * Crea la Orden del enganche para pagarla con el Checkout Component embebido
   * (`conekta-checkout.min.js`, iframe hosteado por Conekta — no volvemos a ver la
   * tarjeta del cliente). Reemplaza al viejo flujo de Conekta.js + Token.create(),
   * que esta cuenta no acepta ("At the moment, the merchant does not accept payments
   * with your payment method"). El frontend inicializa el componente con el
   * `checkoutId` que devuelve esto; la confirmación real del pago la hace el webhook
   * `order.paid` (ya implementado), no la respuesta del frontend.
   */
  static async crearOrdenEnganche(
    cliente: string,
    email: string,
    telefono: string,
    modelo: string,
    enganche: number
  ): Promise<{ orderId: string; checkoutId: string }> {
    if (!this.API_KEY) {
      throw new Error('CONEKTA_API_KEY no está configurado en el servidor.');
    }

    const telefonoLimpio = telefono.replace(/\D/g, '');
    const telefonoFormateado = telefonoLimpio.startsWith('52') ? `+${telefonoLimpio}` : `+52${telefonoLimpio}`;

    console.log(`[Conekta] Creando orden de enganche (Checkout Component) para ${cliente} por $${enganche} MXN`);

    const response = await axios.post(
      `${this.BASE_URL}/orders`,
      {
        checkout: {
          allowed_payment_methods: ['card'],
          type: 'Integration',
          name: `Enganche de celular - ${modelo}`
        },
        customer_info: { name: cliente, email, phone: telefonoFormateado },
        pre_authorize: false,
        currency: 'MXN',
        line_items: [
          { name: `Enganche inicial: ${modelo}`, quantity: 1, unit_price: Math.round(enganche * 100) }
        ]
      },
      this.headers
    );

    console.log('[Conekta] Orden creada con éxito:', response.data.id, '— checkout:', response.data.checkout?.id);
    return { orderId: response.data.id, checkoutId: response.data.checkout.id };
  }

  /**
   * Crea un Plan (único por solicitud, ya que el monto/plazo varían por cliente) y una
   * Subscription sobre un customer con tarjeta guardada, para que el primer cobro
   * recurrente caiga automáticamente 7 días después del enganche.
   * SIN USAR TODAVÍA: guardar tarjetas para reutilizarlas ("Tarjetas Guardadas" en la
   * doc de Conekta) requiere Early Access — hay que pedirlo a Conekta antes de poder
   * armar el customer+tarjeta que esto necesita como entrada.
   */
  static async crearSuscripcionSemanal(
    solicitudId: string,
    customerId: string,
    pagoSemanal: number,
    semanas: number
  ): Promise<{ planId: string; subscriptionId: string }> {
    if (!this.API_KEY) {
      throw new Error('CONEKTA_API_KEY no está configurado en el servidor.');
    }

    const planId = `plan_movinex_${solicitudId}`;

    console.log(`[Conekta] Creando plan semanal de $${pagoSemanal} x ${semanas} semanas (trial 7 días) para ${customerId}`);

    await axios.post(
      `${this.BASE_URL}/plans`,
      {
        id: planId,
        name: `Pago semanal Movinex - ${solicitudId}`,
        amount: Math.round(pagoSemanal * 100),
        currency: 'MXN',
        interval: 'week',
        frequency: 1,
        trial_period_days: 7,
        expiry_count: semanas
      },
      this.headers
    );

    const subscriptionResponse = await axios.post(
      `${this.BASE_URL}/customers/${customerId}/subscription`,
      { plan_id: planId },
      this.headers
    );

    console.log('[Conekta] Suscripción creada con éxito:', subscriptionResponse.data.id);
    return { planId, subscriptionId: subscriptionResponse.data.id };
  }
}
