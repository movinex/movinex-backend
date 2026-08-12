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

  // Baja un documento KYC ya guardado y lo devuelve como data URL base64 — hace falta
  // para volver a correr el biométrico cuando el frente del INE y la selfie se
  // guardaron en llamadas separadas (guardado progresivo, ver PATCH /:id/progreso en
  // index.ts): Verificamex necesita las dos imágenes juntas, pero solo el path queda
  // guardado en la fila, no el base64 original.
  static async descargarDocumentoKYC(path: string): Promise<string> {
    const { data, error } = await supabase.storage.from('documentos-kyc').download(path);
    if (error || !data) throw error || new Error(`No se pudo descargar el documento KYC ${path}.`);

    const buffer = Buffer.from(await data.arrayBuffer());
    const mimeType = data.type || 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
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
          tracking_number: datos.tracking_number || null,
          acepta_terminos: Boolean(datos.aceptaTerminos),
          costo_envio: Number(datos.costoEnvio || 0)
        }
      ])
      .select();

    if (error) throw error;
    return data[0];
  }

  // Se crea apenas se verifica el OTP (antes de pedir email/INE/selfie), para no
  // perder el lead si el cliente se cae del formulario a mitad de camino — el resto
  // de los campos se van completando después vía guardarProgresoSolicitud/
  // finalizarSolicitud, sobre esta misma fila (no se vuelve a insertar).
  static async crearSolicitudIniciada(datos: {
    celular: string;
    modelo: string;
    enganche: number;
    semanas: number;
    pago_semanal: number;
    costo_envio?: number;
  }) {
    const { data, error } = await supabase
      .from('solicitudes')
      .insert([
        {
          cliente: 'Pendiente de verificación',
          celular: datos.celular,
          email: null,
          modelo: datos.modelo,
          enganche: Number(datos.enganche),
          semanas: Number(datos.semanas),
          pago_semanal: Number(datos.pago_semanal),
          costo_envio: Number(datos.costo_envio || 0),
          estatus: 'Iniciada'
        }
      ])
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda lo que el cliente va completando (email, y/o una o más fotos ya subidas al
  // bucket privado) apenas está listo cada campo — no espera al submit final. Solo
  // actualiza las claves presentes en `campos`.
  static async guardarProgresoSolicitud(id: string, campos: Partial<{ email: string; ine_frente: string; ine_reverso: string; selfie: string; cliente: string; curp: string | null; ocr_ok: boolean; biometrico_ok: boolean }>) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update(campos)
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Cierra el ciclo: corre después de Verificamex (POST /:id/finalizar en index.ts),
  // con el nombre/CURP leídos por OCR y el estatus ya decidido.
  static async finalizarSolicitud(id: string, datos: { cliente: string; curp: string | null; estatus: string; acepta_terminos: boolean }) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({
        cliente: datos.cliente,
        curp: datos.curp,
        estatus: datos.estatus,
        acepta_terminos: datos.acepta_terminos
      })
      .eq('id', id)
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
  // Sin uso mientras el procesador activo sea Stripe (ver guardarSuscripcionStripe) —
  // se deja el método por si se retoma Conekta más adelante.
  static async guardarSuscripcionConekta(id: string, conektaCustomerId: string, conektaSubscriptionId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ conekta_customer_id: conektaCustomerId, conekta_subscription_id: conektaSubscriptionId })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda las referencias de Stripe una vez armada la suscripción semanal automática.
  static async guardarSuscripcionStripe(id: string, stripeCustomerId: string, stripeSubscriptionId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ stripe_customer_id: stripeCustomerId, stripe_subscription_id: stripeSubscriptionId })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda solo el customer_id de Stripe, sin subscription_id — caso de OXXO, que no
  // tiene ninguna Subscription asociada (no soporta cobro recurrente) pero igual
  // necesita el customer_id guardado para poder generarle un voucher nuevo cada semana.
  static async guardarStripeCustomerId(id: string, stripeCustomerId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ stripe_customer_id: stripeCustomerId })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda con qué tipo de payment_method se pagó el enganche ('card', 'oxxo',
  // 'customer_balance') — decide si la solicitud queda en cobro automático (tarjeta,
  // Stripe Subscription) o en cobro semanal manual por WhatsApp (OXXO/SPEI).
  static async guardarMetodoPagoEnganche(id: string, metodo: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ metodo_pago_enganche: metodo })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda la URL del recibo hosteado por Stripe (comprobante de pago del enganche),
  // para que el admin pueda mostrárselo al cliente o consultarlo sin entrar al
  // dashboard de Stripe.
  static async guardarReciboPago(id: string, url: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ stripe_receipt_url: url })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Guarda la CLABE persistente asignada al Customer de Stripe (cobro semanal manual
  // por saldo, ver stripeService.crearReferenciaPagoPersistente).
  static async guardarReferenciaPagoPersistente(id: string, clabe: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ stripe_clabe_referencia: clabe })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Programa cuándo debe salir el próximo link de pago semanal por WhatsApp — lo usa
  // tanto el webhook (primer cobro, 7 días después del enganche, igual que el trial de
  // la Subscription) como cobrosSemanalesService (siguiente cobro, tras mandar un link).
  static async programarProximoCobroSemanal(id: string, fecha: Date) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ proximo_cobro_semanal: fecha.toISOString() })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Trae las solicitudes que pagaron el enganche por SPEI (customer_balance) y les toca
  // recordatorio hoy — cobrosSemanalesService les reenvía la misma CLABE persistente,
  // que sí es válida para SPEI (confirmado contra la documentación de Stripe:
  // financial_addresses de México solo trae `spei` como red soportada).
  // El filtro semanas_pagadas < semanas se hace en JS porque PostgREST no soporta
  // comparar dos columnas entre sí directamente en un `.lt()`.
  static async getSolicitudesConCobroSpeiPendiente() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .eq('metodo_pago_enganche', 'customer_balance')
      .eq('pago_confirmado', true)
      .lte('proximo_cobro_semanal', new Date().toISOString());

    if (error) throw error;
    return (data || []).filter((s: any) => Number(s.semanas_pagadas || 0) < Number(s.semanas));
  }

  // Igual que arriba pero para OXXO — a diferencia de SPEI, OXXO no soporta pagos
  // recurrentes ni fondear un balance (Stripe: "Recurring payments: Not supported",
  // "Usability: Single-use"), así que no hay CLABE que reenviar — cobrosSemanalesService
  // le genera un voucher nuevo cada semana a cada una de estas.
  static async getSolicitudesConCobroOxxoPendiente() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .eq('metodo_pago_enganche', 'oxxo')
      .eq('pago_confirmado', true)
      .lte('proximo_cobro_semanal', new Date().toISOString());

    if (error) throw error;
    return (data || []).filter((s: any) => Number(s.semanas_pagadas || 0) < Number(s.semanas));
  }

  // Confirma un pago semanal ya cobrado por Stripe (webhook invoice.paid — aplica tanto
  // a la Subscription de tarjeta como a la de saldo/CLABE, las dos llevan el mismo
  // metadata.solicitud_id) e incrementa el contador de semanas pagadas.
  //
  // Deduplicado por invoice.id: Stripe garantiza entrega "al menos una vez" de sus
  // webhooks, así que el mismo invoice.paid puede llegar más de una vez. Sin este
  // chequeo, un reintento contaría la misma semana dos veces y podría disparar la
  // cancelación de la Subscription antes de tiempo, cortando semanas que el cliente
  // todavía debe — ver el cancelarSuscripcion en el webhook de index.ts.
  static async registrarPagoSemanalManual(id: string, invoiceId: string): Promise<{ semanas_pagadas: number; semanas: number; yaProcesada: boolean }> {
    const solicitud = await this.getSolicitudById(id);
    if (!solicitud) throw new Error(`Solicitud ${id} no encontrada.`);

    if (solicitud.ultima_invoice_pagada === invoiceId) {
      return {
        semanas_pagadas: Number(solicitud.semanas_pagadas || 0),
        semanas: Number(solicitud.semanas),
        yaProcesada: true
      };
    }

    const semanasPagadas = Number(solicitud.semanas_pagadas || 0) + 1;

    const { data, error } = await supabase
      .from('solicitudes')
      .update({ semanas_pagadas: semanasPagadas, ultima_invoice_pagada: invoiceId })
      .eq('id', id)
      .select();

    if (error) throw error;
    return { semanas_pagadas: semanasPagadas, semanas: Number(data[0].semanas), yaProcesada: false };
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

  // Limpieza diaria (cron) — borra códigos OTP ya expirados, no queda nada útil
  // en esas filas una vez pasado expira_en (ver getOtpVerificado, que ya los ignora).
  static async eliminarOtpExpirados() {
    const { error, count } = await supabase
      .from('otp_codigos')
      .delete({ count: 'exact' })
      .lt('expira_en', new Date().toISOString());

    if (error) throw error;
    return count ?? 0;
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
