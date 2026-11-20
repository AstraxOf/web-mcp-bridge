# LOG

## 2026-11-02 — Claude (asistente de desarrollo)
- Evaluación inicial del fork. Tests: 4 suites JS OK; `test_bridge.py` OK tras instalar `websockets`.
- Hallazgos DeepSeek: sin reparación de JSON (solo existe en `chatgpt.js`), streaming detectado por crecimiento de texto (2 s), botón enviar por heurística, filtro de razonamiento amplio, `getMessageKey` O(n²), sin tests.
- Decisión: trabajar por pasos (ver TASK.md). Primero higiene del repo y documentación base.
- `server/bridge.log` deja de versionarse (contenía rutas locales del autor original); el archivo local se conserva. Se añade `*.log` a `.gitignore`.

## 2026-11-02 — Claude (asistente de desarrollo) · Paso 2
- La reparación de barras invertidas (`fixString`, `repairBackslashes`) pasa de `chatgpt.js` a `utils.js`. `scanCalls` usa `parseLenient`: primero `JSON.parse` normal y, solo si falla, reintenta con las barras reparadas. Se aplica al fragmento JSON de cada llamada, no al texto entero (menos riesgo con comillas en la prosa).
- Decisión: eliminar `findJsonObjects` y el texto «reparado» que `messageText` añadía en ChatGPT; el parser compartido ya cubre esos casos. Beneficia a DeepSeek, Claude y Gemini sin tocar sus adaptadores.
- Tests nuevos en `tests/test_utils.mjs` (ruta Windows, escapes válidos conservados, comillas tipográficas + barras). Verificado que fallan con el parser anterior.
- Límite conocido: si el JSON roto sigue siendo válido (p. ej. `"C:\new"` se lee como salto de línea) no se detecta. El prompt ya pide usar `/` en rutas.

## 2026-11-02 — Claude (asistente de desarrollo) · Paso 3
- Filtro de razonamiento: `.ds-think-content` se mantiene; las clases genéricas pasan de subcadena (`[class*="think"]`) a palabra completa (`think`, `thinking`, `deepthink`, `reasoning`) y solo en 6 ancestros sin llegar a `<body>`. Motivo: una clase global como `thinking-enabled` o `unthinkable` marcaba todas las respuestas como razonamiento; el adaptador anterior caía entonces al modo «sin filtrar» e incluía también el razonamiento.
- Filtrado de contenedores anidados: de O(n²) a lineal (recorrido de ancestros con Set).
- Caché de `getAssistantMessages()` de 150 ms (se invalida si algún elemento sale del DOM): `getMessageKey` e `isStreaming` dejan de recalcular la lista en cada llamada dentro del mismo análisis.
- Decisión: NO cambiar la detección de fin de generación (`GROW_MS`) ni la heurística del botón enviar sin ver el DOM real; queda en TASK.md.
- Nueva prueba `tests/browser/test_deepseek.mjs` (Playwright, DOM simulado): filtrado, línea base, llamada nueva una sola vez, repintado sin duplicar, ruta Windows. Falla con el adaptador anterior, pasa con el nuevo. Fuera de `npm test` porque CI no tiene Chromium.

## 2026-11-02 — Claude (asistente de desarrollo) · Instalación en Windows
- Requisitos de Isabel: Windows, Chrome, actualizaciones desde la rama `main`. Nuevos objetivos: A) instalar en su PC, B) registro de eventos para auditoría, C) actualización automática.
- A: `INSTALL.md` + `scripts/windows/install.ps1`. Reutiliza `server/install_service.py` (arranque automático vía carpeta Inicio) en lugar de duplicarlo.
- Decisión: el script crea `servers.json` solo con `demo`; el `default_config()` del instalador Python incluye `astrax-mcp`, que no está instalado y fallaría al conectar.
- Decisión: el script detiene puentes anteriores (`mcp_ws_bridge.py` vía CIM) antes de arrancar; reejecutar el instalador causaba «puerto en uso» (visto en el bridge.log original). `install_service.py --uninstall` usa `taskkill` por título de ventana, que no encuentra `pythonw`: pendiente de revisar.
- `.ps1` guardado en UTF-8 con BOM y CRLF (`.gitattributes`) para PowerShell 5.1. No se pudo ejecutar aquí (sin PowerShell): requiere prueba en Windows.

## 2026-11-02 — Isabel (usuaria) / Claude · Prueba de instalación
- `scripts/windows/install.ps1` ejecutado en Windows (usuario con espacio en la ruta): todos los pasos OK, puente escuchando en 127.0.0.1:8090.
- Incidencia de uso: al clonar se queda en `main`, que no tiene el script. Se resolverá llevando los cambios a `main`.

## 2026-11-02 — Claude (asistente de desarrollo) · Descubrimiento de MCP y recarga en caliente
- Petición de Isabel: que la extensión lea los MCP del PC y ella elija cuáles activar; su `servers.json` usa el formato `{nombre: {port, command, args}}`, que el puente NO aceptaba (fallaba al arrancar).
- Puente (`mcp_ws_bridge.py`):
  - acepta `{"servers": [...]}`, `{"mcpServers": {...}}` y `{nombre: {...}}`, con `command` como texto o lista más `args`;
  - asigna un puerto automático (desde 8800) si falta y valida nombres y puertos repetidos;
  - recarga `servers.json` en caliente cada 2 s (`BridgeManager.apply`: arranca los nuevos, detiene los quitados y reinicia los cambiados). Con un JSON inválido mantiene la configuración anterior;
  - abre un canal de descubrimiento de solo lectura en `ws://127.0.0.1:8765` (solo con `--config`): envía `{type:"servers", servers:[{name,port,url}]}`. Sigue la misma regla de Origin que los MCP (solo extensiones).
- Extensión: mensaje `DISCOVER_SERVERS`; el popup detecta al abrirse (en silencio) y con el botón «Detectar MCP del PC». Los MCP nuevos se registran DESACTIVADOS (decide Isabel); no se duplican por puerto.
- Decisión: el descubrimiento NO expone los comandos, solo nombre y puerto. Escribir `servers.json` desde el popup queda para más adelante, con clave y confirmación.
- `install.ps1` comprueba ahora el puerto 8765 en vez del 8090 (el demo puede no estar en su configuración).
- Pruebas: `tests/test_bridge_config.py` (formatos, descubrimiento, rechazo de una web, recarga, JSON inválido, quitar un servidor) y una prueba manual automatizada con la extensión real en Chromium: detección → activar → «Conectado».

