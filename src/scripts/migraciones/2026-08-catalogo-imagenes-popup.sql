-- 2026-08-28 · `celulares.imagenes_popup`: 3 fotos SIN fondo para el pop-up de
-- Detalles, separadas de `celulares.imagenes` (que ya trae el degradado pegado
-- y alimenta el mini-carrusel de la tarjeta de la Tienda).
--
-- El pop-up de Detalles no usa la misma composición que la tarjeta: muestra el
-- celular solo (transparente, alta resolución) sobre un degradado propio
-- (`celulares.gradiente_inicio`/`gradiente_fin`, ver esa migración), porque la
-- proporción del panel del pop-up es distinta a la de la tarjeta y una imagen
-- con el fondo ya pegado se recorta o se ve rara ahí. Mismo orden que
-- `imagenes`: [lateral, combo/frente, lateral] — la combo va al medio.

alter table celulares add column if not exists imagenes_popup jsonb not null default '[]'::jsonb;

-- El degradado de fondo del pop-up (y de la tarjeta, antes de que la foto ya
-- lo trajera pegado) también estaba hardcodeado en el frontend
-- (`CATALOGO_FONDOS`, un mapa fijo por id). Se mueve a la base para que el
-- sadmin lo pueda editar junto con las fotos. Dos colores hex, sin el ángulo
-- (el ángulo del degradado queda fijo en el CSS — no vale la pena exponerlo).
alter table celulares add column if not exists gradiente_inicio text;
alter table celulares add column if not exists gradiente_fin text;
