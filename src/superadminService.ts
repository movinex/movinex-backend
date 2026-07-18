import bcrypt from 'bcryptjs';
import { supabase } from './supabase';

/**
 * Servicio encargado de gestionar los procesos de autenticación y validación
 * del portal oculto de Super Administradores.
 */
export class SuperadminService {
  /**
   * Autentica un usuario administrativo en base a las credenciales y el hash bcrypt en Supabase.
   * @param usuario Correo o nombre del administrador
   * @param clave Contraseña en texto plano
   * @returns Un objeto con el estatus del login y datos del perfil si es exitoso
   */
  static async login(usuario: string, clave: string): Promise<{ success: boolean; admin?: any; message: string }> {
    try {
      console.log(`[SuperadminService] Intentando login para: ${usuario}`);

      // Buscar el usuario en la tabla 'superadmins'
      const { data, error } = await supabase
        .from('superadmins')
        .select('*')
        .eq('usuario', usuario.trim().toLowerCase())
        .single();

      if (error || !data) {
        console.warn(`[SuperadminService] Usuario no encontrado: ${usuario}`);
        return { success: false, message: 'Usuario o contraseña incorrectos.' };
      }

      // Comparar el hash de la contraseña usando bcryptjs
      const esValido = await bcrypt.compare(clave, data.password_hash);

      if (!esValido) {
        console.warn(`[SuperadminService] Contraseña incorrecta para: ${usuario}`);
        return { success: false, message: 'Usuario o contraseña incorrectos.' };
      }

      console.log(`[SuperadminService] Acceso concedido a: ${data.nombre}`);
      return {
        success: true,
        admin: {
          id: data.id,
          usuario: data.usuario,
          nombre: data.nombre
        },
        message: 'Acceso autorizado exitosamente.'
      };

    } catch (err: any) {
      console.error('[SuperadminService] Error durante el proceso de login:', err.message);
      return { success: false, message: 'Ocurrió un error al procesar el inicio de sesión.' };
    }
  }
}
