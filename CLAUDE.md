# Movinex Backend

API Node.js + Express + TypeScript desplegada en Railway. Repo hermano: `../movinex-frontend`. Contexto de negocio completo en `../PROPUESTA_TECNICA.md`.

## Servicios (`src/`)

- `index.ts` — entrypoint, todas las rutas Express, rate limiting, helmet, swagger.
- `persistenceService.ts` — CRUD contra Supabase (`solicitudes`, `celulares`), única capa que escribe en la base.
- `verificamexService.ts` — KYC (validación de teléfono + OCR/biometría INE/selfie), vía dos llamadas: `leerDatosINE` (`/ocr/obverse`) + `validarIdentidadBiometrica` (`/validations/compare_face`, booleano `isMatch` sin score). **Actualmente mockeado**: `validarTelefono` nunca llama a la API real, y ambas llamadas reales solo se disparan si el email contiene la palabra "real" (gancho de testing); si no, aprueban localmente. Hubo una versión que combinaba OCR + biometría en una sola llamada a `/validations/basic` (daba un score numérico configurable) — se revirtió porque ese endpoint devuelve **500 Server Error consistente** (confirmado con imágenes reales, payload validado 1:1 contra la doc de Verificamex — es un bug de su lado, no nuestro). Reportado a su soporte; mientras tanto quedamos con el booleano ciego de `compare_face`.
- `conektaService.ts` — `crearCheckoutEnganche` genera el link de pago viejo (PaymentLink, sin usar desde el frontend). El cobro real es `crearOrdenEnganche`: crea una Orden con `checkout: { type: "HostedPayment", allowed_payment_methods: ["card"], success_url, failure_url }` y devuelve `checkoutUrl` (`https://pay.conekta.com/link/{checkoutId sin guiones}`) — el frontend hace un `window.location.href` a esa URL, el cliente paga en la página hosteada por Conekta y vuelve solo a `success_url`. Se probaron antes dos alternativas que no funcionaron en esta cuenta: el tokenizador clásico `Conekta.js` + `Token.create()` (rechazado: "the merchant does not accept payments with your payment method") y el **Checkout Component** embebido (`type: "Integration"`, iframe en la propia página) — este último cargaba pero siempre terminaba en "Ha ocurrido un error inesperado", incluso en HTTPS real en producción y en una página de prueba sin React, así que se descartó HTTPS como causa y quedó reportado a soporte de Conekta como posible tema de la cuenta. `crearSuscripcionSemanal` (Plan + Subscription, `trial_period_days: 7`) crea el Plan y suscribe al `customerId` recibido — necesita que ese customer ya tenga una tarjeta guardada como `default_payment_source`, lo cual requiere "Early Access" de Conekta a Tarjetas Guardadas (agosto 2026: seguimos sin ese acceso).
- `skydropxService.ts` — `crearEnvio` sigue el flujo real de 3 llamadas (`/quotations` → elegir la tarifa más barata → `/labels`) y devuelve `{ trackingNumber, labelUrl }`. Si la llamada real falla, cae a un tracking simulado (`simulado: true`) en vez de propagar el error. Falta validar el shape exacto de `/quotations` y `/shipments` contra su sandbox real.
- `whatsappOtpService.ts` — OTP de 6 dígitos por WhatsApp (Meta Cloud API) antes de pagar el enganche. Guarda el código en la tabla `otp_codigos` de Supabase (expira a los 5 min, máx. 5 intentos). **Mockeado por default** (`WHATSAPP_OTP_MOCK=true` o si faltan `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`): loguea el código por consola en vez de mandarlo — Meta requiere una plantilla de tipo "Authentication" aprobada antes de poder mandar mensajes reales.
- `security.ts` — HMAC/RSA para webhooks de Conekta + firma JWT para comandos MDM.
- `superadminService.ts` — login de superadmin contra tabla `superadmins` (bcrypt).

## Rutas principales

