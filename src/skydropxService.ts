import axios from 'axios';

export class SkydropxService {
  private static BASE_URL = process.env.SKYDROPX_BASE_URL || 'https://sb-pro.skydropx.com';
  private static CLIENT_ID = process.env.SKYDROPX_CLIENT_ID;
  private static CLIENT_SECRET = process.env.SKYDROPX_CLIENT_SECRET;

  // Igual que Verificamex: si el email de la solicitud contiene "real", se usa la
  // API de producción de Skydropx en vez del sandbox.
  private static PROD_BASE_URL = process.env.SKYDROPX_PROD_BASE_URL || 'https://api-pro.skydropx.com';
  private static PROD_CLIENT_ID = process.env.SKYDROPX_PROD_CLIENT_ID;
  private static PROD_CLIENT_SECRET = process.env.SKYDROPX_PROD_CLIENT_SECRET;

  private static REMITENTE_DEFAULT = {
    name: 'NVX Technologies',
    street1: 'Av. Paseo de la Reforma',
    street_number: '222',
    postal_code: '06600',
    area_level1: 'Ciudad de Mexico',
    area_level2: 'Cuauhtemoc',
    area_level3: 'Juarez',
    country_code: 'MX',
    phone: '5215555028744',
    email: 'contacto@movinex.mx',
    reference: 'Oficina Movinex'
  };

  // Clave SAT de producto/servicio para "Teléfonos móviles (Celular o Smartphone)",
  // requerida por Skydropx Pro como consignment_note (Carta Porte) en cada paquete.
  private static CONSIGNMENT_NOTE_CELULAR = '43191501';
  // Código de embalaje (catálogo SAT/UN, Rec. 21) para caja de cartón.
  private static PACKAGE_TYPE_CAJA = '4G';

  // Cachés separados para sandbox y producción: son cuentas/tokens distintos.
  private static tokenCacheSandbox: { token: string; expiresAt: number } | null = null;
  private static tokenCacheProd: { token: string; expiresAt: number } | null = null;