## 2026-11-02 — Claude (asistente de desarrollo) · Conflicto de puerto del descubrimiento
- En el PC de Isabel el puerto 8765 ya lo usa otro programa: el canal de descubrimiento no arrancaba y la comprobación de `install.ps1` daba un falso «Puente activo», porque solo probaba la conexión TCP y respondía el otro programa.
- Decisión: mover el canal de descubrimiento a 47615 (puerto poco común y fuera del rango efímero de Windows, que empieza en 49152).
- `install.ps1` comprueba ahora la respuesta real del puente (`type: "servers"`) con Python + websockets y lista los MCP configurados. Verificado contra el puente real (OK) y contra otro programa en el puerto (rechazado).
- El log explica que, si el puerto está ocupado, los MCP siguen funcionando pero no se pueden detectar.
- Nota: en PowerShell 5.1, `Get-Content` necesita `-Encoding UTF8` para leer bien `bridge.log`.

## 2026-11-02 — Claude (asistente de desarrollo) · Fallo de install.ps1 en PowerShell 5.1
- Error en el PC de Isabel: `python -c $probe` → SyntaxError. PowerShell 5.1 quita las comillas dobles de los argumentos que pasa a programas nativos, y además `2>$null` con `$ErrorActionPreference = 'Stop'` corta el script ante cualquier salida en stderr.
- Solución: la comprobación pasa a un archivo propio, `scripts/windows/check_bridge.py`, y durante esa llamada se usa `ErrorActionPreference = 'Continue'`. Probado contra el puente real (lista los MCP) y sin puente (código 1).
- Lección: en scripts .ps1 no pasar código con `-c` a programas nativos; usar archivos.

## 2026-11-02 — Claude (asistente de desarrollo) · Punto B: registro de eventos
- Isabel aprueba el plan: 1) pull request a `main`, B) registros, D) interfaz nueva + panel lateral, C) actualización automática.
- `background/logger.js`: entradas `{ts, level, source, event, platform?, details?}`, anillo de 2.000 en `chrome.storage.local` (`wmb_logs`), escrituras agrupadas cada 500 ms. Los detalles se recortan (300 caracteres por texto, profundidad 3).
- Qué se registra:
  - arranque del service worker;
  - conexión, caída y herramientas de cada MCP (sin repetir el mismo error en cada reintento);
  - llamadas a herramientas (servidor, herramienta, argumentos recortados, duración y error);
  - acciones del popup (activar, permisos, ajustes, detectar…);
  - eventos del chat: llamada detectada, aprobación, resultado entregado, fallos y todo lo que muestra el panel flotante.
  No se registran las consultas frecuentes (GET_STATE, SLEEP…) ni el texto de los mensajes del usuario.
- Popup: nueva pestaña «Registro» con filtro por nivel, exportación a JSON (versión + navegador + eventos) y borrado con confirmación. Es provisional: se integrará en la interfaz nueva del punto D.
- Error visto por Isabel (`ws://127.0.0.1:8765 … 404`): la extensión no se había recargado tras el cambio de puerto.
- `install_service.py` en Windows detiene ahora los puentes anteriores con PowerShell `-EncodedCommand` + CIM, tanto al instalar como al desinstalar. Antes, ejecutarlo directamente arrancaba un segundo puente y `--uninstall` no paraba `pythonw`. No probado en Windows.
- Pruebas: `test_background` (eventos, recorte, origen, borrado) y prueba con la extensión real en Chromium (pestaña Registro + exportación).

## 2026-11-02 — Claude (asistente de desarrollo) · Editor de MCP en la extensión
- Petición de Isabel: no abrir `server\servers.json` a mano. Su MCP de AutoCAD es HTTP en `127.0.0.1:8765` (por eso ese puerto estaba ocupado).
- Corrección a la recomendación de DeepSeek: `npx -y mcp-proxy` (npm) convierte de stdio a HTTP, que es al revés de lo que hace falta. El correcto es el `mcp-proxy` de Python con `--transport=streamablehttp URL` (verificado en `sparfenyuk/mcp-proxy`).
- Puente:
  - el canal de control acepta `get_config` y `put_config` solo de la extensión propietaria (`chrome-extension://kpjokcdpjbiljllmdobofmomhifebbbo`); el listado sigue abierto a cualquier extensión;
  - `put_config` valida con la misma `load_config`, deja copia `.bak`, escribe de forma atómica y aplica al momento;
  - si `servers.json` es inválido al arrancar, el puente arranca sin MCP para poder arreglarlo desde el editor.
- Decisión de seguridad: fijar el ID de la extensión con `"key"` en `manifest.json` (la clave privada no se guarda). Así no hay claves que copiar. Coste: Chrome la trata como extensión nueva una vez (se pierden los ajustes guardados; los MCP se vuelven a detectar solos).
- Extensión:
  - nueva página `editor/` con plantillas (carpeta, HTTP vía mcp-proxy, personalizado), validación en vivo, vista previa de comandos (nuevo/modificado), confirmación, Ctrl+S, «Ordenar» y «Cambiar \ por /»;
  - el popup tiene el botón «Añadir o editar MCP…»;
  - en el registro no se guarda el contenido del archivo, solo su tamaño.
- Pruebas: `test_bridge_config` (propietario frente a otra extensión o sin Origin, inválido sin cambios, válido + `.bak` + aplicado) y prueba con la extensión real en Chromium (plantilla HTTP → guardar → archivo y puente actualizados; ayuda de barras).

## 2026-11-02 — Claude (asistente de desarrollo) · `autocad` no llegaba al puente
- Diagnóstico con el registro exportado y `bridge.log` de Isabel: se guardó desde el editor con los MISMOS 2 MCP (demo y autocad-files) y ningún MCP nuevo arrancó. Isabel rellenó la plantilla pero no pulsó «Añadir a la configuración» antes de «Guardar». Es un fallo de diseño (dos pasos), no suyo.
- Cambios:
  - el editor, al guardar con una plantilla rellenada y sin añadir, pregunta si añadirla; tras añadir o guardar vacía la plantilla; el aviso de guardado nombra los MCP;
  - el puente informa del último error de `servers.json` (`config_error` en el canal de control) y el popup lo muestra como aviso;
  - el log del puente nombra los MCP al guardar y deja de escribir «connection open» en cada consulta (logger `websockets` en WARNING).
- Pruebas: Chromium (plantilla sin añadir → pregunta → guardado con `autocad`; JSON roto → aviso en el popup) y `test_bridge_config` (`config_error` se informa y se limpia).

