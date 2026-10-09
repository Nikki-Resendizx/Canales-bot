# Canales-bot

Bot de Telegram para administrar varios canales, normalizar publicaciones y vender contenido digital con Telegram Stars.

## Funciones actuales

- Registro de canales mediante selector de Telegram y detección de cambios de membresía del bot.
- Visibilidad por administrador: cada administrador solo ve y configura los canales donde su propia cuenta de Telegram tiene rol de administrador o propietario; los botones también validan ese permiso.
- Configuración independiente por canal: plantillas, hashtags, botones, formatos y activación.
- Procesamiento de publicaciones nuevas, con detección de texto, enlaces, fotos, videos, reenviados y álbumes.
- Protección contra re-procesamiento duplicado durante la ejecución actual.
- Creación manual de publicaciones gratuitas desde `/publish`.
- Publicaciones premium con enlace de compra privado, facturas Telegram Stars (`XTR`), validación de pre-checkout, registro de pagos, entrega privada y reintento de entrega.
- Registro de estadísticas, compras, historial y alertas operativas.
- Backup y restauración de configuración desde el panel.
- Panel administrativo `/admin`.
- Reembolsos Stars mediante `/refund <telegram_payment_charge_id>`.

## Requisitos

- Node.js 20 o posterior.
- Un bot creado con @BotFather.
- El bot debe ser administrador en cada canal.
- Para editar posts ya publicados, Telegram limita la edición según el tipo de mensaje, la antigüedad y los permisos del bot.
- Las publicaciones premium muestran un enlace de compra que abre primero el chat privado del bot. La factura se envía en ese chat, de modo que el usuario haya iniciado el bot antes de la entrega. Si falla una entrega, el administrador puede reintentarlo con el charge ID.

## Variables de entorno

Configura en el hosting:

- `BOT_TOKEN`: token del bot.
- `ADMIN_IDS`: IDs numéricos de administradores principales separados por comas. Desde el panel, los principales pueden añadir o quitar administradores adicionales.
- `DATA_DIR` (opcional): ruta absoluta de una carpeta persistente del hosting. Si no se configura, se utiliza `data/` dentro del proyecto.

No subas el archivo `.env` ni tokens a GitHub.

## Instalación

```sh
npm install
npm run validate
npm start
```

En FadeHost configura el comando de inicio como `npm start` y Node.js 20+.

## Comandos

- `/start`: iniciar el bot y abrir compras premium desde enlaces de canal.
- `/help`: mostrar la lista de comandos.
- `/admin`: panel administrativo.
- `/addchannel -100...`: registrar un canal por ID como alternativa.
- `/publish`: crear publicación gratuita o con precio en Stars.
- `/paysupport`: información de soporte de pagos.
- `/refund <telegram_payment_charge_id>`: reembolsar una compra registrada como administrador.
- `/retrydelivery <telegram_payment_charge_id>`: reintentar la entrega de una compra cuyo pago ya se confirmó.
- Restaurar un backup: abre `/admin`, entra en `BACKUP / RESTAURAR` y sigue las instrucciones.
- `/cancel`: cancelar la operación actual.

## Datos y persistencia

La configuración se guarda en `data/channels.json`, ignorado por Git. Este archivo se crea en ejecución. Si FadeHost permite montar un volumen persistente, configura `DATA_DIR` con la ruta de ese volumen. El hosting debe ofrecer almacenamiento persistente o el bot perderá configuración, publicaciones y registros al reiniciarse o reconstruirse. Haz respaldos periódicos.

## Limitaciones importantes

- La protección contra duplicados de publicaciones automáticas es en memoria; se reinicia al reiniciar el proceso.
- Las estadísticas actuales cuentan acciones procesadas por el bot, no son analítica completa de Telegram.
- Las facturas Stars y la entrega privada deben probarse en el entorno de pruebas de Telegram antes de vender contenido real.
- `npm run validate` ejecuta comprobación de sintaxis y pruebas automatizadas de almacenamiento, alertas y plantillas.
- El editor automático no puede garantizar que todo contenido se edite: Telegram puede rechazar mensajes sin permisos, con entidades inválidas o que no admitan edición.
- Los botones `callback` personalizados muestran una respuesta genérica si no tienen una acción programada; los botones URL sí abren su destino.
- El bot no incluye un módulo de modelos ni WebApp.
