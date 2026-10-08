# Canales-bot

Bot de Telegram para administrar varios canales, normalizar publicaciones y vender contenido digital con Telegram Stars.

## Funciones actuales

- Registro de canales mediante selector de Telegram y detección de cambios de membresía del bot.
- Configuración independiente por canal: plantillas, hashtags, botones, formatos y activación.
- Procesamiento de publicaciones nuevas, con detección de texto, enlaces, fotos, videos, reenviados y álbumes.
- Protección contra re-procesamiento duplicado durante la ejecución actual.
- Creación manual de publicaciones gratuitas desde `/publish`.
- Facturas de Telegram Stars (`XTR`), validación de pre-checkout, registro de pagos y entrega privada del contenido.
- Registro de estadísticas, compras e historial.
- Panel administrativo `/admin`.
- Reembolsos Stars mediante `/refund <telegram_payment_charge_id>`.

## Requisitos

- Node.js 20 o posterior.
- Un bot creado con @BotFather.
- El bot debe ser administrador en cada canal.
- Para editar posts ya publicados, Telegram limita la edición según el tipo de mensaje, la antigüedad y los permisos del bot.
- Para las publicaciones pagadas por factura, el comprador debe haber iniciado el bot en privado para que se le pueda entregar contenido por DM. Si no lo ha iniciado, el pago puede completarse pero el envío privado fallará; revisa el flujo de entrega antes de usarlo para ventas reales.

## Variables de entorno

Configura en el hosting:

- `BOT_TOKEN`: token del bot.
- `ADMIN_IDS`: IDs numéricos de administradores separados por comas.

No subas el archivo `.env` ni tokens a GitHub.

## Instalación

```sh
npm install
npm run check
npm start
```

En FadeHost configura el comando de inicio como `npm start` y Node.js 20+.

## Comandos

- `/start`: información básica.
- `/admin`: panel administrativo.
- `/addchannel -100...`: registrar un canal por ID como alternativa.
- `/publish`: crear publicación gratuita o con precio en Stars.
- `/paysupport`: información de soporte de pagos.
- `/refund <telegram_payment_charge_id>`: reembolsar una compra registrada como administrador.
- `/cancel`: cancelar la operación actual.

## Datos y persistencia

La configuración se guarda en `data/channels.json`, ignorado por Git. Este archivo se crea en ejecución. El hosting debe ofrecer almacenamiento persistente o el bot perderá configuración, publicaciones y registros al reiniciarse o reconstruirse. Haz respaldos periódicos.

## Limitaciones importantes

- La protección contra duplicados de publicaciones automáticas es en memoria; se reinicia al reiniciar el proceso.
- Las estadísticas actuales cuentan acciones procesadas por el bot, no son analítica completa de Telegram.
- Las facturas Stars y la entrega privada deben probarse en el entorno de pruebas de Telegram antes de vender contenido real.
- El editor automático no puede garantizar que todo contenido se edite: Telegram puede rechazar mensajes sin permisos, con entidades inválidas o que no admitan edición.
- El bot no incluye un módulo de modelos ni WebApp.