- `GET /api/celulares`, `POST/PUT/DELETE /api/celulares/:id` — catálogo.
- `GET/POST /api/solicitudes` — solicitudes de crédito (KYC + datos cliente).
- `POST /api/otp/enviar`, `POST /api/otp/verificar` — OTP de WhatsApp previo al pago del enganche.
- `POST /api/solicitudes/:id/crear-orden-enganche` — crea la Orden en Conekta (Hosted Payment) con `success_url`/`failure_url` armadas a partir del header `Origin` de la request (`?pago_exitoso=1&solicitud={id}&modelo={modelo}` / `?pago_fallido=1`) y devuelve `checkoutUrl` para redirigir al cliente. No cobra nada por sí sola. Reemplaza al viejo `/confirmar-pago-simulado` y al `/pagar-enganche` basado en tokenId (ninguno de los dos existe más).
- `POST /api/solicitudes/:id/domicilio` — guarda el domicilio, genera la guía real en Skydropx y pasa el estatus a `Preparando paquete`.
- `POST /api/admin/login` — login panel admin.
- `POST /api/webhooks/conekta` — fuente de verdad del pago: al recibir `order.paid`, marca `pago_confirmado = true` y pasa `estatus` a `Pendiente de envío` por contacto (`marcarPagoConfirmadoByContacto`), en una sola actualización. El regreso del navegador a `success_url` (frontend) es solo para la UX (retomar el flujo en el paso de Domicilio); el estado real de la solicitud lo confirma este webhook. **(ago 2026)** En el mismo handler, si el evento trae `customer_info.customer_id` (Conekta arma un Customer aun en HostedPayment cuando la orden incluye `customer_info`), se llama automáticamente a `ConektaService.crearSuscripcionSemanal` con el `pago_semanal`/`semanas` de la solicitud y se guarda `conekta_customer_id`/`conekta_subscription_id` (`PersistenceService.guardarSuscripcionConekta`). Si Conekta todavía no da Early Access a Tarjetas Guardadas, esa llamada falla (sin default payment source) y queda logueada — el pago del enganche se confirma igual, no se revierte nada. En cuanto haya Early Access, esto empieza a armar la suscripción sola, sin tocar código de nuevo. El simulador de `/playground` ahora acepta un `customer_id` opcional para poder probar esta rama.
- `POST /api/webhooks/verificacion-cliente`, `POST /api/mdm/command`.
- `GET /playground` — UI standalone para simular el webhook `order.paid` sin firma (solo para pruebas).

## Seguridad del webhook de Conekta (fix jul 2026)

`verifyConektaSignature` (`security.ts`) es fail-closed: sin header `x-conekta-signature`, o si la verificación RSA tira excepción, rechaza (`false`). Antes de este fix, la ausencia de firma pasaba como válida y cualquiera podía simular `order.paid` para marcar una solicitud como "Aprobado" y disparar un envío real en Skydropx sin pagar.

**Nota (ago 2026, sin resolver):** el `.env` local trae `CONEKTA_SKIP_SIGNATURE=true` y el comentario de arriba (y el de `.env`) dice que es el bypass para probar `/playground` sin firma real — pero ese bypass **no existe en el código actual** (`verifyConektaSignature` no lee esa env var en ningún lado). O sea que hoy `/playground` no funciona de verdad contra el backend local: cualquier POST a `/api/webhooks/conekta` sin una firma RSA real de Conekta devuelve 401, incluso en local. Falta decidir: reimplementar el bypass (acotado a cuando `NODE_ENV !== 'production'`, para no repetir el hueco de seguridad que motivó el fix) o borrar la variable y actualizar `/playground` para que avise que necesita una firma real.

## Ciclo de vida de `estatus`

`estatus` es texto libre en Supabase (no enum de DB), pero el código solo usa: `Pendiente` → `Aprobado`/`Rechazado` (decisión de KYC al crear la solicitud, o manual desde el admin vía `PATCH /api/solicitudes/:id`) → `Pendiente de envío` (automático, al confirmarse el pago vía webhook `order.paid`) → `Preparando paquete` (automático, al generar la guía real en `/domicilio`). `updateEstatusByContacto` es el método genérico para las transiciones automáticas (acepta `nuevoEstatus` como string libre + `extraData.tracking_number`/`label_url`); `updateEstatus` sigue acotado a `Aprobado`/`Rechazado` para el botón manual del admin.

## Variables de entorno (`.env`, gitignored)

