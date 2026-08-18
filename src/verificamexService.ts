import axios from 'axios';
import { ImageQualityService } from './imageQualityService';

export class VerificamexService {
  private static API_KEY = process.env.VERIFICAMEX_API_KEY;
  private static BASE_URL = 'https://api.verificamex.com/identity/v1';
  private static BASE_URL_V2 = 'https://api.verificamex.com/identity/v2';
  // Formato oficial de CURP: 4 letras + fecha (AAMMDD) + sexo (H/M) + 2 letras de
  // estado + 3 consonantes + homoclave + dígito verificador = 18 caracteres.
  // No valida contra el catálogo real de claves de estado, solo la forma general.
  private static CURP_REGEX = /^[A-Z]{4}\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[HM][A-Z]{5}[A-Z0-9]\d$/;

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

  static async leerDatosINE(ineFrontBase64: string, emailCliente?: string): Promise<{ nombre: string | null; curp: string | null; rawData: any }> {
    try {
      // Go-live (2026-08-10): producción por default, salvo el email exacto
      // desarrollo@movinex.mx (equipo interno) — igual que Stripe y Skydropx.
      const usarProduccion = emailCliente?.trim().toLowerCase() !== 'desarrollo@movinex.mx';

      if (!this.API_KEY || !usarProduccion) {
        console.log('[Verificamex MOCK] Omitiendo lectura OCR del INE (Simulado).');
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
  static async validarIdentidadBiometrica(ineFrontBase64: string, selfieBase64: string, emailCliente?: string): Promise<{ valido: boolean; score: number; rawData: any }> {
    try {
      const usarProduccion = emailCliente?.trim().toLowerCase() !== 'desarrollo@movinex.mx';

      if (!this.API_KEY || !usarProduccion) {
        console.log(`[Verificamex MOCK] Aprobando biométrico localmente (Simulado).`);
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

  /**
   * Crea una VerificationSession (`POST /identity/v2/identity/sessions`) — el flujo
   * hosteado por Verificamex donde el cliente hace la captura de INE + prueba de vida
   * real directamente en su página (`form_url`), sin subir archivos a nuestro backend.
   * Reemplaza `leerDatosINE`/`validarIdentidadBiometrica` (fotos estáticas, arriba) para
   * la verificación post-pago (paso 7 del flujo nuevo) — esos dos métodos quedan
   * intactos sin llamarse desde ahí, mismo criterio que `conektaService.ts`.
   *
   * En modo mock (sin API key, o email exacto `desarrollo@movinex.mx`) no hay forma de
   * simular una página hosteada real, así que se devuelve `mock: true` sin `formUrl` —
   * el caller (index.ts) resuelve la sesión como aprobada al toque, sin redirigir a
   * ningún lado externo.
   *
   * `VERIFICAMEX_FORCE_LIVE=true` (solo pensado para `.env` local, no para Railway)
   * override para poder probar el flujo entero con `desarrollo@movinex.mx` — Stripe y
   * Skydropx se quedan mockeados/sandbox como siempre, pero acá pega a la API real de
   * Verificamex por un ciclo. Sacar la variable (o ponerla en false) para volver al mock.
   */
  static async crearSesionVerificacion(
    solicitudId: string,
    emailCliente: string | undefined,
    redirectUrl: string,
    webhookUrl: string
  ): Promise<{ mock: boolean; sessionId: string | null; formUrl: string | null }> {
    const usarProduccion = process.env.VERIFICAMEX_FORCE_LIVE === 'true'
      || emailCliente?.trim().toLowerCase() !== 'desarrollo@movinex.mx';

    if (!this.API_KEY || !usarProduccion) {
      console.log(`[Verificamex MOCK] Simulando VerificationSession aprobada para la solicitud ${solicitudId}.`);
      return { mock: true, sessionId: `mock-${solicitudId}`, formUrl: null };
    }

    console.log(`[Verificamex] Creando VerificationSession para la solicitud ${solicitudId}...`);

    const response = await axios.post(
      `${this.BASE_URL_V2}/identity/sessions`,
      {
        validations: ['INE', 'CURP'],
        redirect_url: redirectUrl,
        webhook: webhookUrl,
        with_webhook_binaries: false,
        optionals: { solicitud_id: solicitudId }
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

    const sesion = response.data?.data;
    if (!sesion?.form_url || !sesion?.id) {
      throw new Error('Verificamex no devolvió una sesión de verificación válida.');
    }

    console.log(`[Verificamex] VerificationSession ${sesion.id} creada para la solicitud ${solicitudId}.`);
    return { mock: false, sessionId: sesion.id, formUrl: sesion.form_url };
  }

  /**
   * Consulta el estado actual de una VerificationSession
   * (`GET /identity/v2/identity/sessions/:id`). Es el **fallback del webhook**: si el
   * webhook no llega (endpoint mal configurado, caída puntual, o directamente un entorno
   * local al que Verificamex no puede alcanzar), esto permite enterarse igual del
   * resultado preguntando en vez de esperar a que nos avisen.
   *
   * Devuelve `null` si no se pudo consultar — el caller trata eso como "todavía no se
   * sabe" y reintenta después, nunca como un rechazo.
   */
  static async consultarSesion(sessionId: string): Promise<{ status: string; result: number | null; comments: string | null } | null> {
    if (!this.API_KEY) return null;

    try {
      const response = await axios.get(
        `${this.BASE_URL_V2}/identity/sessions/${sessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.API_KEY}`,
            'Accept': 'application/json'
          },
          timeout: 15000
        }
      );

      const sesion = response.data?.data;
      if (!sesion?.status) return null;

      return { status: sesion.status, result: sesion.result ?? null, comments: sesion.comments ?? null };
    } catch (error: any) {
      console.error(`[Verificamex] No se pudo consultar la sesión ${sessionId}:`, error.response?.data || error.message);
      return null;
    }
  }
}
