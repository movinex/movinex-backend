import Stripe from 'stripe';

export class StripeService {
  private static _clientLive: Stripe | null = null;
  private static _clientTest: Stripe | null = null;

  // Go-live (2026-08-10): por default se usan las llaves LIVE (cobran de verdad) —
  // solo el email exacto desarrollo@movinex.mx (equipo interno, para seguir probando
  // sin gastar) cae a las llaves de PRUEBA (STRIPE_SECRET_KEY_TEST). Antes era al
  // revés (default prueba, "real" en el email pasaba a producción); se invirtió a
  // propósito para que cualquier cliente real quede en modo real sin depender de que
  // nadie escriba "real" en su email.
  static usaProduccion(email?: string | null): boolean {
    return email?.trim().toLowerCase() !== 'desarrollo@movinex.mx';
  }

  private static getClient(usarProduccion: boolean): Stripe {
    if (usarProduccion) {
      if (!this._clientLive) {
        const apiKey = process.env.STRIPE_SECRET_KEY;
        if (!apiKey) {
          throw new Error('STRIPE_SECRET_KEY no está configurado en el servidor.');
        }
        this._clientLive = new Stripe(apiKey);
      }
      return this._clientLive;
    }

    if (!this._clientTest) {
      const apiKey = process.env.STRIPE_SECRET_KEY_TEST;
      if (!apiKey) {
        throw new Error('STRIPE_SECRET_KEY_TEST no está configurado en el servidor.');
      }
      this._clientTest = new Stripe(apiKey);
    }
    return this._clientTest;
  }