## 2026-11-02 — Claude (asistente de desarrollo) · `autocad` se cae al activarlo
- Registro de Isabel: `autocad` se añadió bien (puerto 8800 automático), pero al activarlo la conexión se cierra al instante («Conexión cerrada.») sin más detalle. El `ERR_CONNECTION_REFUSED` en el 8792 fue pasajero: el puente se reiniciaba y la extensión reconectó a los 8 s.
- Causa probable: el puente no encuentra `mcp-proxy`, porque `pip` lo instala en `C:\Python314\Scripts`, que puede no estar en el PATH, o el proxy termina con error.
- Cambios:
  - el puente busca el ejecutable también en la carpeta `Scripts` del Python que lo ejecuta;
  - si el comando no existe o el MCP termina al arrancar, cierra el WebSocket con el motivo (código de salida + última línea de stderr);
  - `ws_client.js` guarda ese motivo como `lastError`, y el popup muestra el error bajo el MCP (antes solo como tooltip).
- Prueba nueva `tests/test_bridge_errors.py` (comando inexistente y MCP que termina con código 3).

## 2026-11-02 — Claude (asistente de desarrollo) · Causa: `mcp-proxy` instalado con `--user`
- `pip show` de Isabel: `mcp-proxy` está en `C:\Users\…\AppData\Roaming\Python\Python314\site-packages`. `pip` lo instaló en modo usuario, porque `C:\Python314` no admite escritura sin permisos de administrador. Su `.exe` queda en `%APPDATA%\Python\Python314\Scripts`, que no está en el PATH ni en `C:\Python314\Scripts`. Por eso el puente daba `[WinError 2]` y la extensión mostraba «No se encontró o no se pudo ejecutar «mcp-proxy»» (la mejora anterior ya dio el motivo exacto).
- Solución: `_resolve_executable` busca también en la carpeta de scripts de usuario (`sysconfig`, esquema `nt_user`).
- Además: `ws_client.js` ya no registra un segundo «Conexión cerrada.» tras el motivo real (el handshake fallido no pisa el error de `onclose`).

## 2026-11-02 — Isabel (usuaria) / Claude · AutoCAD conectado
- Registro de Isabel: `autocad` (vía `mcp-proxy`, puerto 8800) conectado con 16 herramientas, `autocad-files` con 14. La cadena completa funciona en su PC: puente → mcp-proxy → MCP HTTP de AutoCAD.
- Pendiente: prueba real desde DeepSeek. Con `mcp-proxy` funcionando, el soporte HTTP nativo deja de bloquear; queda como mejora (menos piezas que instalar).

## 2026-11-02 — Claude (asistente de desarrollo) · Interfaz nueva y panel lateral (punto D)
- Guía: Impeccable (`pbakaus/impeccable`), consultada en una carpeta temporal sin añadirla al repositorio. Modo «Operate»: claridad y densidad; iconos SVG propios en lugar de emoji/Unicode; estados completos (vacío que explica, error, deshabilitado, foco); un solo tipo de letra del sistema; color de acento solo para acciones y estados; foco, selección y barras de desplazamiento con los colores de la paleta; movimiento de 150 ms y sin animaciones decorativas.
- Una sola página (`popup/popup.html`) para la ventana emergente y el panel lateral: detecta el contexto con `chrome.extension.getViews({type: 'popup'})`.
- Pestañas:
  - **MCP:** estado del puente local, «Detectar» y «Añadir o editar MCP», resumen de activos y tokens, permiso global, tarjetas con interruptor, estado, error en rojo, permiso y lista desplegable de herramientas;
  - **Actividad:** llamadas y registro;
  - **Ajustes:** «Abrir como panel lateral» y ajustes del chat.
- Panel lateral: permiso `sidePanel`, `side_panel.default_path`, botón en la cabecera del popup y ajuste `preferSidePanel` (`action.setPopup('')` + `setPanelBehavior`). Verificado en Chromium.
- El icono muestra el nº de MCP conectados.
- El registro usa el nombre del MCP además del ID.
- Resultados MCP: `structuredContent` de FastMCP (`{"result": "<mismo texto>"}`) ya no se duplica en el chat (el resultado de `estado` de AutoCAD llegaba dos veces y gastaba el doble de tokens).

## 2026-11-02 — Claude (asistente de desarrollo) · Punto C: actualización automática
- `scripts/windows/update.ps1`:
  - solo actúa en `main` y sin cambios locales; hace `git fetch` + `merge --ff-only` (nunca sobrescribe trabajo local);
  - reinicia el puente si cambió `server/`;
  - escribe `update-stamp.json` (commit, rama, estado; ignorado por git) y anota en `server/update.log` (recortado a 500 líneas).
- `install.ps1` registra la tarea programada `WebMCPBridge-Update` (cada 10 min, `wscript` + `.vbs` para no abrir ventanas) y ejecuta una primera comprobación. Opción `-NoAutoUpdate`.
- Extensión:
  - alarma cada minuto que lee `update-stamp.json` del propio directorio de la extensión (en las descomprimidas se lee del disco, verificado en Chromium);
  - si el commit difiere del de arranque y no hay llamadas en curso, ejecuta `chrome.runtime.reload()`;
  - la versión de arranque se guarda en `storage.session`, para que una versión llegada con el service worker dormido también provoque la recarga.
- Ajustes: interruptor «Recargar la extensión al llegar una versión nueva» y estado (commit, rama, última comprobación).
- Decisión: la extensión NUNCA ejecuta comandos. El `git pull` lo hace la tarea de Windows, y la extensión solo lee un archivo.
- Verificado en Chromium: detección de la versión nueva desde el disco y orden de recarga. NO verificable aquí: la recarga en sí, porque en Chromium automatizado `chrome.runtime.reload()` bloquea incluso una extensión mínima de control (limitación del entorno de pruebas). Tampoco se ha ejecutado PowerShell. Queda para la prueba en Windows.

## 2026-11-02 — Claude (asistente de desarrollo) · Errores «ERR_CONNECTION_REFUSED» y cambio a `main`
- Isabel ve en `chrome://extensions` un error por cada reintento de conexión a `ws://localhost:8800` (`autocad`, que el puente no tenía en marcha). Chrome registra cada WebSocket fallido como error y no se puede silenciar desde el código.
- Solución: los MCP detectados desde el puente quedan marcados (`managed`). La extensión no abre el WebSocket si el puente no responde o no tiene ese puerto configurado; muestra el motivo en la tarjeta y reintenta en silencio.
  - El estado del puente se consulta cada 30 s (alarma) y, cuando vuelve o aparece el MCP, se conecta al instante.
  - Los MCP añadidos a mano por dirección no se frenan nunca.
  - Verificado en Chromium (MCP quitado del puente → sin reintentos y con explicación).
- `git checkout main` falló en el PC de Isabel por dos motivos:
  1. su `main` local es el del clon original (antiguo, todavía con `server/bridge.log`);
  2. tiene cambios locales sin confirmar en 17 archivos (origen desconocido: hay que verlos antes de decidir).
  Recomendación: `git checkout -B main origin/main`, que conserva esos cambios porque el árbol de la rama y el de `origin/main` son idénticos, y después revisar `git status` / `git diff --stat`. La actualización automática no actúa mientras haya cambios locales.

