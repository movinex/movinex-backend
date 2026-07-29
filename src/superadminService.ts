import bcrypt from 'bcryptjs';
import { supabase } from './supabase';
import { generarTokenAdmin } from './adminAuth';

export class SuperadminService {
  static async login(usuario: string, clave: string): Promise<{ success: boolean; admin?: any; token?: string; message: string }> {
    try {
      console.log(`[SuperadminService] Intentando login para: ${usuario}`);

      const { data, error } = await supabase
        .from('superadmins')
        .select('*')
        .eq('usuario', usuario.trim().toLowerCase())
        .single();

      if (error || !data) {
        console.warn(`[SuperadminService] Usuario no encontrado: ${usuario}`);
        return { success: false, message: 'Usuario o contraseña incorrectos.' };
      }

      const esValido = await bcrypt.compare(clave, data.password_hash);

      if (!esValido) {
        console.warn(`[SuperadminService] Contraseña incorrecta para: ${usuario}`);
        return { success: false, message: 'Usuario o contraseña incorrectos.' };
      }

      console.log(`[SuperadminService] Acceso concedido a: ${data.nombre}`);
      const token = generarTokenAdmin({ adminId: data.id, usuario: data.usuario });
      return {
        success: true,
        admin: {
          id: data.id,
          usuario: data.usuario,
          nombre: data.nombre
        },
        token,
        message: 'Acceso autorizado exitosamente.'
      };

    } catch (err: any) {
      console.error('[SuperadminService] Error durante el proceso de login:', err.message);
      return { success: false, message: 'Ocurrió un error al procesar el inicio de sesión.' };
    }
  }
}
