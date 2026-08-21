/**
 * Backfill del historial de pagos desde Stripe hacia la tabla `pagos`.
 *
 * Hasta el 2026-08-20 Movinex no guardaba fechas de cobro: solo el contador
 * `semanas_pagadas`. El historial real vivía únicamente en Stripe. Este script lo trae
 * una vez; de ahí en más lo mantiene el webhook (ver index.ts, /api/webhooks/stripe).
 *
 *   npx ts-node src/scripts/backfillPagos.ts              → SIMULACIÓN (no escribe nada)
 *   npx ts-node src/scripts/backfillPagos.ts --aplicar    → escribe en Supabase
 *
 * Es idempotente: `pagos.stripe_id` es UNIQUE, así que correrlo dos veces no duplica.
 * Se puede correr con el backend prendido sin pisarse con el webhook.
 *
 * 🔴 Escribe en la MISMA base que usa producción (Railway y local comparten Supabase).
 *    Correr siempre primero sin --aplicar y revisar el resumen.
 *
 * De dónde sale cada cobro:
 *   · enganche  → columnas locales (pago_confirmado_at, enganche, costo_envio)
 *   · tarjeta   → invoices de la Subscription semanal
 *   · SPEI      → idem (Subscription "send_invoice")
 *   · OXXO      → NO tiene invoices: cada semana es un Checkout Session suelto
 *   · reintentos de tarjeta → también Sessions, no invoices
 */
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { supabase } from '../supabase';
import { PersistenceService } from '../persistenceService';

dotenv.config();

const APLICAR = process.argv.includes('--aplicar');

interface PagoDetectado {
  solicitudId: string;
  tipo: 'enganche' | 'semanal';
  monto: number;
  fecha: Date;
  metodo: string | null;
  stripeId: string;
  fuente: string;
}

function clienteStripe(usarProduccion: boolean): Stripe | null {
  const apiKey = usarProduccion ? process.env.STRIPE_SECRET_KEY : process.env.STRIPE_SECRET_KEY_TEST;
  if (!apiKey) {
    console.warn(`  ⚠ Falta ${usarProduccion ? 'STRIPE_SECRET_KEY' : 'STRIPE_SECRET_KEY_TEST'} — se saltan las solicitudes de esa cuenta.`);
    return null;
  }
  return new Stripe(apiKey);
}

