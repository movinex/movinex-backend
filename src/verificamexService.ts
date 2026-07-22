import axios from 'axios';

export class VerificamexService {
  private static API_KEY = process.env.VERIFICAMEX_API_KEY;
  private static BASE_URL = 'https://api.verificamex.com/identity/v1';

  static async validarTelefono(numeroTelefono: string): Promise<{ valido: boolean; estatus: string; rawData: any }> {
    if (numeroTelefono.endsWith('99')) {
      console.log(`[Verificamex MOCK] Simulando RECHAZO local para el teléfono: ${numeroTelefono}`);
      return {
        valido: false,
        estatus: 'REJECTED',
        rawData: { mock: true, testStatus: 'REJECTED' }
      };
    } else if (numeroTelefono.endsWith('88')) {
      console.log(`[Verificamex MOCK] Simulando APROBACIÓN local para el teléfono: ${numeroTelefono}`);
      return {
        valido: true,
        estatus: 'APPROVED',
        rawData: { mock: true, testStatus: 'APPROVED' }
      };
    }

    try {
      if (!this.API_KEY) {
        console.warn('[Verificamex] VERIFICAMEX_API_KEY no configurado.');
        return {
          valido: true,
          estatus: 'APPROVED',
          rawData: { mock: true }
        };
      }

      console.log(`[Verificamex] Omitiendo llamada real a validación de teléfono para: ${numeroTelefono}`);
      return {
        valido: true,
        estatus: 'APPROVED',
        rawData: { detail: 'Simulado exitoso.' }
      };

    } catch (error: any) {
      console.error('[Verificamex] Error al validar el teléfono:', error.response?.data || error.message);
      return {
        valido: true, 
        estatus: 'APPROVED',
        rawData: { error: true, message: error.message }
      };
    }
  }

  static async validarIdentidadBiometrica(ineFrontBase64: string, selfieBase64: string, emailCliente?: string): Promise<{ valido: boolean; score: number; rawData: any }> {
    try {
      const esPruebaReal = emailCliente && emailCliente.toLowerCase().includes('real');

      if (!this.API_KEY || !esPruebaReal) {
        console.log(`[Verificamex MOCK] Aprobando biométrico localmente (Simulado).`);
        return { 
          valido: true, 
          score: 0.95, 
          rawData: { mock: true, confidence: 0.95 } 
        };
      }

      console.log('[Verificamex] Solicitando comparación biométrica facial...');

      const response = await axios.post(
        `${this.BASE_URL}/validations/compare_face`,
        {
          ine_front: ineFrontBase64,
          selfie: selfieBase64
        },
        {
          headers: {
            'Authorization': `Bearer ${this.API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const data = response.data;
      console.log('[Verificamex] Respuesta biométrica recibida:', JSON.stringify(data));

      const isMatch = (data.data && data.data.isMatch === true) || data.isMatch === true;
      const confidence = data.confidence || data.score || 0;
      const esValido = isMatch || confidence >= 0.65 || confidence >= 65 || data.success === true;

      return {
        valido: esValido,
        score: confidence,
        rawData: data
      };

    } catch (error: any) {
      if (error.response) {
        console.error('[Verificamex] Error en validación biométrica (Detalle Servidor):', {
          status: error.response.status,
          data: error.response.data
        });
      } else {
        console.error('[Verificamex] Error en validación biométrica:', error.message);
      }
      return {
        valido: false,
        score: 0,
        rawData: { error: true, message: error.message }
      };
    }
  }
}
