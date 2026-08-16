import axios from 'axios';

export class SkydropxService {
  // El sandbox (sb-pro.skydropx.com) se eliminó el 2026-08-16: ya no había forma de
  // llegar a él salvo con una solicitud de prueba vieja, y cuando el cron de entregas
  // lo consultaba devolvía una página HTML en vez de JSON, que terminaba volcada
  // entera en los logs de producción.
  private static BASE_URL = process.env.SKYDROPX_PROD_BASE_URL || 'https://api-pro.skydropx.com';
  private static CLIENT_ID = process.env.SKYDROPX_PROD_CLIENT_ID;
  private static CLIENT_SECRET = process.env.SKYDROPX_PROD_CLIENT_SECRET;

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

  private static tokenCache: { token: string; expiresAt: number } | null = null;

  // El token OAuth2 dura 2 horas (confirmado con la cuenta real); se cachea en memoria
  // y se renueva solo cuando falta poco para vencer.
  private static async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }

    if (!this.CLIENT_ID || !this.CLIENT_SECRET) {
      throw new Error('SKYDROPX_PROD_CLIENT_ID / SKYDROPX_PROD_CLIENT_SECRET no están configurados.');
    }

    const response = await axios.post(`${this.BASE_URL}/api/v1/oauth/token`, {
      client_id: this.CLIENT_ID,
      client_secret: this.CLIENT_SECRET,
      grant_type: 'client_credentials'
    });

    const { access_token, expires_in } = response.data;
    this.tokenCache = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return access_token;
  }

  private static async authHeaders() {
    const token = await this.getAccessToken();
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
  // API rechace la guía entera.
  private static truncarNombreDireccion(nombre: string, maxLen = 30): string {
    const limpio = nombre.trim();
    if (limpio.length <= maxLen) return limpio;
    const cortado = limpio.slice(0, maxLen);
    const ultimoEspacio = cortado.lastIndexOf(' ');
    return (ultimoEspacio > 0 ? cortado.slice(0, ultimoEspacio) : cortado).trim();
  }

  /**
   * Genera una guía real con Skydropx Pro (OAuth2), siempre contra la cuenta de
   * producción (SKYDROPX_PROD_*) — el sandbox se eliminó el 2026-08-16.
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
  ): Promise<{ trackingNumber: string; labelUrl: string | null; carrier?: string; simulado?: boolean; rawData?: any }> {
    try {
      const telefonoLimpio = telefono.replace(/\D/g, '');

      const addressTo = {
        name: this.truncarNombreDireccion(cliente),
        street1: domicilio.calle,
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

      const auth = await this.authHeaders();

      // 1. Cotizar (asíncrono del lado de Skydropx)
      console.log(`[Skydropx] Cotizando envío para ${cliente} a CP ${domicilio.codigoPostal}...`);
      const cotizacionRes = await axios.post(
        `${this.BASE_URL}/api/v1/quotations`,
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
        const poll = await axios.get(`${this.BASE_URL}/api/v1/quotations/${quotationId}`, auth);
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
        `${this.BASE_URL}/api/v1/shipments`,
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
        const poll = await axios.get(`${this.BASE_URL}/api/v1/shipments/${shipmentId}`, auth);
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

      console.log(`[Skydropx] Guía generada con éxito. Tracking:`, trackingNumber);
      // Se guarda para poder consultar el estado de entrega después (ver
      // consultarEstadoEntrega) — el endpoint de tracking de Skydropx pide el nombre
      // del carrier además del número de guía.
      return { trackingNumber, labelUrl, carrier: tarifaElegida.provider_display_name, rawData: shipmentData };

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
    carrier: string
  ): Promise<{ status: string; entregado: boolean; rawData?: any }> {
    const auth = await this.authHeaders();

    const response = await axios.get(
      `${this.BASE_URL}/api/v1/shipments/tracking/${encodeURIComponent(trackingNumber)}/${encodeURIComponent(carrier)}`,
      auth
    );

    const status: string = response.data?.status || response.data?.data?.attributes?.status || '';
    return {
      status,
      entregado: this.ESTADOS_ENTREGADO.includes(status.toUpperCase()),
      rawData: response.data
    };
  }
}