## 2026-11-02 — Claude (asistente de desarrollo) · Carpeta de Isabel con el código ORIGINAL
- `git diff --stat` de Isabel coincide línea por línea con la diferencia entre el commit original del fork (`d768e0a`) y el último (`848b9f2`). Es decir, Git apunta a la versión nueva, pero los archivos de su carpeta son los del proyecto original. No hay trabajo propio de Isabel en esos cambios.
- Consecuencia: Chrome cargaba el código ORIGINAL (manifest sin `key` → otro ID; sin editor, sin registro…). Eso explica que la recarga diera problemas y hubiera que quitar y volver a poner la extensión.
- Causa: desconocida (algo restauró los archivos antiguos después de ejecutar el instalador nuevo: `update-hidden.vbs` y `update-stamp.json` existen).
- Solución propuesta: `git restore .` (es seguro: el contenido antiguo sigue en el historial, `d768e0a`) y después `git checkout -B main origin/main`.
- `.gitignore`: se añade `server/servers.json.bak`.

## 2026-11-02 — Claude (asistente de desarrollo) · Soporte HTTP nativo (sin mcp-proxy)
- `background/http_client.js` (`HttpMcpConnection`): Streamable HTTP con la misma interfaz que el cliente WebSocket.
  - POST JSON-RPC con respuestas JSON o SSE, cabecera `Mcp-Session-Id` y `MCP-Protocol-Version`;
  - 202 para las notificaciones; si el MCP se reinicia (404 de sesión), se reconecta solo;
  - ping cada 25 s, DELETE al cerrar, reintentos de 2 a 60 s.
- Hallazgo, verificado con FastMCP 1.30 en 127.0.0.1: el servidor responde **403** a cualquier petición con `Origin: chrome-extension://…` (protección del SDK contra webs). Solución: regla `declarativeNetRequest` de sesión que quita `Origin` solo en las peticiones de ESTA extensión (`initiatorDomains` = ID propio, sin pestaña) a `127.0.0.1`/`localhost`. Equivale a lo que hace un cliente de escritorio; las webs siguen bloqueadas.
- Permisos nuevos: `declarativeNetRequest`; host `http://127.0.0.1/*` y `http://localhost/*`.
- Puente:
  - acepta `{"nombre": {"url": "http://…"}}`: no lo arranca, lo anuncia en el listado con `transport: "http"`;
  - las entradas URL no ocupan puertos ni chocan con los automáticos.
- Extensión:
  - elige el cliente según la dirección (http/https o ws/wss);
  - la detección registra los MCP HTTP;
  - si un MCP gestionado conserva su nombre y cambia de dirección (autocad: `ws://localhost:8800` con mcp-proxy → `http://…/mcp`), se actualiza la dirección conservando interruptor y permiso;
  - un MCP HTTP no se frena porque el puente esté caído.
- Editor: la plantilla «MCP por HTTP» genera `{"url": …}` (conexión directa). La vista previa indica que no se ejecuta nada en el PC.
- Pruebas:
  - `tests/test_http.mjs`: SSE, sesión, 202, error del servidor, reinicio con 404, puerta cerrada, DELETE;
  - `test_bridge_config`: entradas URL;
  - Chromium con FastMCP real: migración automática de autocad a HTTP, conexión sin 403 y llamada a `zoom`.

## 2026-11-02 — Claude (asistente de desarrollo) · Análisis del registro de Isabel (uso real con AutoCAD)
- Funciona:
  - la actualización automática hizo dos recargas solas (`47f3704 → 12208e9 → abea24b`);
  - la migración de `autocad` a HTTP directo (`server.moved` → conectado con 16 herramientas, sin mcp-proxy);
  - decenas de llamadas `lisp`, `estado` y `capas` correctas.
- Errores observados:
  1. Dos `tools/call` agotaron el límite de 120 s, y un `ERASE` sobre un dibujo de ~147.000 entidades tardó 82 s. Con 120 s, operaciones legítimas fallan y la IA repite órdenes mientras AutoCAD sigue ocupado.
  2. Algunas expresiones LISP de la IA dejan AutoCAD ocupado o esperando (`ssget "_X"` con filtros de punto exactos, `command "_.EXPLODE"` sin cerrar). Es un problema del lado AutoCAD/LISP, no de la extensión.
  3. El registro se llenaba con `action.discover_servers` cada 20 s (panel lateral abierto).
- Cambios:
  - ajuste «Tiempo máximo por herramienta» (por defecto 300 s, de 10 a 1800);
  - el mensaje de tiempo agotado le dice a la IA que AutoCAD puede seguir ocupado y que no repita la orden;
  - la detección solo se registra cuando aparece un MCP nuevo;
  - `bridge.config_saved` muestra la URL de los MCP HTTP en vez de `undefined`.
- Propuesta para el MCP de AutoCAD (repo aparte, pendiente de subir): herramientas específicas con límites (contar o seleccionar por capa/tipo, borrar con confirmación, cancelar comando activo) en vez de depender de LISP libre.

## 2026-11-02 — Claude (asistente de desarrollo) · Freno de seguridad contra bucles
- Petición de Isabel: evitar que la IA colapse AutoCAD con órdenes repetidas o en bucle.
- Extensión (`core_bridge.js`): aunque el MCP esté en «Permitir siempre», se vuelve a pedir confirmación si
  - el MCP falló 3 veces seguidas (se reinicia al primer éxito), o
  - la IA repite exactamente la misma llamada 3 veces seguidas.
  La tarjeta de aprobación muestra «Freno de seguridad» y el motivo. Si el usuario rechaza, el resultado le pide a la IA que no lo reintente y espere instrucciones. Evento de registro `call.brake`.
