import axios from 'axios';
import { ImageQualityService } from './imageQualityService';

export class VerificamexService {
  private static API_KEY = process.env.VERIFICAMEX_API_KEY;
  private static BASE_URL = 'https://api.verificamex.com/identity/v1';
  // Formato oficial de CURP: 4 letras + fecha (AAMMDD) + sexo (H/M) + 2 letras de
  // estado + 3 consonantes + homoclave + dígito verificador = 18 caracteres.
  // No valida contra el catálogo real de claves de estado, solo la forma general.
  private static CURP_REGEX = /^[A-Z]{4}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HM][A-Z]{5}[A-Z0-9]\d$/;

  /**
   * La validación de teléfono contra Verificamex nunca se llegó a conectar: siempre
   * aprueba. Se mantiene el método porque `esSolicitudValida` lo consulta como uno de
   * los tres factores y así queda el lugar donde enchufar la API real el día que se
   * contrate.
   *
   * Hasta el 2026-08-16 tenía además dos atajos de prueba por sufijo del número:
   * terminado en "99" se rechazaba y en "88" se aprobaba. Eso no era una simulación
   * inofensiva — cualquier cliente real con un celular terminado en 99 (1 de cada 100)
   * quedaba fuera de la aprobación automática sin razón. Eliminados junto con el resto
   * del entorno de prueba.
   */
  static async validarTelefono(numeroTelefono: string): Promise<{ valido: boolean; estatus: string; rawData: any }> {
    console.log(`[Verificamex] Validación de teléfono no conectada, se aprueba por default: ${numeroTelefono}`);
    return {
      valido: true,
      estatus: 'APPROVED',
      rawData: { sinConectar: true }
    };
  }

  static async leerDatosINE(ineFrontBase64: string): Promise<{ nombre: string | null; curp: string | null; rawData: any }> {
    try {
      if (!this.API_KEY) {
        console.log('[Verificamex MOCK] Omitiendo lectura OCR del INE (falta VERIFICAMEX_API_KEY).');
        return { nombre: null, curp: null, rawData: { mock: true } };
      }

      const calidad = await ImageQualityService.evaluarCalidad(ineFrontBase64);
      if (!calidad.nitida) {
        console.warn(`[Verificamex] Frente del INE rechazado por calidad de imagen (varianza=${calidad.varianza.toFixed(1)}, brillo=${calidad.brillo.toFixed(1)}) — se omite el OCR, no hay forma confiable de leerlo.`);
        return { nombre: null, curp: null, rawData: { calidadInsuficiente: true, ...calidad } };
      }

      console.log('[Verificamex] Solicitando lectura OCR del frente del INE...');

      const response = await axios.post(
        `${this.BASE_URL}/ocr/obverse`,
        { ine_front: ineFrontBase64 },
        {
          headers: {
            'Authorization': `Bearer ${this.API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const parseOcr: Array<{ type: string; value: string }> = response.data?.data?.parse_ocr || [];
      const getCampo = (tipo: string) => parseOcr.find((c) => c.type === tipo)?.value?.trim() || null;

      // No todas las credenciales devuelven "FullName"; si falta, se arma con Name + Surname.
      const nombrePila = getCampo('Name');
      const apellidos = getCampo('Surname');
      const nombre = getCampo('FullName') || [nombrePila, apellidos].filter(Boolean).join(' ') || null;

      const curpLeido = getCampo('PersonalNumber');
      const curp = curpLeido && this.CURP_REGEX.test(curpLeido) ? curpLeido : null;
      if (curpLeido && !curp) {
        console.warn(`[Verificamex] CURP leído por OCR no tiene formato válido, se descarta: "${curpLeido}"`);
      }

      return {
        nombre,
        curp,
        rawData: response.data
      };
    } catch (error: any) {
      console.error('[Verificamex] Error al leer el INE por OCR:', error.response?.data || error.message);
      return { nombre: null, curp: null, rawData: { error: true, message: error.message } };
    }
  }

  /**
   * NOTA: existió una versión de esto que combinaba OCR + biometría en una sola llamada
   * a /validations/basic, para poder usar el score numérico del check Biometrics_FaceMatching
   * en vez de este booleano ciego. Se revirtió porque /validations/basic devuelve
   * consistentemente 500 Server Error (confirmado con las 3 imágenes reales, no es un
   * problema de nuestro payload — coincide exacto con la doc de Verificamex). Reportarlo
   * a su soporte; mientras tanto quedamos con isMatch sin score ni umbral configurable.
   */
  static async validarIdentidadBiometrica(ineFrontBase64: string, selfieBase64: string): Promise<{ valido: boolean; score: number; rawData: any }> {
    try {
      if (!this.API_KEY) {
        console.log(`[Verificamex MOCK] Aprobando biométrico localmente (falta VERIFICAMEX_API_KEY).`);
        return {
          valido: true,
          score: 0.95,
          rawData: { mock: true, confidence: 0.95 }
        };
      }

      const [calidadFrente, calidadSelfie] = await Promise.all([
        ImageQualityService.evaluarCalidad(ineFrontBase64),
        ImageQualityService.evaluarCalidad(selfieBase64)
      ]);
      if (!calidadFrente.nitida || !calidadSelfie.nitida) {
        console.warn(`[Verificamex] Biométrico rechazado por calidad de imagen (INE nítida=${calidadFrente.nitida}, selfie nítida=${calidadSelfie.nitida}) — se omite la comparación facial.`);
        return {
          valido: false,
          score: 0,
          rawData: { calidadInsuficiente: true, calidadFrente, calidadSelfie }
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