Backend: `PORT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VERIFICAMEX_API_KEY`, `CONEKTA_API_KEY`, `CONEKTA_PUBLIC_KEY` (RSA para firma de webhooks, **no** confundir con la publishable key de Conekta.js), `SKYDROPX_API_KEY`, `SKYDROPX_API_SECRET` (sin usar en código todavía — Skydropx usa bearer simple, no OAuth2), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OTP_TEMPLATE_NAME`, `WHATSAPP_OTP_MOCK` (opcional), `MDM_JWT_SECRET` (sin fallback en código — si falta, el server no arranca).

Frontend (`movinex-frontend/.env`): `VITE_BACKEND_URL`, `VITE_CONEKTA_PUBLIC_KEY` (publishable key de Conekta para tokenizar tarjetas con Conekta.js — **distinta** de `CONEKTA_API_KEY`/`CONEKTA_PUBLIC_KEY` del backend; sacarla del dashboard de Conekta).

## Pendientes conocidos (reunión jul 2026)

- Conectar Verificamex de verdad y usar su respuesta para simplificar el formulario de solicitud a solo WhatsApp + email + INE + selfie.
- Agregar paso 2/3 post-pago con datos de envío estructurados (calle, no. ext, no. int opcional, CP, colonia, alcaldía/municipio, estado) y mapearlos a lo que `SkydropxService.crearEnvio` realmente necesita. *(Hecho — `/domicilio` ya manda el desglose completo.)*
- Revisar CORS (actualmente `origin: '*'` en `index.ts`). *(Sigue pendiente.)*

## Pendientes reunión 30 jul — implementado en código, falta configuración externa

Las 5 tareas de la reunión del 30 jul (Conekta suscripciones, Skydropx real, alerta admin, OTP WhatsApp, Vercel) ya están implementadas en código. Lo que falta es configuración/credenciales fuera del repo antes de que funcionen en producción real:

- **Supabase**: correr manualmente en el SQL editor (no hay CLI/migraciones en el repo):
  ```sql
  alter table solicitudes add column if not exists label_url text;
  alter table solicitudes add column if not exists conekta_customer_id text;
  alter table solicitudes add column if not exists conekta_subscription_id text;

  create table if not exists otp_codigos (
    id uuid primary key default gen_random_uuid(),
    celular text not null,
    codigo text not null,
    intentos int not null default 0,
    expira_en timestamptz not null,
    creado_en timestamptz not null default now()
  );
  create index if not exists idx_otp_celular on otp_codigos(celular);
  ```
- **Conekta**: `VITE_CONEKTA_PUBLIC_KEY` ya está cargada en Vercel y funcionando con Hosted Payment. **(ago 2026)** El webhook `order.paid` ya llama automáticamente a `crearSuscripcionSemanal` en cuanto el evento trae `customer_info.customer_id` — queda solo pedirle a Conekta Early Access a "Tarjetas Guardadas" para que ese customer tenga una tarjeta por default; sin eso, la llamada falla (queda logueado) pero el enganche se cobra y confirma igual. No hace falta tocar código de nuevo cuando llegue el acceso. Si en algún momento quieren volver al Checkout Component embebido (mejor UX, el cliente no sale del sitio), hay que preguntarle primero a soporte de Conekta por qué el Checkout Component/`Integration` falla en esta cuenta con "Ha ocurrido un error inesperado" — se descartaron nuestro código, extensiones del navegador y HTTPS como causa.
- **Verificamex**: reportarle a su soporte el 500 consistente de `/validations/basic` (payload validado contra su propia doc, no es un bug nuestro) — si lo arreglan, se puede volver a migrar para tener el score numérico configurable.
- **Skydropx**: confirmar que `SKYDROPX_API_KEY` sirve para su sandbox (si no, pedirla a `hola@skydropx.com`) y probar `crearEnvio` de punta a punta — el shape exacto de `/quotations` y `/shipments` puede no coincidir 100% con lo implementado hasta no probarlo contra la API real.
- **Meta / WhatsApp**: dar de alta un WhatsApp Sender verificado y una plantilla de tipo "Authentication" (`WHATSAPP_OTP_TEMPLATE_NAME`) — mientras no esté aprobada, el OTP queda en modo mock (`WHATSAPP_OTP_MOCK=true`, el código se ve en los logs del servidor).
- **Vercel** (ago 2026, actualizado): el backend se queda en Railway (decisión tomada). El sitio (`movinex.mx` y `www.movinex.mx`) ya sirve 100% desde Vercel — se agregó como dominio del proyecto `movinex-frontend` con A/CNAME apuntados desde el panel de Wix. El correo (`@movinex.mx`) ya estaba en Google Workspace desde antes, independiente de Wix — no hay "correo que migrar a Vercel", Vercel no aloja buzones. CORS de `index.ts` ya se apretó a `https://www.movinex.mx` / `https://movinex.mx` / `http://localhost:10173` (ya no `origin: '*'`). Lo único que falta es transferir el **registro** del dominio de Wix a Vercel (Vercel sí soporta `.mx` como registrador): bloqueado por la regla de 60 días de ICANN hasta el 2 ago 2026 (justo hoy), reintentar el flujo "Transferir fuera de Wix" desde el panel de dominios de Wix. Guía completa con los registros MX/SPF de Google a respaldar antes del corte en `../NOTAS_MIGRACION_VERCEL.md`. Los fallbacks hardcodeados a `https://movinex-backend-production.up.railway.app` en `Documentos.tsx`, `Domicilio.tsx`, `App.tsx`, `Landing.tsx`, `Sadmin.tsx` y `swaggerOptions` de `index.ts` siguen sin tocar — no hace falta mientras el backend siga en Railway.