- Complementa la protección del MCP de AutoCAD (`mis-mcp` PR #4): ocupado, límites, lotes, pausa y continuar, y MCPSEL.
- Prueba: `tests/browser/test_freno.mjs` (Chromium + DeepSeek simulado; 3 fallos se ejecutan solos y la 4.ª llamada queda en espera con el aviso).

## 2026-11-02 — Claude (asistente de desarrollo) · Llamadas ilegibles ya no se ignoran en silencio
- Registro de Isabel: tras `estado` (correcto, 224 ms), DeepSeek «envía comandos» pero no hay ningún `call.detected`. La extensión no detectó la llamada: lo más probable es un bloque `mcp_call` con JSON roto (comillas sin escapar en LISP, llaves sin cerrar), que el parser descartaba sin avisar a nadie.
- Solución:
  - `WMB.diagnoseMcpCall(text)` detecta un intento real de llamada (`{"mcp_call":` y no la simple mención) que no se pudo leer y explica el motivo: bloque sin cerrar, JSON inválido con el mensaje del parser, falta `name` o formato incorrecto;
  - `core_bridge`: en `onDone` (respuesta terminada sin llamadas válidas) avisa en el panel, registra `call.unreadable` (con fragmento) y envía a la IA un `[MCP_RESULT status="error"]` con el motivo y cómo corregirlo. Una sola vez por bloque.
- Pruebas: `test_utils` (6 casos de diagnóstico) y `test_freno.mjs` (Chromium: un JSON roto no ejecuta nada y escribe el aviso en el chat).

## 2026-11-02 — Claude (asistente de desarrollo) · Hipótesis descartada: llamadas idénticas en conversaciones largas
- Hipótesis: en conversaciones largas, DeepSeek descarga los mensajes antiguos y la «huella» de una llamada nueva idéntica a una ya ejecutada coincide (conversación + nº de llamadas iguales en la página), así que se descartaría en silencio. Reproducida en el DOM simulado.
- Probado un rediseño por turnos (envío del usuario o del resultado = turno nuevo). Falla en un caso: si DeepSeek descarga mensajes y a la vez responde de golpe con un texto idéntico, no se distingue de un repintado del mensaje viejo sin conocer cómo marca DeepSeek los mensajes del usuario.
- Decisión: NO publicarlo. El registro real de Isabel mostraba otra causa (`resumen_entidades` bloqueando el MCP, corregido en mis-mcp PR #5) y un cambio especulativo podría volver a ejecutar órdenes dos veces. Pendiente: capturar el HTML real de una conversación larga de DeepSeek antes de tocar la deduplicación.
## 2026-11-02 — Claude (asistente de desarrollo) · Falsa alarma de «llamada ilegible» mientras DeepSeek escribe
- Registro de Isabel (20:25:40): aviso «bloque JSON no cerrado» y, 4 s después, la misma llamada completa detectada y ejecutada. DeepSeek hizo una pausa a mitad del bloque, el observador lo dio por terminado y el aviso se escribió en el chat a destiempo.
- Solución: antes de avisar se espera 8 s y se comprueba que el mensaje no haya cambiado, que no se esté generando y que siga siendo ilegible.
- Prueba (`test_freno.mjs`): bloque a medio escribir que se completa 4 s después → sin aviso y ejecutado; bloque roto de verdad → aviso a los ~8 s.

## 2026-11-09 — Claude (asistente de desarrollo) · Plataformas, herramientas por MCP y capturas en DeepSeek
- Registro de Isabel con el MCP nuevo «AutoCAD MCP Pro» (http://127.0.0.1:8766/mcp, **243 herramientas**). Las 31 llamadas terminaron bien (la mayoría en menos de 1 s; `_X` tardó 32 s esperando selección en AutoCAD). El MCP y la extensión respondieron siempre.
- Causas de los «se queda sin responder»:
  1. 243 herramientas descritas a DeepSeek: decenas de miles de tokens; DeepSeek se satura.
  2. `view_screenshot`: la extensión adjuntaba la captura y DeepSeek (que solo extrae texto de las imágenes) no siempre seguía.
- Riesgo detectado: la extensión estaba activa a la vez en DeepSeek, Gemini y en Claude Code (claude.ai/code, la propia sesión de desarrollo).
- Cambios:
  - **Plataformas** (Ajustes): casillas por IA (`settings.platforms`). En las desactivadas, el panel se oculta y no se inyecta ni se ejecuta nada. Claude Code (`/code`) se excluye siempre (`excludesPath` del adaptador de Claude).
  - **Herramientas por MCP**: casillas, buscador y «Todas/Ninguna» (o «Activar/Desactivar estas» con filtro). `server.disabledTools`: no se describen a la IA, no cuentan en los tokens y `CALL_TOOL` las rechaza. Mutación `SET_TOOLS_ENABLED`.
  - **Capturas en DeepSeek**: `acceptsImages = false` en el adaptador. Las imágenes del resultado se sustituyen por una nota que orienta a la IA a herramientas de datos (evento `result.image_skipped`). El resto de plataformas sigue adjuntándolas.
- Pruebas: `test_background` (herramienta desactivada invisible y rechazada; plataformas completadas en ajustes antiguos), `test_freno.mjs` (captura en DeepSeek → nota de texto) y revisión visual en Chromium.

## 2026-11-13 — Claude (asistente de desarrollo) · repo-github sale del puente
- `server/repo_mcp.py`, `server/repos.example.json` y `tests/test_repo_mcp.py` se trasladan al repositorio privado de MCP propios (`repo-github/`), donde están los otros MCP de Isabel. Motivo: este repo es un fork público y el puente no debe mezclar MCP concretos con su código.
- El puente y la extensión no cambian: siguen tratando de forma genérica cualquier MCP con `sync_check`/`sync_apply`. INSTALL.md lo explica.
- Antes se une `fix/archivos-grandes` a `main` (14 commits, avance rápido), para que la actualización automática vuelva a seguir la versión que se usa.
- Pruebas: `npm test` OK; `test_bridge*.py` y `test_mcp_ctl.py` OK (con `websockets` instalado).

## 2026-11-14 — Claude (asistente de desarrollo) · «Messages too frequent» en DeepSeek
- DeepSeek rechaza mensajes muy seguidos: acepta nuestro mensaje pero deja debajo «Messages too frequent. Try again later.» y no responde (dato de Isabel). Pasaba en cadenas de herramientas rápidas.
- Antes de cada envío automático: pausa mínima desde el último (5 s + hasta un 50 % al azar) y tope de envíos por minuto (8). Ambos en el popup.
- Después: si aparece un aviso NUEVO de «demasiados mensajes», se espera ~20/40/80 s (±30 %) y se reenvía; tras 3 intentos se avisa al usuario. Se cuentan los avisos (no se reconocen por elemento) porque DeepSeek repinta el chat; se ignoran textos largos y el propio resultado enviado (podría contener «inténtalo más tarde»).
- Prueba nueva `tests/browser/test_ritmo.mjs` (Chromium + DeepSeek simulado): reenvío, pausa, falso positivo, repintado y aviso persistente.
## 2026-11-14 — Claude (asistente de desarrollo) · Contexto por niveles (idea de Isabel)
- Medido con las herramientas reales de AutoCAD: el prompt ocupaba 11.668 caracteres solo para ese MCP, se reenvía cada pocos mensajes, cortaba 9 descripciones a 400 caracteres y NO incluía las instrucciones del servidor (ahí está el flujo de trabajo).
- Nivel 0 (siempre): catálogo con la firma compacta y la primera frase de cada herramienta, y la primera frase de la guía de cada servidor. AutoCAD: 6.999 caracteres (−40 %).
- Nivel 1 (bajo demanda): herramienta virtual `wmb.ayuda(servidor, herramienta?)`, que responde la propia extensión: guía completa del servidor (sus `instructions`, que ahora se guardan del `initialize`) o ficha completa de una herramienta.
- Si una llamada falla, el error va con la ficha de esa herramienta para que la IA se corrija sola.
- `ayuda` se marca como entregada (si no, el vigilante de llamadas no ejecutadas la reintentaría).
- `npm test` volvía a fallar por `tests/test_repo_mcp.py` (trasladado a mis-mcp en el PR #11): quitado del script.

## 2026-11-13 — Claude (asistente de desarrollo) · Llamadas repetidas: pregunta el usuario
- Registro real: tras enviar un mensaje en un chat abierto, el escáner volvía a ver la respuesta ANTERIOR (repintada) y avisaba «Llamada repetida ignorada (textos)», aunque la llamada nueva sí se ejecutó después. El usuario pidió que una repetida nunca se descarte en silencio: debe preguntar.
- Ahora una llamada idéntica a una ya ejecutada que no es el repintado del mismo mensaje que la lanzó muestra una tarjeta «Llamada idéntica a una ya ejecutada · ¿La ejecuto otra vez?» con Ejecutar / Ignorar (una pregunta por mensaje). Se retira sola si la IA empieza otra respuesta o llega otra llamada.
- El cerrojo anti-duplicado propio de DeepSeek (`deepseek.js`) también descartaba en silencio: ahora pregunta igual, y lo que el usuario aprueba (`forced`) lo salta.
- El freno de bucles (3.ª repetición seguida) sigue igual.
- Prueba nueva `tests/browser/test_repetida.mjs`: primera vez se ejecuta sola; repintada en otro elemento → pregunta y no se ejecuta; Ejecutar → se repite; mismo mensaje → no pregunta; Ignorar → no se ejecuta.

## 2026-11-13 — Claude (asistente de desarrollo) · Rótulos de llamadas «descartadas»
- El registro mostraba «Llamada descartada» para `reason: duplicate, seenHere: true`, que es la web volviendo a pintar el MISMO mensaje cuya llamada ya se ejecutó (no una orden perdida). Ahora dice «Ya ejecutada: la web volvió a mostrar el mismo mensaje»; las repetidas de verdad, «Llamada idéntica a una anterior: se te pregunta» (PR #15), y las antiguas, «Llamada antigua».

## 2026-11-17 — Claude (asistente de desarrollo) · Catálogo: primera frase y regla 6
- `WMB.firstSentence` cortaba en las abreviaturas («máx.», «p. ej.») y en frases seguidas de texto en minúscula; ahora el punto cierra la frase salvo tras una abreviatura conocida.
- Regla 6 del prompt: si la IA duda o necesita algo que no ve, no debe decir que no se puede: pide `wmb.ayuda` (con o sin herramienta). Para seguir bajo 1700 caracteres se acortaron otras reglas (se quitó el ejemplo `/*PARTE2*/`).
- Contexto: los MCP propios ahora llevan `instructions` con la regla de elección en la primera frase (ver mis-mcp, «Estándar de catálogo»).

## 2026-11-18 — Claude (asistente de desarrollo) · Índice por grupos en el catálogo
- Problema: un MCP grande (autocad-mcp: 33 herramientas) costaba ~2.365 tokens en cada chat aunque se usaran 3 o 4.
- Mecanismo (sirve a cualquier MCP): si un servidor tiene ≥ 12 herramientas y alguna declara `_meta.grupo`, el prompt muestra la firma completa solo de las del núcleo (`_meta.nucleo`) y, del resto, los nombres por grupo. `wmb.ayuda` con `"grupo"` devuelve las firmas de ese grupo; sin `grupo` ni `herramienta`, la guía lista los grupos. Un servidor sin grupos, o con menos de 12 herramientas, se describe como antes. La IA puede llamar a cualquier herramienta sin pedir antes su ficha (si falla, el error ya trae la ficha).
- `background.js` pasa `grupo` y `nucleo` (de `_meta` o, para MCP que no se pueden editar, de `groups` en la configuración del servidor: pendiente de exponer en el popup). Regla 6 acortada para seguir bajo 1700 caracteres.
- Medido con el catálogo real: autocad-mcp 2.365 → 794 tokens (−66 %); autocad + terminal 3.277 → 1.706; los cuatro servidores 4.343 → 2.772.
- Pruebas nuevas en `tests/test_prompt.mjs`: índice, núcleo sin repetir en su grupo, grupo sin distinguir mayúsculas, grupo inexistente, servidor sin grupos o pequeño (plano) y ahorro mínimo.

## 2026-11-18 — Claude (asistente de desarrollo) · Aviso de bloque ilegible según su tamaño
- Caso real: Google escribió un bloque `mcp_call` de unos 202 caracteres sin cerrar y la extensión le pidió «trozos con write_file/append_file», un consejo para archivos grandes que no sirve para un bloque corto (y nombra herramientas que quizá no existen).
- Nuevo `WMB.unreadableCallMessage` (utils.js): hasta 700 caracteres explica que el fallo es de formato (llaves, comillas escapadas, barras dobles) y sugiere usar la herramienta específica en vez de `lisp`/`comando`; más largo, o con `@@@` sin cerrar, sigue pidiendo trozos. Mismo límite de 3 reintentos. `core_bridge.js` lo usa y registra el motivo correcto.
- Prueba en `tests/test_utils.mjs` (corto, largo y @@@).

## 2026-11-19 — Claude (asistente de desarrollo) · Adaptador para Le Chat de Mistral (chat.mistral.ai)
- Pedido del usuario: usar la extensión con https://chat.mistral.ai/work. Nuevo `content_scripts/adapters/mistral.js` (solo selectores, como Gemini), permiso y script de contenido para `https://chat.mistral.ai/*` en `manifest.json`, plataforma `mistral` en `shared/constants.js` (casilla en el popup) y mención en `INSTALL.md`.
- LIMITACIÓN: los selectores no se pudieron comprobar contra la web real (Cloudflare bloquea el acceso desde el entorno de desarrollo y hace falta sesión). Cada elemento lleva varios candidatos habituales de Le Chat (editor ProseMirror, `data-message-part-type="answer"`, botones con aria-label). Si falla, `tools/diagnostico-dom.js` (pegar en la consola de la página) saca los selectores reales sin leer el contenido de los mensajes.
- `tests/test_background.mjs` actualizado (plataformas por defecto). `npm test` pasa.


## 2026-11-19 — Claude (asistente de desarrollo) · Versión visible en el panel
- Pedido del usuario: ver qué versión está instalada, relacionarla con el commit y saber si es la más reciente. La cabecera del popup/panel lleva ahora un indicador `v1.2.0 · 38a33e5`; su color dice si es la más reciente de `main` (verde), si hay commits nuevos en main (ámbar), si es una rama de trabajo (violeta) o si hay una versión nueva en disco pendiente de recargar (ámbar). Pasar el ratón muestra versión, commit completo, rama y `origin/main`; un clic copia esos datos. La línea de Ajustes → Actualizaciones muestra lo mismo.
- La extensión lee su propio `.git` (`HEAD`, la rama, `packed-refs` y `origin/main`) sin ejecutar nada (`shared/versioning.js`, probado en `tests/test_version.mjs`); si no puede, usa `update-stamp.json`. `update.ps1` hace `git fetch origin main` también en ramas de trabajo y guarda `latest` en el sello, para poder comparar.

## 2026-11-19 — Claude (asistente de desarrollo) · Adaptadores para Kimi y WebLLM Chat
- Pedido del usuario: usar la extensión también con https://www.kimi.ai (Kimi) y https://chat.webllm.ai (modelos que corren en el navegador). Dos adaptadores nuevos, `kimi.js` (hosts kimi.ai y kimi.com, con y sin `www`) y `webllm.js`, con su permiso y script de contenido en `manifest.json`, su plataforma y casilla en Ajustes (`shared/constants.js`) y mención en `INSTALL.md`.
- LIMITACIÓN: igual que con Mistral, los selectores no se pudieron comprobar contra la web real (Kimi pide sesión). Cada elemento lleva varios candidatos. En WebLLM se revisó el código de la app (derivado de NextChat, clases con sufijos de CSS Modules, por eso se busca por fragmento) y `getAssistantMessages` descarta los mensajes del usuario, que también usan `.markdown-body`. Si algo falla: `tools/diagnostico-dom.js` en la consola de la página.
- WebLLM: sin imágenes (`acceptsImages = false`) y con pocos MCP activos a la vez (modelos locales pequeños).

## 2026-11-19 — Claude (asistente de desarrollo) · Se quita el adaptador de WebLLM Chat
- A petición del usuario (no le resulta útil): se elimina `webllm.js`, su permiso, su script de contenido y su plataforma. Kimi se queda.

## 2026-11-19 — Claude (asistente de desarrollo) · Se cambia el adaptador de Kimi por el de Qwen Chat
- A petición del usuario: se elimina `kimi.js` (permisos, script de contenido y plataforma) y se añade `qwen.js` para https://chat.qwen.ai.
- Los selectores de Qwen salen del código público de la app (`qwen-chat-fe`): `textarea#chat-input`, `.message-input-right-button-send` (botón de enviar; al generar muestra `icon-stop`) y respuestas con la clase `qwen-markdown`. No se probaron con una sesión real; si falla, `tools/diagnostico-dom.js`.
- El razonamiento (modo de pensamiento) se excluye de las respuestas observadas para no ejecutar dos veces una llamada escrita en el borrador.

## 2026-11-19 — Claude (asistente de desarrollo) · Auditoría en disco de las llamadas MCP
- Pedido del usuario: un registro de las acciones que se ejecutan desde un chat para poder auditar y pulir los MCP (no solo el de AutoCAD) y encontrar la causa de los fallos. El registro de la extensión (pestaña Actividad) vivía solo en el navegador (`chrome.storage`, anillo de entradas).
- `logger.js` admite un receptor (`setLogSink`) que recibe cada lote ya guardado; `background.js` lo reenvía al puente (hasta 1.000 entradas pendientes si el puente no está; se reintenta cada 30 s). El canal de control del puente acepta `{"type": "audit", "entries": [...]}` solo de la extensión propietaria y lo escribe `server/auditoria.py`: una línea JSON por evento en `server/auditoria/auditoria-AAAA-MM-DD.jsonl` (ignorada por git), con la hora local, la versión de la extensión + commit (`ext`), máscara de claves/tokens, lotes de 500 como máximo, 20 MB por archivo y 30 días de historia.
- `tool.call` ahora guarda también `chars` (tamaño del resultado) y, si la herramienta falló, el mensaje de error (primeros 280 caracteres): es lo que permite entender el fallo después.
- `python server/auditoria.py [--dias N] [--errores] [--carpeta …]` resume llamadas, errores y tiempos por herramienta, y entiende también el formato de `autocad-mcp`.
- Pruebas: `tests/test_auditoria.py` (máscara, escritura, purga, resumen), `tests/test_audit.mjs` (receptor) y `tests/test_bridge_config.py` (el puente real guarda un lote, enmascara y rechaza a otras extensiones y lotes inválidos). `npm test` pasa.

## 2026-11-20 — Claude (asistente de desarrollo) · Adaptador para Google AI Studio
- Pedido del usuario: usar la extensión también con https://aistudio.google.com. Nuevo `content_scripts/adapters/aistudio.js` (cuadro de texto de `ms-prompt-box`, botón «Run»/«Stop», respuestas en `ms-text-chunk`/`ms-cmark-node`), con permiso y script de contenido en `manifest.json`, plataforma y casilla «Google AI Studio» en Ajustes y mención en `INSTALL.md`.
- LIMITACIÓN: AI Studio exige sesión de Google y no se pudo ver desde el entorno de desarrollo: los selectores son los habituales de su interfaz, con varios candidatos por elemento. Se excluyen el razonamiento («Thoughts», `ms-thought-chunk`) y los turnos del usuario, que llevan ejemplos de `mcp_call`. Si algo falla: `tools/diagnostico-dom.js` en la consola de la página.

## 2026-11-20 — Claude (asistente de desarrollo) · Pausa entre envíos al chat: al azar entre 2 y 5 segundos
- Pedido del usuario: pausas aleatorias de 2 a 5 s entre los resultados que se envían al chat (para no mandar mensajes tan seguidos) y más fluidez. Antes: 5 s fijos + hasta un 50 % (5 a 7,5 s). `WMB.sendWait` toma ahora `minSec` y `maxSec` y espera, desde el último envío, un tiempo al azar dentro del rango (sin `maxSec`, fijo); el tope de envíos por minuto sigue igual.
- Ajustes nuevos `sendPauseMinSec` (2) y `sendPauseMaxSec` (5), con dos casillas en Ajustes → Chat (el rango siempre queda mín ≤ máx); sustituyen a `minSendIntervalSec`. Pruebas de `sendWait` actualizadas (rango, azar mínimo/medio/máximo y 200 muestras reales dentro de 2–5 s).
- Motivo del análisis: la auditoría de una sesión de AI Studio (28 llamadas) mostró que el ciclo completo tardaba una mediana de 33 s entre resultado entregado y siguiente llamada, casi todo tiempo del modelo; la parte de la extensión era ~4 a 5 s (herramienta 0,7 s y entrega 3,6 s, de ellos 2,5 s de una espera fija tras enviar).

## 2026-11-20 — Claude (asistente de desarrollo) · Pausa por plataforma
- La auditoría de una sesión de AI Studio mostró que Google respondió «You've reached your rate limit. Please try again later.» (cuota de peticiones por minuto) y que la extensión tardó 73 s en entregar un resultado (esperas de 21 s y 46 s). Con pausas de 2 a 5 s entre envíos ese límite se alcanza antes, así que cada chat puede tener su propio rango.
- Nuevo ajuste `platformPauses` ({plataforma: [mín, máx]}; `null` = la general): AI Studio trae 5 a 8 s; las demás usan la pausa general (2 a 5 s). `WMB.pauseFor` elige el rango (si el de la plataforma no es válido, usa el general; el máximo nunca baja del mínimo) y `core_bridge` lo aplica a su adaptador. En Ajustes → «Pausa por plataforma» hay dos casillas por chat; en blanco = la general.
- Pruebas de `pauseFor` en `tests/test_utils.mjs`.

## 2026-11-20 — Claude (asistente de desarrollo) · Envío más rápido: sin la espera fija de 2,5 s
- La auditoría de AI Studio mostró que cada entrega tardaba al menos 3 s: tras enviar, `sendToolResult` esperaba SIEMPRE 2,5 s buscando un aviso de «demasiados mensajes». Ahora sale en cuanto el chat empieza a responder (pasados 700 ms): ha aceptado el mensaje, así que el aviso (que llega en lugar de la respuesta) ya no puede llegar. Si hay aviso, sigue el reintento con espera creciente de siempre. Se detecta que el chat responde por el indicador «generando», por un mensaje nuevo del asistente o por un cambio en el texto del último.
- AI Studio: más candidatos para el botón «Stop» (en español «Detener»/«Parar», clases `stop`/`loading`): la auditoría no registró ningún evento de «generando» en esa plataforma. Si sigue sin verse, `tools/diagnostico-dom.js` con una respuesta GENERÁNDOSE da el selector real.

## 2026-11-20 — Claude (asistente de desarrollo) · Varias llamadas por mensaje (hasta 3)
- Motivo: la auditoría de AI Studio mostró que el tiempo del ciclo es sobre todo el del modelo (mediana de 40 s por llamada), así que juntar lecturas independientes en un mensaje ahorra viajes al modelo, y reduce los envíos que disparan el límite de peticiones de Google.
- Ajuste `maxCallsPerMessage` (1 a 3; por defecto 1 = como siempre; casilla en Ajustes → Chat). Con 2 o 3: el prompt añade la regla 4b (solo llamadas INDEPENDIENTES, cada una en su bloque ```json; las siguientes no se ejecutan si una falla) y el adaptador agrupa las llamadas nuevas del mismo mensaje en un lote. `core_bridge.handleBatch` las ejecuta EN ORDEN (cada una con su permiso y su aprobación); si una falla o se rechaza, las siguientes no se ejecutan y la IA recibe «No se ejecutó: la llamada anterior…». `deliverMany` envía TODOS los resultados en un solo mensaje, un bloque `[MCP_RESULT]` por llamada y en orden; el límite `maxResultChars` se reparte entre ellas (lo que sobre va como archivo) para no inflar el contexto. Auditoría: eventos `call.batch`, `call.batch.skipped` y `result.delivered` con `batch`.
- Pruebas: `tests/test_prompt.mjs` (la regla solo aparece con más de una llamada y es corta) y `tests/browser/test_lote.mjs` (Chromium con el flujo completo: 1 por defecto, 3 en orden con un solo envío, tope de 2, fallo de la segunda y una sola llamada). Playwright 1.63 con el Chromium de la caché del VPS: `NODE_PATH=~/pwtest/node_modules node tests/browser/test_lote.mjs`.

## 2026-11-20 — Claude (asistente de desarrollo) · Reinicio del puente desde fuera de la sesión
- Problema: `install_service.py` reiniciaba el puente con `Popen` DESDE la sesión que lo pedía; al reiniciarlo por SSH (para actualizar el servidor) el proceso nuevo moría al cerrarse la sesión (queda dentro de su «job»), dejando sin puente a los MCP de los chats.
- Ahora crea la tarea programada `WebMCPBridge-Start` (sin disparador, sesión interactiva del usuario, lanza el `WebMCPBridge.vbs` de la carpeta Inicio) y la ejecuta con `schtasks /run`: la lanza el Programador de tareas, independiente de quien la pida. Si eso falla, prueba un proceso desligado del job (`CREATE_BREAKAWAY_FROM_JOB`) y, en último caso, el arranque directo de antes. Comprueba que el puente responde (127.0.0.1:47615) e indica cómo lo arrancó; `--uninstall` también quita la tarea.
- Prueba: `tests/test_install_service.py` (XML de la tarea: válido con «&» en el nombre, sesión interactiva, sin disparador, una instancia). La comprobación real (reiniciar por SSH y ver que sigue en marcha tras cerrar la sesión) se hizo en la laptop del usuario.

## 2026-11-20 — Claude (asistente de desarrollo) · Ajustes más compactos; ninguna plataforma activa por defecto; una sola pausa general
- Pestaña Ajustes rediseñada: una fila por opción (icono · nombre corto · control a la derecha) agrupadas en «Chats donde actúa», «Envío de resultados», «Automático» y «Extensión». El texto explicativo de cada opción pasó a una pista (i) que se ve al pasar el ratón o con el foco del teclado, sin perder ninguna explicación. Las plataformas son botones tipo etiqueta (se ven de un vistazo cuáles están activas). La línea de versión de «Actualizar sola» es más corta. Iconos nuevos en el sprite (temporizador, capas, medidor, archivo, reloj, rayo, enviar, campana, repetir y ojo).
- Ninguna plataforma viene activa: `platforms` por defecto todo `false` y `platformOn()` exige `=== true`. Si ninguna está marcada, el aviso «Ninguna activa» aparece en Ajustes y el subtítulo de la cabecera lo dice. Lo que el usuario ya hubiera marcado se conserva; el resto queda apagado hasta que lo active.
- Pausa entre envíos: una sola general para todos los chats (mín y máx, por defecto 2 a 5 s). Se elimina el ajuste `platformPauses` y su sección. Por el límite de peticiones de AI Studio conviene subirla (p. ej. 5 y 8) si se usa ese chat.
- Pruebas: `test_background` (plataformas apagadas por defecto y se conserva lo elegido), `test_utils` (sin `pauseFor`) y los tests de navegador (simulan `platforms: { deepseek: true }`). Revisado con una captura de la pestaña en Chromium.

