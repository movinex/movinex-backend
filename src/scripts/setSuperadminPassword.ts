import bcrypt from 'bcryptjs';
import { supabase } from '../supabase';

async function main() {
  const id = process.argv[2];
  const nuevaClave = process.argv[3];

  if (!id || !nuevaClave) {
    console.error('Uso: ts-node src/scripts/setSuperadminPassword.ts <id> <nueva_clave>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(nuevaClave, 10);

  const { data, error } = await supabase
    .from('superadmins')
    .update({ password_hash: hash })
    .eq('id', id)
    .select('id, usuario, nombre');

  if (error) {
    console.error('Error actualizando contraseña:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error('No se encontró ningún superadmin con ese id.');
    process.exit(1);
  }

  console.log('Contraseña actualizada para:', data[0]);
}

main();
