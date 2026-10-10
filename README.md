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
- Distribución multicanal: conecta varios orígenes a un destino, o crea varias conexiones independientes; reenvío nativo o copia sin cabecera; gestión por administrador, pausa/reanudación, prevención de rutas duplicadas y de bucles, soporte de álbumes, estadísticas y alertas de errores.\n- Registro de estadísticas, compras, historial y alertas operativas.
- Backup y restauración de configuración desde el panel.
- Panel administrativo `/admin`, con gestión de administradores visible y modificable únicamente por el propietario definido en `OWNER_ID` (o por el primer ID de `ADMIN_IDS` si no se configura).
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
- `OWNER_ID` (recomendado): ID numérico de Telegram del único propietario del bot. Solo esta cuenta puede ver la lista de administradores y añadir o quitar administradores desde el panel.\n- `ADMIN_IDS`: IDs numéricos de las cuentas autorizadas a usar el panel, separados por comas. Para compatibilidad, si `OWNER_ID` no está definido, el primer ID de `ADMIN_IDS` se considera el propietario. Los administradores adicionales agregados desde el panel no pueden ver ni modificar la lista de administradores.
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
- `/publish`: crear publicación gratuita o con precio en Stars.\n- `/distribution`: administrar conexiones de distribución (también desde `/admin` → `DISTRIBUCIÓN`).
- `/paysupport`: información de soporte de pagos.
- `/refund <telegram_payment_charge_id>`: reembolsar una compra registrada como administrador.
- `/retrydelivery <telegram_payment_charge_id>`: reintentar la entrega de una compra cuyo pago ya se confirmó.
- Restaurar un backup: abre `/admin`, entra en `BACKUP / RESTAURAR` y sigue las instrucciones.
- `/cancel`: cancelar la operación actual.

## Datos y persistencia

La configuración se guarda en `data/channels.json`, ignorado por Git. Este archivo se crea en ejecución. Si FadeHost permite montar un volumen persistente, configura `DATA_DIR` con la ruta de ese volumen. El hosting debe ofrecer almacenamiento persistente o el bot perderá configuración, publicaciones y registros al reiniciarse o reconstruirse. Haz respaldos periódicos.

## Distribución multicanal\n\n1. Registra los canales de origen y destino en `/admin` y comprueba que seas administrador de Telegram en ambos.\n2. El bot debe ser administrador en el origen para recibir publicaciones nuevas y en el destino con permiso para publicar mensajes.\n3. Abre `/admin` → `🔀 DISTRIBUCIÓN` → `➕ CREAR CONEXIÓN`, selecciona origen, destino y modo.\n4. Elige `REENVÍO NATIVO` para mantener la referencia al origen, o `COPIAR PUBLICACIÓN` para copiar sin cabecera cuando Telegram lo permita.\n5. La función procesa publicaciones nuevas; no importa automáticamente el historial antiguo. Los álbumes se envían agrupados cuando la API de Telegram lo permite. Los destinos de conexiones activas no se vuelven a procesar como orígenes, para evitar bucles.\n\n## Limitaciones importantes

- La protección contra duplicados de publicaciones automáticas es en memoria; se reinicia al reiniciar el proceso.
- Las estadísticas actuales cuentan acciones procesadas por el bot, no son analítica completa de Telegram.
- Las facturas Stars y la entrega privada deben probarse en el entorno de pruebas de Telegram antes de vender contenido real.
- `npm run validate` ejecuta comprobación de sintaxis y pruebas automatizadas de almacenamiento, alertas y plantillas.
- El editor automático no puede garantizar que todo contenido se edite: Telegram puede rechazar mensajes sin permisos, con entidades inválidas o que no admitan edición.
- Los botones `callback` personalizados muestran una respuesta genérica si no tienen una acción programada; los botones URL sí abren su destino.
- El bot no incluye un módulo de modelos ni WebApp.
