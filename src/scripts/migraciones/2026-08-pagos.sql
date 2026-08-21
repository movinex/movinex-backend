-- 2026-08-20 · Tabla `pagos`: historial real de cobros.
--
-- Hasta ahora el único rastro de un cobro semanal era el contador `semanas_pagadas`
-- (+1 por webhook) y `ultima_invoice_pagada`, que se pisa cada semana. Eso alcanza para
-- saber CUÁNTAS semanas van pagadas, pero no CUÁNDO entró cada peso — y sin fechas no se
-- puede calcular antigüedad de saldos, días de mora, cobrado real por mes ni un estado de
-- cuenta. El historial existía solo en Stripe.
--
-- `stripe_id` es UNIQUE a propósito: es la clave de idempotencia. El webhook y el script
-- de backfill pueden correr en cualquier orden, y repetidos, sin duplicar filas.
--
-- Se llena por dos caminos:
--   · webhook  → cada cobro nuevo, en tiempo real (index.ts, /api/webhooks/stripe)
--   · backfill → una vez, leyendo el histórico de Stripe (src/scripts/backfillPagos.ts)

create table if not exists pagos (
  id             uuid primary key default gen_random_uuid(),
  solicitud_id   uuid not null references solicitudes(id) on delete cascade,

  -- 'enganche' (pago inicial) | 'semanal' (cuota del plan)
  tipo           text not null check (tipo in ('enganche', 'semanal')),
  -- número de cuota, 1..semanas. Null en el enganche.
  numero_semana  integer,

  monto          numeric not null,
  -- Fecha de CAJA (cuándo entró la plata), no la de vencimiento de la cuota.
  -- Para OXXO/SPEI puede ser días después de que se generó el cobro.
  fecha          timestamptz not null,

  -- card | oxxo | customer_balance (SPEI)
  metodo         text,
  estado         text not null default 'pagado'
                 check (estado in ('pagado', 'fallido', 'reembolsado')),

  -- invoice.id | checkout_session.id | payment_intent.id, según el camino de cobro.
  stripe_id      text not null unique,
  -- 'webhook' | 'backfill' — para poder auditar de dónde salió cada fila.
  origen         text not null default 'webhook',

  creado_at      timestamptz not null default now()
);

-- El acceso siempre es "los pagos de esta solicitud, en orden": es la consulta que hacen
-- el estado de cuenta y el motor de cartera.
create index if not exists pagos_solicitud_fecha on pagos (solicitud_id, fecha);

-- Para los agregados por mes (calendario de flujo, brecha de cobranza).
create index if not exists pagos_fecha on pagos (fecha);

-- RLS prendido y SIN políticas = nadie entra, salvo la service_role key, que la saltea
-- por diseño. El backend usa esa key (src/supabase.ts) y el frontend no tiene cliente de
-- Supabase propio, así que esto no rompe nada y deja la tabla cerrada por default en vez
-- de depender de que la anon key nunca se filtre. Son datos de cobros de clientes.
alter table pagos enable row level security;
