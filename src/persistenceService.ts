import { supabase } from './supabase';

export class PersistenceService {

  static async subirImagenCelular(base64DataUrl: string): Promise<string> {
    const match = base64DataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      throw new Error('Formato de imagen inválido. Se espera un data URL base64.');
    }

    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const extension = mimeType.split('/')[1] || 'jpg';
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from('celulares')
      .upload(fileName, buffer, { contentType: mimeType, cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    const { data } = supabase.storage.from('celulares').getPublicUrl(fileName);
    return data.publicUrl;
  }

  // Documentos KYC (INE/selfie): bucket privado, se guarda el path, no la imagen ni una URL pública.
  static async subirDocumentoKYC(base64DataUrl: string, prefijo: string): Promise<string> {
    const match = base64DataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) {
      throw new Error('Formato de imagen inválido. Se espera un data URL base64.');
    }

    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const extension = mimeType.split('/')[1] || 'jpg';
    const path = `${prefijo}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from('documentos-kyc')
      .upload(path, buffer, { contentType: mimeType, cacheControl: '3600', upsert: false });

    if (uploadError) throw uploadError;

    return path;
  }

  // Genera una URL firmada de corta duración para un documento KYC ya subido al bucket privado.
  static async firmarDocumentoKYC(path: string, expirySeconds = 600): Promise<string | null> {
    const { data, error } = await supabase.storage
      .from('documentos-kyc')
      .createSignedUrl(path, expirySeconds);

    if (error || !data) return null;
    return data.signedUrl;
  }

  static async saveSolicitud(datos: any) {
    const { data, error } = await supabase
      .from('solicitudes')
      .insert([
        {
          cliente: datos.cliente || 'Pendiente de verificación',
          curp: datos.curp || null,
          celular: datos.celular,
          email: datos.email,
          modelo: datos.modelo,
          enganche: Number(datos.enganche),
          semanas: Number(datos.semanas),
          pago_semanal: Number(datos.pago_semanal),
          ine_frente: datos.ine_frente,
          ine_reverso: datos.ine_reverso,
          selfie: datos.selfie,
          estatus: datos.estatus || 'Pendiente',
          checkout_url: datos.checkout_url || null,
          codigo_postal: datos.codigo_postal || null,
          direccion_envio: datos.direccion_envio || null,
          tracking_number: datos.tracking_number || null
        }
      ])
      .select();

    if (error) throw error;
    return data[0];
  }

  static async updateEstatus(id: string, nuevoEstatus: 'Aprobado' | 'Rechazado' | 'Pendiente de envío' | 'Preparando paquete' | 'Enviado') {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ estatus: nuevoEstatus })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async updateEstatusByContacto(contacto: string, nuevoEstatus: string, extraData?: any) {
    const telefonoLimpio = contacto.replace(/\D/g, '');
    const telefonoSinPrefijo = telefonoLimpio.slice(-10);

    const updateFields: any = { estatus: nuevoEstatus };
    if (extraData?.tracking_number) {
      updateFields.tracking_number = extraData.tracking_number;
    }
    if (extraData?.label_url) {
      updateFields.label_url = extraData.label_url;
    }

    const { data, error } = await supabase
      .from('solicitudes')
      .update(updateFields)
      .or(`email.eq.${contacto},celular.ilike.%${telefonoSinPrefijo}`)
      .select();

    if (error) throw error;
    return data;
  }

  // Confirma el pago del enganche (llamado desde el webhook order.paid) y avanza el
  // estatus a "Preparando paquete" en la misma actualización — a partir de acá el
  // admin arma la caja, carga el IMEI, y va avanzando el estatus a mano
  // (Preparando paquete -> Pendiente de envío -> Enviado).
  static async marcarPagoConfirmadoByContacto(contacto: string) {
    const telefonoLimpio = contacto.replace(/\D/g, '');
    const telefonoSinPrefijo = telefonoLimpio.slice(-10);

    const { data, error } = await supabase
      .from('solicitudes')
      .update({ pago_confirmado: true, estatus: 'Preparando paquete' })
      .or(`email.eq.${contacto},celular.ilike.%${telefonoSinPrefijo}`)
      .select();

    if (error) throw error;
    return data;
  }

  // Guarda las referencias de Conekta una vez armada la suscripción semanal automática.
  static async guardarSuscripcionConekta(id: string, conektaCustomerId: string, conektaSubscriptionId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ conekta_customer_id: conektaCustomerId, conekta_subscription_id: conektaSubscriptionId })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda el tracking/guía real generados por Skydropx, sin tocar el estatus — el
  // estatus lo mueve el admin a mano (o el webhook de pago), no la generación de la guía.
  static async guardarEnvio(id: string, datos: { tracking_number?: string; label_url?: string | null }) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update(datos)
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async guardarImei(id: string, imei: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ imei })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async getEstatusPagoByContacto(contacto: string) {
    const telefonoLimpio = contacto.replace(/\D/g, '');
    const telefonoSinPrefijo = telefonoLimpio.slice(-10);

    const { data, error } = await supabase
      .from('solicitudes')
      .select('id, pago_confirmado')
      .or(`email.eq.${contacto},celular.ilike.%${telefonoSinPrefijo}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  static async saveDomicilio(id: string, datos: any) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({
        calle: datos.calle,
        numero_exterior: datos.numero_exterior,
        numero_interior: datos.numero_interior || null,
        colonia: datos.colonia,
        alcaldia_municipio: datos.alcaldia_municipio,
        estado: datos.estado,
        codigo_postal: datos.codigo_postal
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async guardarOtp(celular: string, codigo: string, expiraEn: Date) {
    const { data, error } = await supabase
      .from('otp_codigos')
      .insert([{ celular, codigo, expira_en: expiraEn.toISOString() }])
      .select();

    if (error) throw error;
    return data[0];
  }

  // Trae el código OTP vigente (no expirado) más reciente para ese celular.
  static async getOtpVigente(celular: string) {
    const { data, error } = await supabase
      .from('otp_codigos')
      .select('*')
      .eq('celular', celular)
      .gt('expira_en', new Date().toISOString())
      .order('creado_en', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  static async incrementarIntentoOtp(id: string, intentos: number) {
    const { error } = await supabase
      .from('otp_codigos')
      .update({ intentos })
      .eq('id', id);

    if (error) throw error;
  }

  static async eliminarOtp(id: string) {
    const { error } = await supabase
      .from('otp_codigos')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  static async marcarOtpVerificado(id: string) {
    const { error } = await supabase
      .from('otp_codigos')
      .update({ verificado: true })
      .eq('id', id);

    if (error) throw error;
  }

  // Confirma server-side que este celular verificó su OTP hace poco (dentro de la
  // misma ventana de expira_en) — usado como gate anti-bot antes de crear una solicitud.
  static async getOtpVerificado(celular: string) {
    const { data, error } = await supabase
      .from('otp_codigos')
      .select('id')
      .eq('celular', celular)
      .eq('verificado', true)
      .gt('expira_en', new Date().toISOString())
      .order('creado_en', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  static async getSolicitudById(id: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  static async getSolicitudes() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Las solicitudes nuevas guardan el path del bucket privado, no la imagen ni una URL.
    // Se firma al momento de leer, con vencimiento corto. Las filas viejas (base64 directo) quedan igual.
    const esPath = (valor: any) => typeof valor === 'string' && valor.length > 0 && !valor.startsWith('data:');

    const solicitudesConUrls = await Promise.all(
      (data || []).map(async (s: any) => {
        const [ineFrenteUrl, ineReversoUrl, selfieUrl] = await Promise.all([
          esPath(s.ine_frente) ? this.firmarDocumentoKYC(s.ine_frente) : s.ine_frente,
          esPath(s.ine_reverso) ? this.firmarDocumentoKYC(s.ine_reverso) : s.ine_reverso,
          esPath(s.selfie) ? this.firmarDocumentoKYC(s.selfie) : s.selfie
        ]);
        return { ...s, ine_frente: ineFrenteUrl, ine_reverso: ineReversoUrl, selfie: selfieUrl };
      })
    );

    return solicitudesConUrls;
  }

  static async getCelulares() {
    const { data, error } = await supabase
      .from('celulares')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  static async createCelular(datos: any) {
    const enganche = Number(datos.enganche);
    const montoSemanal26 = Number(datos.monto_semanal_26);
    const montoSemanal52 = Number(datos.monto_semanal_52);

    const { data, error } = await supabase
      .from('celulares')
      .insert([
        {
          id: datos.id,
          modelo: datos.modelo,
          marca: datos.marca,
          precio_base: Number(datos.precio_base),
          enganche,
          monto_semanal_26: montoSemanal26,
          monto_semanal_52: montoSemanal52,
          total_pagar_26: montoSemanal26 * 26 + enganche,
          total_pagar_52: montoSemanal52 * 52 + enganche,
          imagen: datos.imagen,
          envio_gratis: datos.envio_gratis !== false,
          costo_envio: Number(datos.costo_envio || 0),
          updated_at: new Date().toISOString(),
          specs_pantalla: datos.specs_pantalla || '',
          specs_procesador: datos.specs_procesador || '',
          specs_ram_almacenamiento: datos.specs_ram_almacenamiento || '',
          specs_microsd: datos.specs_microsd || '',
          specs_camara_trasera: datos.specs_camara_trasera || '',
          specs_camara_frontal: datos.specs_camara_frontal || '',
          specs_bateria: datos.specs_bateria || '',
          specs_sistema: datos.specs_sistema || '',
          specs_seguridad: datos.specs_seguridad || '',
          specs_resistencia: datos.specs_resistencia || '',
          specs_conectividad: datos.specs_conectividad || '',
          specs_dimensiones_peso: datos.specs_dimensiones_peso || ''
        }
      ])
      .select();

    if (error) throw error;
    return data[0];
  }

  static async updateCelular(id: string, datos: any) {
    const enganche = Number(datos.enganche);
    const montoSemanal26 = Number(datos.monto_semanal_26);
    const montoSemanal52 = Number(datos.monto_semanal_52);

    const { data, error } = await supabase
      .from('celulares')
      .update({
        modelo: datos.modelo,
        marca: datos.marca,
        precio_base: Number(datos.precio_base),
        enganche,
        monto_semanal_26: montoSemanal26,
        monto_semanal_52: montoSemanal52,
        total_pagar_26: montoSemanal26 * 26 + enganche,
        total_pagar_52: montoSemanal52 * 52 + enganche,
        imagen: datos.imagen,
        envio_gratis: datos.envio_gratis !== false,
        costo_envio: Number(datos.costo_envio || 0),
        updated_at: new Date().toISOString(),
        specs_pantalla: datos.specs_pantalla || '',
        specs_procesador: datos.specs_procesador || '',
        specs_ram_almacenamiento: datos.specs_ram_almacenamiento || '',
        specs_microsd: datos.specs_microsd || '',
        specs_camara_trasera: datos.specs_camara_trasera || '',
        specs_camara_frontal: datos.specs_camara_frontal || '',
        specs_bateria: datos.specs_bateria || '',
        specs_sistema: datos.specs_sistema || '',
        specs_seguridad: datos.specs_seguridad || '',
        specs_resistencia: datos.specs_resistencia || '',
        specs_conectividad: datos.specs_conectividad || '',
        specs_dimensiones_peso: datos.specs_dimensiones_peso || ''
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async deleteCelular(id: string) {
    const { data, error } = await supabase
      .from('celulares')
      .delete()
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }
}
