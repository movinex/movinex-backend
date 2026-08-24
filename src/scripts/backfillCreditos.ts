/**
 * Backfill de la tabla `creditos` a partir de las solicitudes ya pagadas.
 *
 * Sin esto, "un CURP = un crédito activo" solo bloquearía a los clientes que paguen el
 * enganche DE ACÁ EN MÁS — los que ya están pagando (o ya liquidaron, o cancelaron) no
 * tendrían fila en `creditos` y no bloquearían nada.
 *
 *   npx ts-node src/scripts/backfillCreditos.ts              → SIMULACIÓN (no escribe nada)
 *   npx ts-node src/scripts/backfillCreditos.ts --aplicar    → escribe en Supabase
 *
 * Es idempotente: `creditos.solicitud_id` es UNIQUE (ver crearCredito, usa upsert +
 * ignoreDuplicates), así que correrlo dos veces no duplica.
 *
 * 🔴 Escribe en la MISMA base que usa producción (Railway y local comparten Supabase).
 *    Correr siempre primero sin --aplicar y revisar el resumen — en especial las
 *    solicitudes de prueba de Eduardo (tel 5527319167) y `acc2b733`, que quedaron sin
 *    borrar y van a generar créditos si tienen el enganche pagado.
 *
 * El estado se deriva, no se pregunta:
 *   · estatus = 'Cancelada'                    → cancelado
 *   · semanas_pagadas >= semanas                → liquidado
 *   · si no                                     → activo
 */
import dotenv from 'dotenv';
import { supabase } from '../supabase';
import { PersistenceService } from '../persistenceService';

dotenv.config();

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  console.log(`\n  Backfill de créditos — ${APLICAR ? 'MODO REAL (escribe en Supabase)' : 'SIMULACIÓN (no escribe nada)'}\n`);

  const { data: solicitudes, error } = await supabase
    .from('solicitudes')
    .select('id, cliente, curp, estatus, semanas, semanas_pagadas, pago_semanal, pago_confirmado')
    .eq('pago_confirmado', true)
    .order('created_at', { ascending: true });

  if (error) throw error;
  if (!solicitudes?.length) {
    console.log('  No hay solicitudes con el enganche pagado. Nada que hacer.\n');
    return;
  }

  console.log(`  ${solicitudes.length} solicitudes con enganche pagado.\n`);

  const problemas: string[] = [];
  const porEstado = { activo: 0, liquidado: 0, cancelado: 0 };
  // Detecta de una vez CURPs repetidos entre solicitudes que quedarían "activo" a la
  // vez — el índice único parcial de la base los va a rechazar salvo el primero, pero
  // mejor verlo acá antes de escribir.
  const curpsActivosVistos = new Map<string, string>();

  const filas: Array<{
    solicitudId: string;
    curp: string;
    montoSemanal: number;
    semanas: number;
    estado: 'activo' | 'liquidado' | 'cancelado';
    cliente: string;
  }> = [];

  for (const s of solicitudes) {
    if (!s.curp) {
      problemas.push(`${s.cliente}: enganche pagado pero sin CURP guardado — se salta, no se puede crear el crédito.`);
      continue;
    }

    const estado: 'activo' | 'liquidado' | 'cancelado' =
      s.estatus === 'Cancelada'
        ? 'cancelado'
        : Number(s.semanas_pagadas || 0) >= Number(s.semanas || 0)
          ? 'liquidado'
          : 'activo';

    if (estado === 'activo') {
      const curpNormalizado = String(s.curp).trim().toUpperCase();
      const previa = curpsActivosVistos.get(curpNormalizado);
      if (previa) {
        problemas.push(
          `⚠ CURP repetido entre dos solicitudes "activo": ${s.cliente} y ${previa} — la base va a rechazar la segunda, revisar a mano.`
        );
      } else {
        curpsActivosVistos.set(curpNormalizado, s.cliente);
      }
    }

    porEstado[estado]++;
    filas.push({
      solicitudId: s.id,
      curp: s.curp,
      montoSemanal: Number(s.pago_semanal) || 0,
      semanas: Number(s.semanas) || 0,
      estado,
      cliente: s.cliente
    });

    console.log(`  ${(s.cliente || '').padEnd(34).slice(0, 34)} ${estado.padEnd(10)} ${s.semanas_pagadas ?? 0}/${s.semanas ?? '?'} semanas`);
  }

  console.log(`\n  ────────────────────────────────────────────────────`);
  console.log(`  ${filas.length} créditos a crear: ${porEstado.activo} activos, ${porEstado.liquidado} liquidados, ${porEstado.cancelado} cancelados`);

  if (problemas.length) {
    console.log(`\n  ⚠ ${problemas.length} cosas para mirar:`);
    problemas.forEach((p) => console.log(`    · ${p}`));
  }

  if (!APLICAR) {
    console.log(`\n  Simulación: no se escribió nada. Para aplicarlo:`);
    console.log(`    npx ts-node src/scripts/backfillCreditos.ts --aplicar\n`);
    return;
  }

  console.log(`\n  Escribiendo...`);
  let insertados = 0;
  let repetidos = 0;

  for (const f of filas) {
    // La fecha de liquidación/cancelación real no se reconstruye acá — no vale la pena
    // pegarle a `pagos` por cada fila solo para eso. Queda null; lo que importa para la
    // regla de negocio es el `estado`, no la fecha exacta de créditos ya cerrados.
    const ok = await PersistenceService.crearCredito({
      solicitudId: f.solicitudId,
      curp: f.curp,
      montoSemanal: f.montoSemanal,
      semanas: f.semanas,
      estado: f.estado
    });
    if (ok) insertados++;
    else repetidos++;
  }

  console.log(`\n  ✓ ${insertados} filas nuevas, ${repetidos} ya estaban (o fallaron — revisá los logs de arriba).\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n  ✗ El backfill se cortó:', e.message, '\n');
    process.exit(1);
  });
