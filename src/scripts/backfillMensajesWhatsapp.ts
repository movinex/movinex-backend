/**
 * Backfill parcial del historial de mensajes de WhatsApp hacia `mensajes_whatsapp`.
 *
 * Hasta el 2026-08-25 Movinex no guardaba ningún registro de los WhatsApp que mandaba
 * (ni Meta lo guarda — la Cloud API es solo-envío, sin historial vía API). Esto NO
 * reconstruye todo lo que se mandó, solo lo que se puede inferir con confianza de otras
 * tablas que sí existían antes:
 *
 *   · "Cobro tarjeta fallida" ← tabla `pagos` (estado='fallido', metodo='card'): cada fila
 *     es un invoice.payment_failed que el webhook ya procesaba mandando este mensaje.
 *   · "Pago confirmado"       ← `solicitudes.pago_confirmado_at` (existe desde el
 *     2026-08-18): el webhook manda este mensaje en el mismo momento que confirma el pago.
 *
 * Todo lo demás (recordatorios de cobro semanal SPEI/OXXO, acompañamiento del onboarding,
 * pedido enviado/entregado) no tiene ninguna marca de tiempo por evento guardada en
 * ningún lado — queda sin reconstruir, solo se registra desde hoy en adelante.
 *
 * Las filas que deja este script quedan marcadas (`detalle`): son inferidas, no la
 * confirmación directa de que Meta aceptó el mensaje.
 *
 *   npx ts-node src/scripts/backfillMensajesWhatsapp.ts              → SIMULACIÓN
 *   npx ts-node src/scripts/backfillMensajesWhatsapp.ts --aplicar    → escribe en Supabase
 *
 * Idempotente: `mensajes_whatsapp.fuente_id` es UNIQUE (parcial, solo si no es null) —
 * correrlo dos veces no duplica. Necesita la migración de `fuente_id` (ver CLAUDE.md,
 * sección "Migración pendiente 2026-08-25", bloque 2026-08-26) antes de correr con --aplicar.
 */
import dotenv from 'dotenv';
import { supabase } from '../supabase';
import { PersistenceService } from '../persistenceService';

dotenv.config();

const APLICAR = process.argv.includes('--aplicar');

interface MensajeDetectado {
  solicitudId: string;
  celular: string;
  cliente: string;
  tipo: string;
  fecha: Date;
  fuenteId: string;
}

async function detectarPagosConfirmados(): Promise<{ detectados: MensajeDetectado[]; problemas: string[] }> {
  const detectados: MensajeDetectado[] = [];
  const problemas: string[] = [];

  const { data, error } = await supabase
    .from('solicitudes')
    .select('id, cliente, celular, pago_confirmado_at')
    .not('pago_confirmado_at', 'is', null);

  if (error) throw error;

  for (const s of data || []) {
    if (!s.celular) {
      problemas.push(`${s.cliente} (${s.id}): pago_confirmado_at pero sin celular — se salta.`);
      continue;
    }
    detectados.push({
      solicitudId: s.id,
      celular: s.celular,
      cliente: s.cliente,
      tipo: 'Pago confirmado',
      fecha: new Date(s.pago_confirmado_at),
      fuenteId: `pago_confirmado_${s.id}`
    });
  }

  return { detectados, problemas };
}

async function detectarCobrosTarjetaFallidos(): Promise<{ detectados: MensajeDetectado[]; problemas: string[] }> {
  const detectados: MensajeDetectado[] = [];
  const problemas: string[] = [];

  // Embedding vía la FK pagos.solicitud_id → solicitudes.id, que Supabase resuelve solo.
  const { data, error } = await supabase
    .from('pagos')
    .select('solicitud_id, fecha, stripe_id, solicitudes(id, cliente, celular)')
    .eq('estado', 'fallido')
    .eq('metodo', 'card');

  if (error) throw error;

  for (const p of (data || []) as any[]) {
    const solicitud = p.solicitudes;
    if (!solicitud?.celular) {
      problemas.push(`Pago fallido ${p.stripe_id} (solicitud ${p.solicitud_id}): sin celular — se salta.`);
      continue;
    }
    detectados.push({
      solicitudId: p.solicitud_id,
      celular: solicitud.celular,
      cliente: solicitud.cliente,
      tipo: 'Cobro tarjeta fallida',
      fecha: new Date(p.fecha),
      fuenteId: p.stripe_id
    });
  }

  return { detectados, problemas };
}

const dia = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\n  Backfill de mensajes de WhatsApp — ${APLICAR ? 'MODO REAL (escribe en Supabase)' : 'SIMULACIÓN (no escribe nada)'}\n`);

  const [pagosConfirmados, tarjetasFallidas] = await Promise.all([
    detectarPagosConfirmados(),
    detectarCobrosTarjetaFallidos()
  ]);

  const detectados = [...pagosConfirmados.detectados, ...tarjetasFallidas.detectados];
  const problemas = [...pagosConfirmados.problemas, ...tarjetasFallidas.problemas];

  console.log(`  ${pagosConfirmados.detectados.length} "Pago confirmado" detectados (desde pago_confirmado_at).`);
  console.log(`  ${tarjetasFallidas.detectados.length} "Cobro tarjeta fallida" detectados (desde pagos.estado='fallido').`);

  if (detectados.length) {
    const ordenados = [...detectados].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
    console.log(`\n  Rango de fechas: ${dia(ordenados[0].fecha)} → ${dia(ordenados[ordenados.length - 1].fecha)}\n`);
  }

  if (problemas.length) {
    console.log(`  ⚠ ${problemas.length} cosas para mirar:`);
    problemas.forEach((p) => console.log(`    · ${p}`));
    console.log('');
  }

  if (!APLICAR) {
    console.log(`  Simulación: no se escribió nada. Para aplicarlo:`);
    console.log(`    npx ts-node src/scripts/backfillMensajesWhatsapp.ts --aplicar\n`);
    return;
  }

  console.log(`  Escribiendo...`);
  let insertados = 0;
  let repetidos = 0;

  for (const m of detectados) {
    const ok = await PersistenceService.registrarMensajeWhatsappBackfill({
      solicitudId: m.solicitudId,
      celular: m.celular,
      tipo: m.tipo,
      creadoEn: m.fecha,
      fuenteId: m.fuenteId
    });
    if (ok) insertados++;
    else repetidos++;
  }

  console.log(`\n  ✓ ${insertados} filas nuevas, ${repetidos} ya estaban.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n  ✗ El backfill se cortó:', e.message, '\n');
    process.exit(1);
  });
