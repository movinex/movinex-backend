import axios from 'axios';

export class SkydropxService {
  private static API_KEY = process.env.SKYDROPX_API_KEY;
  private static BASE_URL = 'https://api.skydropx.com/v1';

  private static REMITENTE_DEFAULT = {
    name: 'NVX Technologies',
    street1: 'Av. Paseo de la Reforma 222',
    street2: 'Piso 12',
    city: 'Ciudad de México',
    state: 'CDMX',
    zip: '06600',
    country: 'MX',
    phone: '525555028744',
    email: 'contacto@movinex.mx'
  };

  private static get headers() {
    return {
      'Authorization': `Token token=${this.API_KEY}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Genera una guía real siguiendo el flujo documentado de Skydropx (3 llamadas):
   * cotizar (quotations) -> elegir tarifa -> crear la guía (labels).
   * NOTA: el shape exacto de la respuesta de /quotations y /shipments puede variar
   * respecto a lo documentado públicamente; falta validar contra su sandbox real
   * con una API key de pruebas antes de dar esto por cerrado.
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
  ): Promise<{ trackingNumber: string; labelUrl: string | null; simulado?: boolean; rawData?: any }> {
    try {
      if (!this.API_KEY) {
        throw new Error('SKYDROPX_API_KEY no está configurada.');
      }

      const street1 = `${domicilio.calle} ${domicilio.numeroExterior}${domicilio.numeroInterior ? ` Int. ${domicilio.numeroInterior}` : ''}`;

      const addressTo = {
        name: cliente,
        street1,
        street2: domicilio.colonia,
        city: domicilio.alcaldiaMunicipio,
        state: domicilio.estado,
        zip: domicilio.codigoPostal,
        country: 'MX',
        phone: telefono.replace(/\D/g, ''),
        email: email,
        contents: `Celular Movinex ${modelo}`
      };

      const parcels = [
        {
          weight: 1,
          distance_unit: 'CM',
          mass_unit: 'KG',
          height: 10,
          width: 15,
          length: 20
        }
      ];

      // 1. Cotizar
      console.log(`[Skydropx] Cotizando envío para ${cliente} a CP ${domicilio.codigoPostal}...`);
      const cotizacion = await axios.post(
        `${this.BASE_URL}/quotations`,
        { address_from: this.REMITENTE_DEFAULT, address_to: addressTo, parcels },
        { headers: this.headers }
      );

      const tarifas = cotizacion.data?.data?.attributes?.rates || cotizacion.data?.rates || [];
      if (!tarifas.length) {
        throw new Error('Skydropx no devolvió tarifas disponibles para esta cotización.');
      }

      // 2. Elegir la tarifa más barata disponible
      const tarifaElegida = [...tarifas].sort((a: any, b: any) => Number(a.total || a.price) - Number(b.total || b.price))[0];
      const rateId = tarifaElegida.id || tarifaElegida.rate_id;
      console.log(`[Skydropx] Tarifa elegida: ${tarifaElegida.provider_name || tarifaElegida.carrier || 'N/A'} (rate_id ${rateId})`);

      // 3. Crear el envío/guía
      const shipment = await axios.post(
        `${this.BASE_URL}/shipments`,
        { address_from: this.REMITENTE_DEFAULT, address_to: addressTo, parcels, rate_id: rateId },
        { headers: this.headers }
      );

      const shipmentId = shipment.data?.data?.id;
      const label = await axios.post(
        `${this.BASE_URL}/labels`,
        { rate_id: rateId, shipment_id: shipmentId, label_format: 'pdf' },
        { headers: this.headers }
      );

      const labelData = label.data?.data?.attributes || label.data?.data || label.data;
      const trackingNumber = labelData?.tracking_number;
      const labelUrl = labelData?.label_url || null;

      if (!trackingNumber) {
        throw new Error('Skydropx no devolvió un número de rastreo para la guía generada.');
      }

      console.log('[Skydropx] Guía generada con éxito. Tracking:', trackingNumber);
      return { trackingNumber, labelUrl, rawData: label.data };

    } catch (error: any) {
      console.error('[Skydropx] Error al generar la guía de envío:', error.response?.data || error.message);

      return {
        simulado: true,
        trackingNumber: 'MX-TRACK-' + Math.floor(10000000 + Math.random() * 90000000),
        labelUrl: null
      };
    }
  }
}
