-- 2026-08-27 · `celulares.imagenes`: hasta 3 fotos por celular, en orden fijo.
--
-- Hasta ahora cada celular tenía una sola `imagen` (la que usa el header del
-- cotizador, el banner "Último Celular" y el quick-view). El catálogo nuevo
-- (Tienda, rediseño Figma) usa un mini-carrusel de 3 fotos por tarjeta, con
-- la foto de FRENTE siempre en el punto del medio (índice 1) y las laterales
-- a los costados (índices 0 y 2). Ese orden lo arma el sadmin al subir las
-- fotos — acá solo se guarda el array tal cual.
--
-- `imagen` (columna vieja, singular) se deja intacta y se sigue usando donde
-- antes: no todo lo que consume `celulares` necesita el set de 3 fotos.

alter table celulares add column if not exists imagenes jsonb not null default '[]'::jsonb;
