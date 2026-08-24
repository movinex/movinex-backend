-- 2026-08-24 · Tablas `creditos` y `rechazos`: un CURP = un crédito activo.
--
-- Hoy nada impide que la misma persona saque varios créditos a la vez: el CURP se guarda
-- en `solicitudes.curp` como texto suelto, sin índice, sin unicidad y sin que nadie lo
-- consulte para decidir. Tampoco existe registro de a quién rechazamos ni por qué, así
-- que un mismo CURP puede intentar una y otra vez sin dejar rastro.
--
-- `solicitudes` sigue siendo el embudo completo (leads abandonados, rechazos,
-- cancelaciones); `creditos` es el crédito de verdad, que nace recién cuando alguien paga
-- su enganche. No duplica la matemática de pagos (de eso sigue encargándose `pagos` +
-- lib/cartera.ts): solo registra el ciclo de vida grueso que decide si el CURP está libre.

create table if not exists creditos (
  id             uuid primary key default gen_random_uuid(),
  solicitud_id   uuid not null unique references solicitudes(id) on delete cascade,
  curp           text not null,

  estado         text not null default 'activo'
                 check (estado in ('activo', 'liquidado', 'cancelado')),

  -- Snapshot al originar: lo que se cotizó en ese momento, no cambia si luego se edita
  -- la configuración de precios.
  monto_semanal  numeric not null,
  semanas        integer not null,

  abierto_at     timestamptz not null default now(),
  liquidado_at   timestamptz,
  cancelado_at   timestamptz
);

-- LA garantía de la regla va en la base, no solo en el código: aunque el chequeo de
-- aplicación fallara por una carrera, esto rechaza el segundo crédito activo. Un índice
-- único PARCIAL sobre una sola columna (estado) sí es válido en Postgres; la misma regla
-- sobre `solicitudes` no se puede indexar, porque "activo" ahí depende de comparar
-- semanas_pagadas < semanas (dos columnas).
create unique index if not exists creditos_curp_activo
  on creditos (curp) where estado = 'activo';

create index if not exists creditos_curp on creditos (curp);

-- Historial de intentos bloqueados. Tabla propia y no una columna en `solicitudes` porque
-- interesa por CURP (todos los intentos de la misma persona a lo largo del tiempo), no
-- por solicitud individual.
create table if not exists rechazos (
  id            uuid primary key default gen_random_uuid(),
  solicitud_id  uuid references solicitudes(id) on delete set null,
  curp          text not null,

  -- 'curp_con_credito_activo' por ahora; el motivo es texto libre para poder sumar otras
  -- causas de rechazo a futuro sin migrar de nuevo.
  motivo        text not null,
  detalle       text,
  credito_id    uuid references creditos(id) on delete set null,

  creado_at     timestamptz not null default now()
);

create index if not exists rechazos_curp on rechazos (curp);
create index if not exists rechazos_creado on rechazos (creado_at);

-- RLS prendido y SIN políticas = nadie entra, salvo la service_role key, que la saltea por
-- diseño. El backend usa esa key (src/supabase.ts) y el frontend no tiene cliente de
-- Supabase propio, así que esto no rompe nada y deja las tablas cerradas por default.
alter table creditos enable row level security;
alter table rechazos enable row level security;
