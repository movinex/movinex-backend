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

  // Se crea apenas se verifica el OTP (antes de pedir datos/dirección), para no
  // perder el lead si el cliente se cae del formulario a mitad de camino — el resto
  // de los campos se van completando después vía guardarProgresoSolicitud y las demás
  // rutas de cada paso, sobre esta misma fila (no se vuelve a insertar).
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

  // Guarda lo que el cliente va completando (datos personales, email, y/o una o más
  // fotos ya subidas al bucket privado) apenas está listo cada campo/paso — no espera
  // al submit final. Solo actualiza las claves presentes en `campos`.
  static async guardarProgresoSolicitud(id: string, campos: Partial<{
    email: string; ine_frente: string; ine_reverso: string; selfie: string; cliente: string;
    curp: string | null; ocr_ok: boolean; biometrico_ok: boolean;
    nombre: string; apellidos: string; fecha_nacimiento: string; genero: string;
    estado_civil: string; dependientes_economicos: number; nivel_estudios: string;
  }>) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update(campos)
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
  // Busca solicitudes por email o celular. Solo la usa el webhook de Conekta (inactivo),
  // que a diferencia de Stripe no manda un solicitud_id propio. Cortocircuita si el
  // contacto no tiene teléfono utilizable: la versión anterior armaba el filtro
  // `celular.ilike.%${...}` con el sufijo vacío cuando el contacto era un email sin
  // dígitos, y ese `%` suelto matcheaba TODAS las filas de la tabla (bug encontrado
  // 2026-08-14: 12 de 12 solicitudes habían quedado marcadas como pagadas con 5 pagos
  // reales).
  static async getSolicitudesByContacto(contacto: string) {
    const filtros: string[] = [];
    if (contacto.includes('@')) {
      filtros.push(`email.eq.${contacto}`);
    }
    const telefonoSinPrefijo = contacto.replace(/\D/g, '').slice(-10);
    if (telefonoSinPrefijo.length === 10) {
      filtros.push(`celular.ilike.%${telefonoSinPrefijo}`);
    }
    if (!filtros.length) return [];

    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .or(filtros.join(','));

    if (error) throw error;
    return data;
  }

  // Confirma el pago del enganche y pasa a "Verificando identidad" — ya NO salta
  // directo a "Preparando paquete": con el flujo nuevo (pago antes que KYC), todavía
  // falta la sesión de Verificamex en vivo antes de poder armar el envío. Guarda
  // también el payment_intent para poder reembolsar después desde el botón de
  // cancelar del admin (StripeService.reembolsarPago).
  static async marcarPagoConfirmado(solicitudId: string, paymentIntentId?: string) {
    const update: Record<string, any> = {
      pago_confirmado: true,
      estatus: 'Verificando identidad',
      pago_confirmado_at: new Date().toISOString()
    };
    if (paymentIntentId) update.stripe_payment_intent_id = paymentIntentId;

    const { data, error } = await supabase
      .from('solicitudes')
      .update(update)
      .eq('id', solicitudId)
      .select();

    if (error) throw error;
    return data;
  }

  // Paso 5: confirma el 2do OTP + aceptación de términos, y deja la solicitud lista
  // para que el frontend pueda pedir la Checkout Session de Stripe.
  static async confirmarTerminos(id: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ acepta_terminos: true, estatus: 'Lista para pago' })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Paso 7: guarda el id de la VerificationSession recién creada (primer intento o
  // reintento) — no toca verificamex_intentos, ese contador es acumulado a lo largo de
  // toda la solicitud, no por sesión.
  static async guardarSesionVerificamex(id: string, sessionId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ verificamex_session_id: sessionId, verificamex_status: 'OPEN' })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async getSolicitudByVerificamexSessionId(sessionId: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .eq('verificamex_session_id', sessionId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  // La sesión de Verificamex terminó FAILED — suma un intento fallido y devuelve el
  // contador actualizado, para que index.ts decida si todavía quedan reintentos (tope 3)
  // o si hay que escalar a revisión manual.
  // Devuelve el número de intento ya consumido, o `null` si otro proceso (webhook vs
  // polling, que pueden llegar juntos) ya había contado este mismo fallo — el `.neq`
  // hace que solo uno de los dos gane, así un rechazo no consume dos de los 3 intentos.
  static async registrarFalloVerificamex(id: string, result?: number | null, comments?: string | null, errores?: any[] | null): Promise<number | null> {
    const solicitud = await this.getSolicitudById(id);
    const intentos = Number(solicitud?.verificamex_intentos || 0) + 1;

    const { data, error } = await supabase
      .from('solicitudes')
      .update({ verificamex_intentos: intentos, verificamex_status: 'FAILED', verificamex_result: result ?? null, verificamex_comments: comments ?? null, verificamex_errores: errores ?? null })
      .eq('id', id)
      .neq('verificamex_status', 'FAILED')
      .select();

    if (error) throw error;
    return data && data.length ? intentos : null;
  }

  // La sesión de Verificamex terminó FINISHED — marca la identidad como verificada.
  // El disparo de Skydropx y el mensaje de WhatsApp corren aparte, en index.ts.
  //
  // El `.in(...)` sobre el estatus actual no es decorativo: hace que la actualización sea
  // un compare-and-swap. El webhook de Verificamex y el polling de /estado-verificacion
  // pueden llegar al mismo tiempo con el mismo resultado, y sin esto los dos pasarían el
  // chequeo previo y dispararían Skydropx dos veces — dos guías reales cobradas por el
  // mismo paquete. Devuelve null si otro proceso ya la movió, y ahí el caller no hace nada.
  static async aprobarVerificacion(id: string, result?: number | null, comments?: string | null, errores?: any[] | null) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ ocr_ok: true, biometrico_ok: true, estatus: 'Preparando paquete', verificamex_status: 'FINISHED', verificamex_result: result ?? null, verificamex_comments: comments ?? null, verificamex_errores: errores ?? null })
      .eq('id', id)
      // 'Aprobado' cubre la aprobación manual del admin, que ya movió el estatus antes de
      // llegar acá; 'Verificando identidad' es el camino automático.
      .in('estatus', ['Verificando identidad', 'Aprobado'])
      .select();

    if (error) throw error;
    return data && data.length ? data[0] : null;
  }

  // Se agotaron los 3 intentos de la sesión en vivo — pasa a revisión manual, mismo
  // estatus "Pendiente" que ya usaba el flujo viejo para este caso.
  static async escalarRevisionManual(id: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ ocr_ok: false, biometrico_ok: false, estatus: 'Pendiente' })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Botón "Cancelar solicitud" del admin — cancela todo del lado de Supabase; Stripe
  // (reembolso + cancelar suscripción) se resuelve aparte en index.ts antes de llamar acá.
  static async cancelarSolicitud(id: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ estatus: 'Cancelada' })
      .eq('id', id)
      .select();

    if (error) throw error;

    // Si esta solicitud tenía un crédito activo, cancelarlo también libera el CURP —
    // sin esto, cancelar una solicitud pagando dejaría su CURP bloqueado para siempre.
    await this.cancelarCredito(id);

    return data[0];
  }

  // Cuántos días se sigue insistiendo con los recordatorios antes de dar el lead por
  // perdido. Sin este tope, una solicitud abandonada hace meses recibiría un WhatsApp
  // todos los días para siempre — además de ser spam, Meta castiga la calidad del número
  // (y con la calidad en el piso se cae también el OTP, que es crítico para vender).
  private static DIAS_MAX_RECORDATORIO = 7;

  // Solicitudes todavía "vivas" en algún punto del flujo pre-envío y lo bastante
  // recientes como para que valga la pena insistir — candidatas para el cron de
  // recordatorios de acompañamiento (acompanamientoService.ts).
  static async getSolicitudesActivasParaRecordatorio() {
    const desde = new Date(Date.now() - this.DIAS_MAX_RECORDATORIO * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .in('estatus', ['Iniciada', 'Lista para pago', 'Verificando identidad'])
      .gte('created_at', desde);

    if (error) throw error;
    return data || [];
  }

  // Dedupe de recordatorios: guarda cuál fue el último tipo mandado y cuándo, para que
  // el cron no repita el mismo aviso el mismo día.
  static async registrarRecordatorioEnviado(id: string, tipo: string) {
    const { error } = await supabase
      .from('solicitudes')
      .update({ ultimo_recordatorio_tipo: tipo, ultimo_recordatorio_enviado_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
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
  // También limpia cobro_semanal_fallido: si se está programando el próximo cobro es
  // porque el actual quedó resuelto (pagado), sea cual sea el método.
  static async programarProximoCobroSemanal(id: string, fecha: Date) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ proximo_cobro_semanal: fecha.toISOString(), cobro_semanal_fallido: false })
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Compare-and-swap para el cron de cobros semanales: reclama el turno de esta semana
  // ANTES de mandar nada, no después. Si el update de acá adelante `proximo_cobro_semanal`
  // no aplica sobre ninguna fila (porque otra corrida en paralelo — dos instancias de
  // Railway solapadas durante un deploy, por ejemplo — ya lo reclamó primero), el `.eq`
  // sobre el valor viejo no encuentra nada, `data` queda vacío y esta corrida se retira
  // sin mandar el WhatsApp. Encontrado en vivo 2026-08-21: un cliente recibió el mismo
  // recordatorio de CLABE dos veces a la misma hora porque el reclamo pasaba DESPUÉS del
  // envío, así que las dos corridas alcanzaban a mandar antes de que ninguna actualizara
  // la fecha.
  static async reclamarCobroSemanal(id: string, vencimientoEsperado: string, siguienteFecha: Date): Promise<boolean> {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ proximo_cobro_semanal: siguienteFecha.toISOString(), cobro_semanal_fallido: false })
      .eq('id', id)
      .eq('proximo_cobro_semanal', vencimientoEsperado)
      .select();

    if (error) throw error;
    return (data || []).length > 0;
  }

  // El cobro automático de tarjeta falló (invoice.payment_failed) — deja la solicitud
  // visiblemente marcada en Cobranza en vez de mostrar la próxima fecha como si nada,
  // mientras se manda un link de pago de respaldo (ver StripeService.crearLinkReintentoTarjeta).
  static async marcarCobroSemanalFallido(id: string) {
    const { error } = await supabase
      .from('solicitudes')
      .update({ cobro_semanal_fallido: true })
      .eq('id', id);

    if (error) throw error;
  }

  // Compare-and-swap para invoice.payment_failed, mismo problema que reclamarCobroSemanal
  // pero del lado de los fallos: Stripe garantiza entrega "al menos una vez" de sus
  // webhooks, y una redelivery típicamente coincide con un restart del backend (Railway
  // no llegó a responder 200 antes de reiniciar, o el evento quedó en cola durante el
  // tiempo que el server estuvo abajo y Stripe lo reintenta apenas vuelve a levantar).
  // A diferencia de invoice.paid (que ya dedupea por invoice.id porque una factura solo
  // se paga una vez), una misma invoice puede fallar de verdad más de una vez — Smart
  // Retries reintenta el cobro varios días seguidos — así que la clave es invoice.id +
  // attempt_count, no invoice.id solo: eso permite un aviso por cada intento fallido
  // real, pero bloquea que la MISMA entrega repetida del webhook mande el WhatsApp y
  // genere un link de reintento de tarjeta nuevo cada vez que el proceso reinicia.
  static async registrarFalloInvoiceSiNuevo(id: string, invoiceId: string, attemptCount: number): Promise<boolean> {
    const clave = `${invoiceId}_${attemptCount}`;
    const solicitud = await this.getSolicitudById(id);
    if (!solicitud) throw new Error(`Solicitud ${id} no encontrada.`);

    if (solicitud.ultima_invoice_fallida === clave) {
      return false;
    }

    const { error } = await supabase
      .from('solicitudes')
      .update({ ultima_invoice_fallida: clave })
      .eq('id', id);

    if (error) throw error;
    return true;
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
      .not('estatus', 'in', '("Cancelada","Rechazado")')
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
      .not('estatus', 'in', '("Cancelada","Rechazado")')
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

  // ---------------------------------------------------------------------------
  // Historial de pagos (tabla `pagos`, ver scripts/migraciones/2026-08-pagos.sql)
  // ---------------------------------------------------------------------------

  /**
   * Deja una fila por cobro. `stripe_id` es UNIQUE, así que esto es idempotente: el
   * webhook y el backfill pueden pisarse sin duplicar.
   *
   * **Nunca lanza.** Guardar el historial no puede tumbar el procesamiento de un pago:
   * si esto falla, el cobro igual se aplicó (semanas_pagadas ya avanzó) y lo que se
   * pierde es una fila de auditoría, que el backfill puede recuperar después desde
   * Stripe. Mismo criterio que la bitácora de autovia-dashboard.
   *
   * @returns true si insertó, false si ya existía o si falló.
   */
  static async registrarPago(pago: {
    solicitudId: string;
    tipo: 'enganche' | 'semanal';
    numeroSemana?: number | null;
    monto: number;
    fecha: Date | string;
    metodo?: string | null;
    estado?: 'pagado' | 'fallido' | 'reembolsado';
    stripeId: string;
    origen?: 'webhook' | 'backfill';
  }): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('pagos')
        .upsert(
          {
            solicitud_id: pago.solicitudId,
            tipo: pago.tipo,
            numero_semana: pago.numeroSemana ?? null,
            monto: pago.monto,
            fecha: pago.fecha instanceof Date ? pago.fecha.toISOString() : pago.fecha,
            metodo: pago.metodo ?? null,
            estado: pago.estado || 'pagado',
            stripe_id: pago.stripeId,
            origen: pago.origen || 'webhook'
          },
          { onConflict: 'stripe_id', ignoreDuplicates: true }
        )
        .select();

      if (error) throw error;
      // Con ignoreDuplicates, un choque devuelve el array vacío en vez de error.
      return (data || []).length > 0;
    } catch (error: any) {
      console.error(`[Pagos] No se pudo registrar el pago ${pago.stripeId}:`, error.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Historial de mensajes de WhatsApp (tabla `mensajes_whatsapp`) — un renglón por
  // cada intento de envío (exitoso o fallido) hecho por WhatsappOtpService, para poder
  // mostrar en el detalle de la solicitud (/sadmin) qué se le mandó y cuándo. Meta no
  // expone ningún endpoint para consultar mensajes ya enviados (la Cloud API es
  // solo-envío, sin historial vía API) — este es el único registro que existe.
  // ---------------------------------------------------------------------------

  /**
   * **Nunca lanza.** Igual que registrarPago: dejar la traza de un mensaje no puede
   * tumbar el envío real, que ya ocurrió (o falló, y eso también se quiere loguear)
   * para cuando esto se llama. `solicitudId` viene vacío en el único mensaje que se
   * manda antes de que exista la solicitud (el OTP de verificación de teléfono) — ese
   * caso simplemente no deja traza, porque no hay a qué solicitud asociarlo todavía.
   */
  static async registrarMensajeWhatsapp(mensaje: {
    solicitudId: string | undefined;
    celular: string;
    tipo: string;
    exito: boolean;
    mock: boolean;
    detalle?: string;
  }): Promise<void> {
    try {
      const { error } = await supabase.from('mensajes_whatsapp').insert({
        // El OTP se manda antes de que exista la solicitud — queda sin dueño
        // (solicitud_id null) hasta que vincularMensajesPendientes lo adopte, apenas se
        // crea la solicitud con ese mismo celular (ver POST /api/solicitudes[/iniciar]).
        solicitud_id: mensaje.solicitudId ?? null,
        celular: mensaje.celular,
        tipo: mensaje.tipo,
        exito: mensaje.exito,
        mock: mensaje.mock,
        detalle: mensaje.detalle ?? null
      });

      if (error) throw error;
    } catch (error: any) {
      console.error(`[Mensajes WhatsApp] No se pudo registrar el mensaje "${mensaje.tipo}" (solicitud ${mensaje.solicitudId ?? 'sin asignar'}):`, error.message);
    }
  }

  /**
   * Adopta los mensajes de WhatsApp que se mandaron antes de que esta solicitud
   * existiera (hoy, solo el OTP de verificación de teléfono) — se llama justo después
   * de crear la solicitud, con el mismo celular. Nunca lanza: no vincular un mensaje
   * viejo no puede tumbar la creación de la solicitud, que ya ocurrió.
   */
  static async vincularMensajesPendientes(celular: string, solicitudId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('mensajes_whatsapp')
        .update({ solicitud_id: solicitudId })
        .eq('celular', celular)
        .is('solicitud_id', null);

      if (error) throw error;
    } catch (error: any) {
      console.error(`[Mensajes WhatsApp] No se pudieron vincular los mensajes previos de ${celular} a la solicitud ${solicitudId}:`, error.message);
    }
  }

  /**
   * Igual que registrarMensajeWhatsapp, pero para el backfill (ver scripts/backfillMensajesWhatsapp.ts):
   * reconstruye mensajes de ANTES de que esta tabla existiera, a partir de otras fuentes
   * ya guardadas (`pagos` para tarjeta fallida, `pago_confirmado_at` para pago
   * confirmado) — no es un registro directo del envío, es inferido. `fuenteId` es
   * `pagos.stripe_id` o una clave armada a mano; UNIQUE en la tabla (a diferencia de
   * `registrarMensajeWhatsapp`, que no tiene ninguna clave — un envío en vivo no
   * necesita dedup, cada llamada es un mensaje real distinto) para que correr el script
   * dos veces no duplique filas.
   */
  static async registrarMensajeWhatsappBackfill(mensaje: {
    solicitudId: string;
    celular: string;
    tipo: string;
    creadoEn: Date;
    fuenteId: string;
  }): Promise<boolean> {
    const { data, error } = await supabase
      .from('mensajes_whatsapp')
      .upsert(
        {
          solicitud_id: mensaje.solicitudId,
          celular: mensaje.celular,
          tipo: mensaje.tipo,
          exito: true,
          mock: false,
          detalle: 'Reconstruido por backfill a partir de otro registro — no es la confirmación directa del envío.',
          creado_en: mensaje.creadoEn.toISOString(),
          fuente_id: mensaje.fuenteId
        },
        { onConflict: 'fuente_id', ignoreDuplicates: true }
      )
      .select();

    if (error) throw error;
    return (data || []).length > 0;
  }

  static async getMensajesDeSolicitud(solicitudId: string) {
    const { data, error } = await supabase
      .from('mensajes_whatsapp')
      .select('*')
      .eq('solicitud_id', solicitudId)
      .order('creado_en', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // ── Créditos y rechazos: un CURP = un crédito activo ──────────────────────────────
  //
  // `creditos` es el crédito real (nace cuando se paga el enganche); `rechazos` es el
  // historial de intentos bloqueados por CURP. La garantía de unicidad vive en la base
  // (índice único parcial `creditos_curp_activo`, ver la migración) — estos métodos son
  // la única forma en que el resto del backend toca esas tablas.

  /**
   * Consultado antes de dejar avanzar el 2do OTP (POST /:id/confirmar-terminos) para
   * decidir si hay que bloquear la solicitud. Normalizado igual que la comparación
   * contra RENAPO (trim + mayúsculas) porque el CURP se guarda tal cual lo tipeó el
   * cliente, sin validar el formato real.
   */
  static async getCreditoActivoPorCurp(curp: string) {
    const { data, error } = await supabase
      .from('creditos')
      .select('*')
      .eq('curp', curp.trim().toUpperCase())
      .eq('estado', 'activo')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Alta del crédito: una fila por enganche pagado. `upsert` + `ignoreDuplicates` sobre
   * `solicitud_id` (igual que registrarPago) para que un reintento del webhook de Stripe
   * no falle — nunca lanza: si esto falla, el pago ya se confirmó y no tiene sentido
   * revertirlo por un problema de contabilidad del crédito. Si la carrera es contra el
   * índice único de CURP activo (dos solicitudes del mismo CURP pagando a la vez), cae
   * en el mismo catch y queda logueado para revisar a mano — no debería pasar nunca
   * porque el bloqueo del 2do OTP ya lo previene salvo una carrera real.
   */
  static async crearCredito(credito: {
    solicitudId: string;
    curp: string;
    montoSemanal: number;
    semanas: number;
    // Solo usado por el backfill, que reconstruye créditos ya terminados/cancelados —
    // el webhook en tiempo real siempre crea en 'activo' (default de la columna).
    estado?: 'activo' | 'liquidado' | 'cancelado';
    liquidadoAt?: Date;
    canceladoAt?: Date;
  }): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('creditos')
        .upsert(
          {
            solicitud_id: credito.solicitudId,
            curp: credito.curp.trim().toUpperCase(),
            monto_semanal: credito.montoSemanal,
            semanas: credito.semanas,
            ...(credito.estado ? { estado: credito.estado } : {}),
            ...(credito.liquidadoAt ? { liquidado_at: credito.liquidadoAt.toISOString() } : {}),
            ...(credito.canceladoAt ? { cancelado_at: credito.canceladoAt.toISOString() } : {})
          },
          { onConflict: 'solicitud_id', ignoreDuplicates: true }
        )
        .select();

      if (error) throw error;
      return (data || []).length > 0;
    } catch (error: any) {
      console.error(`[Créditos] No se pudo crear el crédito de la solicitud ${credito.solicitudId}:`, error.message);
      return false;
    }
  }

  /**
   * Libera el CURP: pasa el crédito a liquidado cuando se completan todas las semanas.
   * El filtro `estado = 'activo'` lo hace idempotente ante reintentos del webhook — si
   * ya está liquidado, no vuelve a pisar `liquidado_at`.
   */
  static async liquidarCredito(solicitudId: string) {
    const { error } = await supabase
      .from('creditos')
      .update({ estado: 'liquidado', liquidado_at: new Date().toISOString() })
      .eq('solicitud_id', solicitudId)
      .eq('estado', 'activo');

    if (error) throw error;
  }

  /** Contraparte de liquidarCredito para el botón "Cancelar solicitud" del admin. */
  static async cancelarCredito(solicitudId: string) {
    const { error } = await supabase
      .from('creditos')
      .update({ estado: 'cancelado', cancelado_at: new Date().toISOString() })
      .eq('solicitud_id', solicitudId)
      .eq('estado', 'activo');

    if (error) throw error;
  }

  /** Un intento bloqueado por CURP-ya-con-crédito-activo, para la vista de Rechazos. */
  static async registrarRechazo(rechazo: {
    solicitudId: string;
    curp: string;
    motivo: string;
    detalle?: string;
    creditoId?: string;
  }) {
    const { error } = await supabase
      .from('rechazos')
      .insert({
        solicitud_id: rechazo.solicitudId,
        curp: rechazo.curp.trim().toUpperCase(),
        motivo: rechazo.motivo,
        detalle: rechazo.detalle ?? null,
        credito_id: rechazo.creditoId ?? null
      });

    if (error) throw error;
  }

  /**
   * Todo el historial de rechazos, más nuevo primero. El join con la solicitud RECHAZADA
   * (para mostrar cliente/celular) lo arma el frontend contra la lista de solicitudes que
   * ya tiene cargada, igual que hace lib/cartera.ts con los pagos — pero el crédito que
   * CAUSÓ el bloqueo no está en ninguna lista que el frontend ya tenga, así que acá se
   * embebe su `solicitud_id` vía el FK `credito_id → creditos.id` (Supabase lo infiere
   * solo del esquema), para poder linkear directo a su estado de cuenta.
   */
  static async getRechazos() {
    const { data, error } = await supabase
      .from('rechazos')
      .select('*, credito:creditos(solicitud_id)')
      .order('creado_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Las solicitudes que el tablero de cartera necesita, sin las columnas de KYC ni las
   * URLs firmadas — solo los datos del crédito. Se traen también las canceladas y
   * rechazadas: la analítica de originación las cuenta.
   */
  static async getSolicitudesParaCartera() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select(
        'id, cliente, curp, celular, email, modelo, enganche, semanas, pago_semanal, costo_envio, ' +
        'estatus, created_at, pago_confirmado, pago_confirmado_at, semanas_pagadas, ' +
        'proximo_cobro_semanal, cobro_semanal_fallido, metodo_pago_enganche, imei, ' +
        'stripe_subscription_id, stripe_clabe_referencia'
      )
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /** Todos los pagos de una solicitud, del más viejo al más nuevo. */
  static async getPagosDeSolicitud(solicitudId: string) {
    const { data, error } = await supabase
      .from('pagos')
      .select('*')
      .eq('solicitud_id', solicitudId)
      .order('fecha', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Todos los pagos de toda la cartera, de un tirón — el tablero necesita cruzarlos
   * contra las solicitudes en memoria, y traerlos uno por uno sería N+1.
   */
  static async getTodosLosPagos() {
    const { data, error } = await supabase
      .from('pagos')
      .select('*')
      .order('fecha', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  // Guarda el tracking/guía real generados por Skydropx, sin tocar el estatus — el
  // estatus lo mueve el admin a mano (o el webhook de pago), no la generación de la guía.
  static async guardarEnvio(id: string, datos: { tracking_number?: string; label_url?: string | null; skydropx_carrier?: string; skydropx_shipment_id?: string }) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update(datos)
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  }

  // Solicitudes ya marcadas "Enviado" con guía de Skydropx generada — candidatas para
  // que el cron de verificación de entregas (entregasService.ts) consulte su estado.
  // Se exige `skydropx_shipment_id` (no el carrier) porque la consulta real va por id de
  // envío: ver el comentario en SkydropxService.consultarEstadoEntrega.
  static async getSolicitudesEnviadasConTracking() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .eq('estatus', 'Enviado')
      .not('skydropx_shipment_id', 'is', null);

    if (error) throw error;
    return data;
  }

  // Pasa la solicitud a "Entregado" una vez que Skydropx confirma la entrega. No pisa
  // nada más (dirección, guía, etc.) — solo el estatus, igual que el resto de las
  // transiciones de estatus manuales del admin.
  static async marcarEntregado(id: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ estatus: 'Entregado' })
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

  // Corrige el número al que le llegan las alertas de una solicitud (typo al cargar el
  // formulario, cliente cambió de número, etc.) — se usa desde el detalle de la
  // solicitud en /sadmin. No reabre el OTP ni revalida nada: es solo el destino de los
  // WhatsApp futuros (cobro, verificación, entrega...), el número con el que el cliente
  // verificó su identidad en su momento no cambia retroactivamente.
  static async guardarCelular(id: string, celular: string) {
    const { data, error } = await supabase
      .from('solicitudes')
      .update({ celular })
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
          precio_descuento: datos.precio_descuento != null ? Number(datos.precio_descuento) : null,
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
        precio_descuento: datos.precio_descuento != null ? Number(datos.precio_descuento) : null,
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

  // Parámetros de negocio (enganche/tasa/IVA/cargo semanal) que hasta ahora estaban
  // hardcodeados en catalogo-view.tsx — fila única ('default'), igual que el mockup de
  // referencia. Si la fila no existe todavía (antes de correr la migración con su
  // INSERT inicial), se devuelven los mismos valores que estaban hardcodeados, para que
  // nada se rompa mientras tanto.
  static async getConfiguracion() {
    const { data, error } = await supabase
      .from('configuracion')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();

    if (error) throw error;
    return data || {
      id: 'default',
      enganche_pct: 0.15,
      tasa_anual_pct: 2.28,
      iva_pct: 0.16,
      cargo_semanal_nombre: 'Servicio de Seguridad y Bloqueo',
      cargo_semanal_monto: 17
    };
  }

  static async actualizarConfiguracion(datos: {
    enganche_pct: number;
    tasa_anual_pct: number;
    iva_pct: number;
    cargo_semanal_nombre: string;
    cargo_semanal_monto: number;
  }) {
    const { data, error } = await supabase
      .from('configuracion')
      .upsert({ id: 'default', ...datos, updated_at: new Date().toISOString() })
      .select();

    if (error) throw error;
    return data[0];
  }

  // Registro de cotizaciones armadas desde el Cotizador interno de /sadmin — solo
  // referencia/historial para el equipo, no crea ninguna solicitud ni crédito real.
  static async guardarCotizacionInterna(datos: {
    marca: string;
    modelo: string;
    almacenamiento_color?: string;
    precio_contado: number;
    plazo_semanas: number;
    enganche: number;
    pago_semanal: number;
  }) {
    const { data, error } = await supabase
      .from('cotizaciones_internas')
      .insert(datos)
      .select();

    if (error) throw error;
    return data[0];
  }

  static async getCotizacionesInternas() {
    const { data, error } = await supabase
      .from('cotizaciones_internas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    return data;
  }

  static async eliminarCotizacionInterna(id: string) {
    const { error } = await supabase
      .from('cotizaciones_internas')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
}