const money = (v: number) => '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dia = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  console.log(`\n  Backfill de pagos — ${APLICAR ? 'MODO REAL (escribe en Supabase)' : 'SIMULACIÓN (no escribe nada)'}\n`);

  // Se lee directo de Supabase y no con PersistenceService.getSolicitudes(): ese firma
  // una URL de KYC por fila, que acá no sirve para nada y tarda muchísimo.
  const { data: solicitudes, error } = await supabase
    .from('solicitudes')
    .select('id, cliente, email, enganche, costo_envio, semanas, semanas_pagadas, pago_confirmado, pago_confirmado_at, metodo_pago_enganche, stripe_customer_id, stripe_payment_intent_id')
    .eq('pago_confirmado', true)
    .order('created_at', { ascending: true });

  if (error) throw error;
  if (!solicitudes?.length) {
    console.log('  No hay solicitudes con el enganche pagado. Nada que hacer.\n');
    return;
  }

  console.log(`  ${solicitudes.length} solicitudes con enganche pagado.\n`);

  // Una sola instancia por cuenta, no una por solicitud.
  const clientes = { live: clienteStripe(true), test: clienteStripe(false) };

  const detectados: PagoDetectado[] = [];
  const problemas: string[] = [];

  for (const s of solicitudes) {
    const esProduccion = s.email?.trim().toLowerCase() !== 'desarrollo@movinex.mx';
    const stripe = esProduccion ? clientes.live : clientes.test;
    const delaSolicitud: PagoDetectado[] = [];

    let engancheDesdeStripe = false;

    if (stripe && s.stripe_customer_id) {
      try {
        // ---- Semanales de tarjeta y SPEI: Subscriptions reales, una invoice por semana ----
        const invoices = await stripe.invoices
          .list({ customer: s.stripe_customer_id, limit: 100 })
          .autoPagingToArray({ limit: 500 });

        for (const inv of invoices) {
          // Mismo filtro que el webhook (index.ts): la invoice de $0 del trial de 7 días
          // no es una semana pagada, solo avisa que arrancó el período de prueba.
          if (Number(inv.amount_paid) === 0) continue;
          const pagadaEn = (inv as any).status_transitions?.paid_at;
          if (!pagadaEn) continue;
          delaSolicitud.push({
            solicitudId: s.id,
            tipo: 'semanal',
            monto: Number(inv.amount_paid) / 100,
            fecha: new Date(pagadaEn * 1000),
            metodo: inv.collection_method === 'send_invoice' ? 'customer_balance' : 'card',
            stripeId: inv.id!,
            fuente: 'invoice'
          });
        }

        // ---- Sessions: acá viven DOS cosas ----
        // 1. El enganche (una sola, sin metadata.tipo='cobro_semanal').
        // 2. Las semanas de OXXO y los links de reintento de tarjeta, que no generan
        //    invoice: cada uno es una Session suelta.
        const sesiones = await stripe.checkout.sessions
          .list({ customer: s.stripe_customer_id, limit: 100 })
          .autoPagingToArray({ limit: 500 });

        for (const ses of sesiones) {
          if (ses.payment_status !== 'paid') continue;

          if (ses.metadata?.tipo === 'cobro_semanal') {
            delaSolicitud.push({
              solicitudId: s.id,
              tipo: 'semanal',
              monto: Number(ses.amount_total || 0) / 100,
              // Las Sessions no exponen la fecha de acreditación; `created` es lo más
              // cercano. Para OXXO puede adelantarse unos días respecto de la caja.
              fecha: new Date(ses.created * 1000),
              metodo: 'oxxo',
              stripeId: ses.id,
              fuente: 'session'
            });
            continue;
          }

          // Enganche. Las solicitudes anteriores al deploy del 2026-08-18 no tienen
          // `pago_confirmado_at` ni `stripe_payment_intent_id` (las dos columnas se
          // agregaron ahí), así que Stripe es la ÚNICA fuente de su fecha de cobro.
          // Se prefiere el payment_intent como stripe_id para que coincida con lo que
          // escribe el webhook y no se dupliquen las filas.
          delaSolicitud.push({
            solicitudId: s.id,
            tipo: 'enganche',
            monto: Number(ses.amount_total || 0) / 100,
            fecha: new Date(ses.created * 1000),
            metodo: s.metodo_pago_enganche || null,
            stripeId: (ses.payment_intent as string) || ses.id,
            fuente: 'session'
          });
          engancheDesdeStripe = true;
        }
      } catch (e: any) {
        problemas.push(`${s.cliente}: falló la consulta a Stripe (${e.message})`);
      }
    } else if (!s.stripe_customer_id) {
      problemas.push(`${s.cliente}: no tiene stripe_customer_id — no se puede recuperar nada de Stripe.`);
    }

    // ---- Enganche por columnas locales, solo si Stripe no lo trajo ----
    if (!engancheDesdeStripe) {
      if (s.pago_confirmado_at) {
        delaSolicitud.push({
          solicitudId: s.id,
          tipo: 'enganche',
          monto: Number(s.enganche || 0) + Number(s.costo_envio || 0),
          fecha: new Date(s.pago_confirmado_at),
          metodo: s.metodo_pago_enganche || null,
          stripeId: s.stripe_payment_intent_id || `enganche_${s.id}`,
          fuente: 'local'
        });
      } else {
        problemas.push(`${s.cliente}: enganche pagado pero no se encontró ni la Session en Stripe ni pago_confirmado_at — queda sin registrar.`);
      }
    }

    // Numerar las semanas por orden cronológico real.
    const semanales = delaSolicitud
      .filter((p) => p.tipo === 'semanal')
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    // Contraste contra el contador: si no coinciden, el backfill se perdió algo.
    const contador = Number(s.semanas_pagadas || 0);
    if (semanales.length !== contador) {
      problemas.push(
        `${s.cliente}: semanas_pagadas=${contador} pero se encontraron ${semanales.length} cobros en Stripe (diferencia de ${contador - semanales.length}).`
      );
    }

    detectados.push(...delaSolicitud);
    console.log(
      `  ${s.cliente?.padEnd(34).slice(0, 34)} ${String(semanales.length).padStart(3)} semanales  ` +
      `${(s.metodo_pago_enganche || '—').padEnd(17)} ${semanales.length ? dia(semanales[0].fecha) + ' → ' + dia(semanales[semanales.length - 1].fecha) : ''}`
    );

    // Se guarda el número de semana en el propio objeto para el insert de abajo.
    semanales.forEach((p, i) => ((p as any).numeroSemana = i + 1));
  }

  // ---- Resumen ----
  const enganches = detectados.filter((p) => p.tipo === 'enganche');
  const semanales = detectados.filter((p) => p.tipo === 'semanal');
  const total = detectados.reduce((s, p) => s + p.monto, 0);

  console.log(`\n  ────────────────────────────────────────────────────`);
  console.log(`  ${detectados.length} pagos detectados: ${enganches.length} enganches + ${semanales.length} semanales`);
  console.log(`  Suma cobrada: ${money(total)}`);
  console.log(`    · enganches ${money(enganches.reduce((s, p) => s + p.monto, 0))}`);
  console.log(`    · semanales ${money(semanales.reduce((s, p) => s + p.monto, 0))}`);

  if (problemas.length) {
    console.log(`\n  ⚠ ${problemas.length} cosas para mirar:`);
    problemas.forEach((p) => console.log(`    · ${p}`));
  }

  if (!APLICAR) {
    console.log(`\n  Simulación: no se escribió nada. Para aplicarlo:`);
    console.log(`    npx ts-node src/scripts/backfillPagos.ts --aplicar\n`);
    return;
  }

  // ---- Escritura ----
  console.log(`\n  Escribiendo...`);
  let insertados = 0;
  let repetidos = 0;

  for (const p of detectados) {
    const ok = await PersistenceService.registrarPago({
      solicitudId: p.solicitudId,
      tipo: p.tipo,
      numeroSemana: (p as any).numeroSemana ?? null,
      monto: p.monto,
      fecha: p.fecha,
      metodo: p.metodo,
      stripeId: p.stripeId,
      origen: 'backfill'
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
