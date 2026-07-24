import { supabase } from './supabase';

export class PersistenceService {
  
  static async saveSolicitud(datos: any) {
    const { data, error } = await supabase
      .from('solicitudes')
      .insert([
        {
          cliente: datos.cliente,
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

  static async updateEstatus(id: string, nuevoEstatus: 'Aprobado' | 'Rechazado') {
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

    const { data, error } = await supabase
      .from('solicitudes')
      .update(updateFields)
      .or(`email.eq.${contacto},celular.ilike.%${telefonoSinPrefijo}`)
      .select();

    if (error) throw error;
    return data;
  }

  static async getSolicitudes() {
    const { data, error } = await supabase
      .from('solicitudes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
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
    const { data, error } = await supabase
      .from('celulares')
      .insert([
        {
          id: datos.id,
          modelo: datos.modelo,
          marca: datos.marca,
          precio_base: Number(datos.precio_base),
          enganche: Number(datos.enganche),
          monto_semanal_26: Number(datos.monto_semanal_26),
          monto_semanal_52: Number(datos.monto_semanal_52),
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
    const { data, error } = await supabase
      .from('celulares')
      .update({
        modelo: datos.modelo,
        marca: datos.marca,
        precio_base: Number(datos.precio_base),
        enganche: Number(datos.enganche),
        monto_semanal_26: Number(datos.monto_semanal_26),
        monto_semanal_52: Number(datos.monto_semanal_52),
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