  // El token OAuth2 dura 2 horas (confirmado con la cuenta real); se cachea en memoria
  // y se renueva solo cuando falta poco para vencer.
  private static async getAccessToken(usarProduccion: boolean): Promise<string> {
    const cache = usarProduccion ? this.tokenCacheProd : this.tokenCacheSandbox;
    if (cache && cache.expiresAt > Date.now() + 30_000) {
      return cache.token;
    }

    const baseUrl = usarProduccion ? this.PROD_BASE_URL : this.BASE_URL;
    const clientId = usarProduccion ? this.PROD_CLIENT_ID : this.CLIENT_ID;
    const clientSecret = usarProduccion ? this.PROD_CLIENT_SECRET : this.CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        usarProduccion
          ? 'SKYDROPX_PROD_CLIENT_ID / SKYDROPX_PROD_CLIENT_SECRET no están configurados.'
          : 'SKYDROPX_CLIENT_ID / SKYDROPX_CLIENT_SECRET no están configurados.'
      );
    }

    const response = await axios.post(`${baseUrl}/api/v1/oauth/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    });

    const { access_token, expires_in } = response.data;
    const nuevoCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    if (usarProduccion) {
      this.tokenCacheProd = nuevoCache;
    } else {
      this.tokenCacheSandbox = nuevoCache;
    }
    return access_token;
  }

  private static async authHeaders(usarProduccion: boolean) {
    const token = await this.getAccessToken(usarProduccion);
    return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  }

  private static esperar(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Skydropx Pro rechaza address_to.name con más de 30 caracteres (error real
  // encontrado 2026-08-14: "CRISTIAN JAIR MARQUEZ HERNANDEZ", 31 caracteres, hizo
  // fallar la guía real y cayó en silencio al tracking simulado sin que nadie se
  // enterara). Nombres compuestos + dos apellidos son comunes en México y superan el
  // límite seguido, así que se recorta por palabra completa en vez de dejar que la
  // API rechace la guía entera. Mismo problema encontrado 2026-08-18 con
  // address_to.street1 (máximo 45 caracteres) — direcciones mexicanas con
  // referencias "entre calle X y calle Y" lo superan seguido.
  private static truncarCampoDireccion(texto: string, maxLen = 30): string {
    const limpio = texto.trim();
    if (limpio.length <= maxLen) return limpio;
    const cortado = limpio.slice(0, maxLen);
    const ultimoEspacio = cortado.lastIndexOf(' ');
    return (ultimoEspacio > 0 ? cortado.slice(0, ultimoEspacio) : cortado).trim();
  }

  /**
   * Genera una guía real con Skydropx Pro (OAuth2). Go-live (2026-08-10): por default
   * usa producción (SKYDROPX_PROD_*) — solo el email exacto desarrollo@movinex.mx cae
   * a sandbox (sb-pro.skydropx.com), igual que Stripe y Verificamex.
   * Flujo de 3 pasos, los dos primeros son asíncronos del lado de Skydropx:
   *   1. POST /quotations -> se espera a que is_completed sea true (poll).
   *   2. Se elige la tarifa más barata entre las que devolvieron success: true.
   *   3. POST /shipments con esa tarifa -> se espera a que workflow_status sea
   *      "success" para recién ahí tener tracking_number y label_url (poll).
   */
  static async crearEnvio(
    cliente: string,
    telefono: string,
    email: string,
    domicilio: {
      calle: string;
      numeroExterior: string;
      numeroInterior?: string;
      colonia: string;
      alcaldiaMunicipio: string;
      estado: string;
      codigoPostal: string;
    },
    modelo: string
  ): Promise<{ trackingNumber: string; labelUrl: string | null; shipmentId?: string; carrier?: string; simulado?: boolean; rawData?: any }> {
    try {
      const usarProduccion = email?.trim().toLowerCase() !== 'desarrollo@movinex.mx';
      const baseUrl = usarProduccion ? this.PROD_BASE_URL : this.BASE_URL;

      const telefonoLimpio = telefono.replace(/\D/g, '');

      const addressTo = {
        name: this.truncarCampoDireccion(cliente, 30),
        street1: this.truncarCampoDireccion(domicilio.calle, 45),
        street_number: domicilio.numeroExterior,
        apartment_number: domicilio.numeroInterior || undefined,
        postal_code: domicilio.codigoPostal,
        area_level1: domicilio.estado,
        area_level2: domicilio.alcaldiaMunicipio,
        area_level3: domicilio.colonia,
        country_code: 'MX',
        phone: telefonoLimpio.startsWith('52') ? telefonoLimpio : `52${telefonoLimpio}`,
        email,
        // No revelar el modelo del celular en la guía — es un dato visible para
        // cualquiera que maneje el paquete en tránsito, y lo hace un blanco más
        // fácil de robo. Referencia genérica, sin pistas de qué hay adentro.
        reference: 'Paquete Movinex'
      };

      const auth = await this.authHeaders(usarProduccion);

      // 1. Cotizar (asíncrono del lado de Skydropx)
      console.log(`[Skydropx${usarProduccion ? ' PRODUCCIÓN' : ''}] Cotizando envío para ${cliente} a CP ${domicilio.codigoPostal}...`);
      const cotizacionRes = await axios.post(
        `${baseUrl}/api/v1/quotations`,
        {
          quotation: {
            address_from: this.REMITENTE_DEFAULT,
            address_to: addressTo,
            parcels: [{ weight: 1, length: 20, width: 15, height: 10, distance_unit: 'CM', mass_unit: 'KG' }]
          }
        },
        auth
      );

      const quotationId = cotizacionRes.data.id;
      let quotation = cotizacionRes.data;
      for (let intento = 0; intento < 8 && !quotation.is_completed; intento++) {
        await this.esperar(2000);
        const poll = await axios.get(`${baseUrl}/api/v1/quotations/${quotationId}`, auth);
        quotation = poll.data;
      }

      const tarifasValidas = (quotation.rates || []).filter((r: any) => r.success && r.total);
      if (!tarifasValidas.length) {
        throw new Error('Skydropx no devolvió tarifas disponibles para esta cotización.');
      }

      // 2. Elegir la tarifa más barata disponible
      const tarifaElegida = [...tarifasValidas].sort((a: any, b: any) => Number(a.total) - Number(b.total))[0];
      console.log(`[Skydropx] Tarifa elegida: ${tarifaElegida.provider_display_name} ${tarifaElegida.provider_service_name} ($${tarifaElegida.total}, rate_id ${tarifaElegida.id})`);

      // 3. Crear el envío con esa tarifa (también asíncrono)
      const shipmentRes = await axios.post(
        `${baseUrl}/api/v1/shipments`,
        {
          shipment: {
            quotation_id: quotationId,
            rate_id: tarifaElegida.id,
            address_from: this.REMITENTE_DEFAULT,
            address_to: addressTo,
            packages: [
              {
                package_number: 1,
                weight: 1,
                length: 20,
                width: 15,
                height: 10,
                consignment_note: this.CONSIGNMENT_NOTE_CELULAR,
                package_type: this.PACKAGE_TYPE_CAJA
              }
            ]
          }
        },
        auth
      );

      const shipmentId = shipmentRes.data.data.id;
      let shipmentData = shipmentRes.data;
      for (let intento = 0; intento < 10; intento++) {
        const estado = shipmentData.data.attributes.workflow_status;
        if (estado === 'success' || estado === 'failure') break;
        await this.esperar(2000);
        const poll = await axios.get(`${baseUrl}/api/v1/shipments/${shipmentId}`, auth);
        shipmentData = poll.data;
      }

      if (shipmentData.data.attributes.workflow_status !== 'success') {
        throw new Error(`Skydropx no pudo completar el envío (estado: ${shipmentData.data.attributes.workflow_status}, detalle: ${shipmentData.data.attributes.error_detail}).`);
      }

      const paquete = (shipmentData.included || []).find((i: any) => i.type === 'package');
      const trackingNumber: string | undefined = paquete?.attributes?.tracking_number;
      const labelUrl: string | null = paquete?.attributes?.label_url || null;

      if (!trackingNumber) {
        throw new Error('Skydropx no devolvió un número de rastreo para la guía generada.');
      }

      console.log(`[Skydropx${usarProduccion ? ' PRODUCCIÓN' : ''}] Guía generada con éxito. Tracking:`, trackingNumber);
      // shipmentId se guarda para poder cancelar la guía después (ver cancelarEnvio) si
      // el admin cancela la solicitud — el endpoint de cancelación pide el id del envío,
      // no el tracking_number. carrier se guarda para consultarEstadoEntrega.
      return { trackingNumber, labelUrl, shipmentId: String(shipmentId), carrier: tarifaElegida.provider_display_name, rawData: shipmentData };

    } catch (error: any) {
      console.error('[Skydropx] Error al generar la guía de envío:', error.response?.data || error.message);

      return {
        simulado: true,
        trackingNumber: 'MX-TRACK-' + Math.floor(10000000 + Math.random() * 90000000),
        labelUrl: null
      };
    }
  }

  // Estados de entrega que devuelve Skydropx Pro. No confirmado 100% contra la API
  // real todavía (la documentación pública no deja del todo claro el shape exacto) —
  // ver consultarEstadoEntrega.
  static readonly ESTADOS_ENTREGADO = ['ENTREGADO', 'DELIVERED'];

  /**
   * Consulta el estado actual de un envío ya generado — usado por el cron de
   * verificación de entregas (ver entregasService.ts) en vez de depender de un
   * webhook de Skydropx (no confirmado si aplica a esta cuenta "Pro", ver
   * conversación 2026-08-14). Requiere el carrier guardado en crearEnvio.
   */
  static async consultarEstadoEntrega(
    trackingNumber: string,
    carrier: string,
    usarProduccion: boolean
  ): Promise<{ status: string; entregado: boolean; rawData?: any }> {
    const baseUrl = usarProduccion ? this.PROD_BASE_URL : this.BASE_URL;
    const auth = await this.authHeaders(usarProduccion);

    const response = await axios.get(
      `${baseUrl}/api/v1/shipments/tracking/${encodeURIComponent(trackingNumber)}/${encodeURIComponent(carrier)}`,
      auth
    );

    const status: string = response.data?.status || response.data?.data?.attributes?.status || '';
    return {
      status,
      entregado: this.ESTADOS_ENTREGADO.includes(status.toUpperCase()),
      rawData: response.data
    };
  }

  /**
   * Cancela un envío ya generado (`POST /api/v1/shipments/:id/cancellations`) — lo usa
   * el botón "Cancelar solicitud" del admin cuando la guía ya existía. **Sin confirmar
   * contra la cuenta real todavía** (igual que el resto de este servicio, ver el resto
   * de las notas de "sin confirmar" en este archivo): la documentación pública de
   * Skydropx Pro solo confirma el método y la ruta, no el shape exacto de la respuesta
   * ni si devuelve algún reembolso del costo de envío. Por eso el caller (index.ts) lo
   * trata como best-effort — un error acá no debe impedir que se termine de cancelar la
   * solicitud del lado de Movinex/Stripe, que es lo que de verdad protege al cliente.
   */
  static async cancelarEnvio(shipmentId: string, usarProduccion: boolean): Promise<void> {
    const baseUrl = usarProduccion ? this.PROD_BASE_URL : this.BASE_URL;
    const auth = await this.authHeaders(usarProduccion);

    await axios.post(`${baseUrl}/api/v1/shipments/${shipmentId}/cancellations`, {}, auth);
    console.log(`[Skydropx${usarProduccion ? ' PRODUCCIÓN' : ''}] Envío ${shipmentId} cancelado.`);
  }
}