  /**
   * Crea una Checkout Session hosteada por Stripe para el enganche, ofreciendo tarjeta,
   * OXXO (voucher para pagar en efectivo en tienda) y SPEI (transferencia bancaria vía
   * `customer_balance`/`mx_bank_transfer`, habilitado en el dashboard el 2026-08-11). El
   * frontend hace `window.location.href` a la `url` devuelta; el cliente paga en la
   * página de Stripe y vuelve solo a `successUrl`.
   *
   * `setup_future_usage: 'off_session'` va SOLO en `payment_method_options.card` (no a
   * nivel de PaymentIntent): OXXO y SPEI son de un solo uso, un cliente no puede quedar
   * "guardado" para cobrarle automático con esos métodos, así que solo el pago con
   * tarjeta deja lista la suscripción semanal automática — ver la nota en el webhook.
   * El método `customer_balance` (SPEI) exige un `customer` ya existente al crear la
   * Session — a diferencia de `card`/`oxxo`, no alcanza con `customer_email` +
   * `customer_creation: 'always'` (Stripe rechaza la Session entera con "The payment
   * method `customer_balance` requires `customer` to be set"), así que el Customer se
   * crea explícitamente acá antes de armar la sesión.
   *
   * La confirmación real llega después por webhook: `checkout.session.completed`
   * (tarjeta, síncrono) o `checkout.session.async_payment_succeeded` (OXXO/SPEI, el
   * cliente paga horas o días después de generar el voucher/CLABE).
   */
  static async crearCheckoutSession(
    solicitudId: string,
    cliente: string,
    email: string,
    telefono: string,
    modelo: string,
    enganche: number,
    successUrl: string,
    cancelUrl: string,
    costoEnvio: number = 0
  ): Promise<{ sessionId: string; url: string }> {
    const usarProduccion = this.usaProduccion(email);
    const client = this.getClient(usarProduccion);
    const telefonoLimpio = telefono.replace(/\D/g, '');
    const telefonoFormateado = telefonoLimpio.startsWith('52') ? `+${telefonoLimpio}` : `+52${telefonoLimpio}`;

    console.log(`[Stripe] Creando checkout session de enganche para ${cliente} por $${enganche} MXN + $${costoEnvio} de envío (tarjeta/OXXO/SPEI, ${usarProduccion ? 'LIVE' : 'test'})`);

    const customer = await client.customers.create({ email, name: cliente });

    // Envío como línea aparte (no sumado en un solo monto) para que el cliente vea el
    // desglose en la página de Stripe, igual que en la Carátula de Condiciones.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: 'mxn',
          product_data: { name: `Enganche de celular - ${modelo}` },
          unit_amount: Math.round(enganche * 100),
        },
        quantity: 1,
      },
    ];
    if (costoEnvio > 0) {
      lineItems.push({
        price_data: {
          currency: 'mxn',
          product_data: { name: 'Costo de envío' },
          unit_amount: Math.round(costoEnvio * 100),
        },
        quantity: 1,
      });
    }

    const session = await client.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'oxxo', 'customer_balance'],
      payment_method_options: {
        card: { setup_future_usage: 'off_session' },
        customer_balance: {
          funding_type: 'bank_transfer',
          bank_transfer: { type: 'mx_bank_transfer' },
        },
      },
      customer: customer.id,
      line_items: lineItems,
      metadata: {
        solicitud_id: solicitudId,
        tipo: 'enganche',
        cliente,
        telefono: telefonoFormateado,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    if (!session.url) {
      throw new Error('Stripe no devolvió una URL de checkout.');
    }

    console.log('[Stripe] Checkout session creada con éxito:', session.id);
    return { sessionId: session.id, url: session.url };
  }

  /**
   * Lee el payment_method que quedó asociado a un PaymentIntent ya cobrado, junto con
   * su tipo (`card`, `oxxo`, `customer_balance`) — el webhook lo usa para decidir si
   * puede armar la suscripción semanal automática (solo si es `card`, ver arriba) — y
   * el `receiptUrl` del recibo hosteado por Stripe (comprobante de pago para el admin).
   */
  static async obtenerMetodoPagoDeIntent(paymentIntentId: string, usarProduccion: boolean): Promise<{ paymentMethodId: string; tipo: string; receiptUrl: string | null }> {
    const paymentIntent = await this.getClient(usarProduccion).paymentIntents.retrieve(paymentIntentId, {
      expand: ['payment_method', 'latest_charge'],
    });
    const paymentMethod = paymentIntent.payment_method;
    if (!paymentMethod) {
      throw new Error(`El PaymentIntent ${paymentIntentId} no tiene payment_method asociado.`);
    }
    if (typeof paymentMethod === 'string') {
      throw new Error(`El payment_method de ${paymentIntentId} no vino expandido.`);
    }
    const charge = paymentIntent.latest_charge;
    const receiptUrl = charge && typeof charge !== 'string' ? charge.receipt_url : null;
    return { paymentMethodId: paymentMethod.id, tipo: paymentMethod.type, receiptUrl };
  }

  /**
   * Deja la tarjeta usada en el pago del enganche como método de pago por default del
   * Customer, para poder cobrarla off-session en la suscripción semanal.
   */
  static async fijarMetodoPagoDefault(customerId: string, paymentMethodId: string, usarProduccion: boolean): Promise<void> {
    await this.getClient(usarProduccion).customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  /**
   * Crea la suscripción semanal sobre el Customer que acaba de pagar el enganche.
   * `trial_period_days: 7` retrasa el primer cobro recurrente 7 días, igual que el Plan
   * de Conekta. El precio se arma inline (`price_data`) porque el monto/plazo varían
   * por solicitud — no hace falta un Price fijo predefinido en el dashboard de Stripe.
   */
  static async crearSuscripcionSemanal(
    solicitudId: string,
    customerId: string,
    paymentMethodId: string,
    pagoSemanal: number,
    semanas: number,
    usarProduccion: boolean
  ): Promise<{ subscriptionId: string }> {
    console.log(`[Stripe] Creando suscripción semanal de $${pagoSemanal} x ${semanas} semanas (trial 7 días) para ${customerId}`);

    const client = this.getClient(usarProduccion);

    // A diferencia de Checkout Sessions, subscriptions.create no acepta product_data
    // inline — el Price tiene que apuntar a un Product ya creado.
    const product = await client.products.create({
      name: `Pago semanal Movinex - ${solicitudId}`,
    });

    const subscription = await client.subscriptions.create({
      customer: customerId,
      default_payment_method: paymentMethodId,
      trial_period_days: 7,
      items: [
        {
          price_data: {
            currency: 'mxn',
            product: product.id,
            unit_amount: Math.round(pagoSemanal * 100),
            recurring: { interval: 'week' },
          },
        },
      ],
      metadata: { solicitud_id: solicitudId, semanas: String(semanas) },
    });

    console.log('[Stripe] Suscripción creada con éxito:', subscription.id);
    return { subscriptionId: subscription.id };
  }

  /**
   * Le da al Customer una CLABE fija y reutilizable (no ligada a un pago puntual) para
   * que siempre transfiera al mismo número de referencia — decisión de negocio
   * (reunión 07/08): en vez de un link de pago nuevo cada semana, el cliente paga
   * siempre a la misma cuenta. **Solo sirve para SPEI** (transferencia directa desde
   * su banco) — a diferencia de lo que se asumió al principio, esta CLABE NO sirve
   * para depositar efectivo en OXXO: confirmado contra la documentación de Stripe
   * (`docs.stripe.com/payments/customer-balance/funding-instructions`), el
   * `financial_addresses` que devuelve para México solo trae `spei` en
   * `supported_networks`, nada de OXXO. Los clientes que pagaron el enganche con OXXO
   * usan `crearPagoSemanalOxxo` en su lugar (ver abajo), no este método.
   * `createFundingInstructions` es idempotente por customer+currency+tipo: llamarlo de
   * nuevo para el mismo customer devuelve la misma CLABE, no crea una nueva.
   */
  static async crearReferenciaPagoPersistente(customerId: string, usarProduccion: boolean): Promise<{ clabe: string; banco: string }> {
    const instrucciones = await this.getClient(usarProduccion).customers.createFundingInstructions(customerId, {
      currency: 'mxn',
      funding_type: 'bank_transfer',
      bank_transfer: { type: 'mx_bank_transfer' },
    });

    const direccionSpei = instrucciones.bank_transfer.financial_addresses.find((d) => d.spei)?.spei;
    if (!direccionSpei) {
      throw new Error(`Stripe no devolvió una CLABE SPEI para el customer ${customerId}.`);
    }

    console.log(`[Stripe] CLABE de referencia persistente para ${customerId}: ${direccionSpei.clabe}`);
    return { clabe: direccionSpei.clabe, banco: direccionSpei.bank_name };
  }

  /**
   * Suscripción semanal para clientes sin tarjeta guardada (pagaron el enganche con
   * OXXO/SPEI): `collection_method: 'send_invoice'` porque no hay ninguna tarjeta que
   * cobrar automáticamente. Cuando el cliente deposita en su CLABE persistente
   * (`crearReferenciaPagoPersistente`), Stripe acredita ese dinero al balance del
   * Customer y lo aplica solo en cuanto se genera cada factura semanal — si el saldo
   * alcanza, la factura queda pagada sin que nadie tenga que hacer nada más; si no
   * alcanza, queda abierta hasta que el cliente deposite el resto (`invoice.paid` en
   * el webhook es la señal de que sí alcanzó). `trial_period_days: 7` deja la primera
   * factura para 7 días después del enganche, igual que la Subscription de tarjeta.
   */
  static async crearSuscripcionConSaldo(
    solicitudId: string,
    customerId: string,
    pagoSemanal: number,
    semanas: number,
    usarProduccion: boolean
  ): Promise<{ subscriptionId: string }> {
    console.log(`[Stripe] Creando suscripción (cobro por saldo/CLABE) de $${pagoSemanal} x ${semanas} semanas (trial 7 días) para ${customerId}`);

    const client = this.getClient(usarProduccion);

    const product = await client.products.create({
      name: `Pago semanal Movinex - ${solicitudId}`,
    });

    const subscription = await client.subscriptions.create({
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: 7,
      trial_period_days: 7,
      items: [
        {
          price_data: {
            currency: 'mxn',
            product: product.id,
            unit_amount: Math.round(pagoSemanal * 100),
            recurring: { interval: 'week' },
          },
        },
      ],
      metadata: { solicitud_id: solicitudId, semanas: String(semanas) },
    });

    console.log('[Stripe] Suscripción (cobro por saldo) creada con éxito:', subscription.id);
    return { subscriptionId: subscription.id };
  }

  /**
   * Genera un voucher de OXXO nuevo para el cobro semanal de un cliente que pagó el
   * enganche con OXXO. A diferencia de SPEI, OXXO no soporta pagos recurrentes ni
   * fondear un balance (Stripe: "Recurring payments: Not supported", "Usability:
   * Single-use", cada voucher trae su propio número de referencia de 32 dígitos y
   * vence a los 5 días) — no hay forma de darle una referencia fija reutilizable como
   * la CLABE de SPEI, así que hay que generarle un `PaymentIntent`/Checkout Session
   * nueva cada semana, igual que con el enganche. `metadata.tipo: 'cobro_semanal'`
   * es lo que el webhook usa para no confundir esta Session con la del enganche.
   */
  static async crearPagoSemanalOxxo(
    solicitudId: string,
    customerId: string,
    monto: number,
    numeroSemana: number,
    origin: string,
    usarProduccion: boolean
  ): Promise<{ sessionId: string; url: string }> {
    console.log(`[Stripe] Creando voucher OXXO semana #${numeroSemana} por $${monto} MXN para ${customerId}`);

    const session = await this.getClient(usarProduccion).checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['oxxo'],
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: { name: `Pago semanal Movinex #${numeroSemana}` },
            unit_amount: Math.round(monto * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        solicitud_id: solicitudId,
        tipo: 'cobro_semanal',
        numero_semana: String(numeroSemana),
      },
      success_url: `${origin}/`,
      cancel_url: `${origin}/`,
    });

    if (!session.url) {
      throw new Error('Stripe no devolvió una URL de checkout para el voucher OXXO semanal.');
    }

    return { sessionId: session.id, url: session.url };
  }

  /**
   * Cancela la Subscription semanal (tarjeta o saldo/CLABE, da igual — ambas se
   * cancelan igual) una vez que el cliente terminó de pagar su plan (26 o 52
   * semanas). Sin esto, Stripe seguiría cobrando cada semana indefinidamente:
   * ninguna de las dos Subscriptions se crea con `cancel_at` ni tope de ciclos.
   * Cancelación inmediata (no `cancel_at_period_end`): se llama justo después de
   * confirmarse el pago de la última semana, así que no queda nada pendiente de
   * cobrar ni de prorratear.
   */
  static async cancelarSuscripcion(subscriptionId: string, usarProduccion: boolean): Promise<void> {
    await this.getClient(usarProduccion).subscriptions.cancel(subscriptionId);
  }

  /**
   * Reembolsa el enganche ya cobrado — usado por el botón "Cancelar solicitud" del
   * admin. Reembolso completo (sin `amount`) del PaymentIntent guardado en
   * `stripe_payment_intent_id` al confirmarse el pago (ver el webhook en index.ts).
   */
  static async reembolsarPago(paymentIntentId: string, usarProduccion: boolean): Promise<void> {
    await this.getClient(usarProduccion).refunds.create({ payment_intent: paymentIntentId });
  }

  /**
   * Verifica la firma del webhook contra el signing secret del endpoint en Stripe.
   * Como el evento puede venir del endpoint live o del de prueba (dos secretos
   * distintos, ver `usaProduccion`), se prueban en orden hasta que uno verifique —
   * `webhooks.constructEvent` es solo una verificación criptográfica local, no pega
   * a la red, así que probar varios secretos es barato.
   */
  static construirEventoWebhook(rawBody: Buffer, signature: string, webhookSecrets: (string | undefined)[]): Stripe.Event {
    let ultimoError: unknown;
    for (const secret of webhookSecrets) {
      if (!secret) continue;
      try {
        return this.getClient(true).webhooks.constructEvent(rawBody, signature, secret);
      } catch (err) {
        ultimoError = err;
      }
    }
    throw ultimoError instanceof Error ? ultimoError : new Error('No se pudo verificar la firma del webhook.');
  }
}
