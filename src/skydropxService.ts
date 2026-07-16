import axios from 'axios';

/**
 * Servicio para interactuar con la API de Skydropx v1.
 */
export class SkydropxService {
  private static API_KEY = process.env.SKYDROPX_API_KEY;
  private static BASE_URL = 'https://api.skydropx.com/v1';

  // Dirección de origen por defecto (NVX Technologies - Remitente)
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

  /**
   * Crea un envío (Shipment) automatizado en Skydropx utilizando los datos de destino del cliente.
   * @param cliente Nombre del destinatario
   * @param telefono Teléfono del destinatario
   * @param email Email del destinatario
   * @param cp Código Postal de destino
   * @param direccion Calle y número de destino
   * @param modelo Celular comprado (para descripción)
   * @returns Un objeto con el ID del envío y las tarifas/guías disponibles
   */
  static async crearEnvio(
    cliente: string,
    telefono: string,
    email: string,
    cp: string,
    direccion: string,
    modelo: string
  ): Promise<any> {
    try {
      if (!this.API_KEY) {
        throw new Error('SKYDROPX_API_KEY no está configurada.');
      }

      console.log(`[Skydropx] Generando cotización de envío para ${cliente} a CP ${cp}...`);

      const payload = {
        address_from: this.REMITENTE_DEFAULT,
        address_to: {
          name: cliente,
          street1: direccion,
          city: 'Destino', // El sistema calcula por CP
          state: 'Destino',
          zip: cp,
          country: 'MX',
          phone: telefono.replace(/\D/g, ''),
          email: email,
          contents: `Celular Movinex ${modelo}`
        },
        parcels: [
          {
            weight: 1, // 1 Kg peso estándar para un celular embalado
            distance_unit: 'CM',
            mass_unit: 'KG',
            height: 10,
            width: 15,
            length: 20
          }
        ]
      };

      const response = await axios.post(
        `${this.BASE_URL}/shipments`,
        payload,
        {
          headers: {
            'Authorization': `Token token=${this.API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[Skydropx] Envío creado con éxito. ID:', response.data?.data?.id);
      return response.data;

    } catch (error: any) {
      console.error('[Skydropx] Error al cotizar envío:', error.response?.data || error.message);
      
      // Fallback seguro para simulación en la demo en caso de no contar con saldo en Skydropx
      return {
        simulado: true,
        data: {
          id: `ship_simulated_${Math.floor(Math.random() * 100000)}`,
          attributes: {
            status: 'simulated_pending',
            tracking_number: 'MX-TRACK-' + Math.floor(10000000 + Math.random() * 90000000)
          }
        }
      };
    }
  }
}
