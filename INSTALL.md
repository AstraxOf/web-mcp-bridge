# Instalación en Windows + Chrome

Guía para instalar Web MCP Bridge en tu PC y probarlo. Tarda unos 10 minutos.

## Requisitos (una sola vez)

| Programa | Dónde | Nota |
|---|---|---|
| Git | https://git-scm.com/download/win | Opciones por defecto |
| Python 3.9+ | https://www.python.org/downloads/ | Marca **«Add python.exe to PATH»** |
| Google Chrome 116+ | — | |

Comprueba en PowerShell:

```powershell
git --version
py -3 --version
```

## 1. Descargar el repositorio

Elige una carpeta fija: Chrome cargará la extensión desde ahí y la actualización automática trabajará sobre ella. No la muevas después.

```powershell
cd $HOME
git clone https://github.com/cityny/web-mcp-bridge.git
cd web-mcp-bridge
git checkout main
```

> Mientras los cambios del fork no estén en `main`, usa la rama de desarrollo:
> `git checkout claude/eager-ptolemy-8kea2p`

## 2. Instalar el puente local

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

El script:

1. Comprueba Python y Git.
2. Crea `server\servers.json` solo con el servidor de prueba `demo` (puerto 8090), si no existe.
3. Detiene un puente anterior, si lo hay (evita el error «solo se permite un uso de cada dirección»).
4. Instala dependencias, registra el arranque automático al iniciar sesión y arranca el puente en segundo plano.
5. Comprueba que el puente responde (canal de descubrimiento, puerto 47615), copia la ruta de la extensión al portapapeles y abre `chrome://extensions`.

## 3. Cargar la extensión en Chrome

1. En `chrome://extensions` activa **Modo de desarrollador** (arriba a la derecha).
2. **Cargar descomprimida** → pega la ruta (la carpeta del repositorio, donde está `manifest.json`).
3. Fija el icono de la extensión en la barra (icono de puzle → chincheta).
4. Abre el popup: detecta solos los MCP de `server\servers.json` y los añade **desactivados**. Activa los que quieras con su interruptor (máximo 5 a la vez). Botón **Detectar MCP del PC** para volver a leerlos.

## 4. Probar

1. Entra en https://chat.deepseek.com (o ChatGPT, Gemini, Claude, Le Chat de Mistral: https://chat.mistral.ai, Qwen: https://chat.qwen.ai, Google AI Studio: https://aistudio.google.com).
2. Escribe: *«¿Qué hora es? Usa tus herramientas.»* y envía. La extensión añade las instrucciones automáticamente al primer mensaje.
3. La IA responde con un bloque `mcp_call` → aparece el panel de aprobación → **Ejecutar**.
4. El resultado vuelve al chat y la IA contesta con la hora.

Herramientas del demo: `hora_actual`, `sumar(a, b)`, `eco(texto)`.

## Añadir tus propios MCP (sin abrir archivos)

1. Popup → **Añadir o editar MCP…** Se abre el editor en una pestaña.
2. Elige una plantilla y rellena los campos:
   - **Archivos de una carpeta:** nombre y carpeta. Necesita Node.js.
   - **MCP por HTTP:** nombre y dirección, p. ej. `http://127.0.0.1:8765/mcp`. La extensión se conecta **directamente**, sin `mcp-proxy` ni puente. El MCP HTTP tiene que estar arrancado (tu acceso directo).
   - **Personalizado:** comando y argumentos.
3. Pulsa **Añadir a la configuración**, revisa la tabla «Lo que se ejecutará» y pulsa **Guardar** (o Ctrl+S). Te pedirá confirmación con los comandos nuevos.
4. El puente aplica el cambio al momento y el MCP aparece en el popup, desactivado. Actívalo con su interruptor.

Más detalles:
- **Edición directa:** en el mismo editor puedes cambiar el JSON a mano.
  - Valida mientras escribes.
  - Si pegas rutas de Windows con `\`, el botón **Cambiar \ por /** las arregla.
  - Cada vez que guardas, se deja una copia del archivo anterior en `servers.json.bak`.
- **Seguridad:** solo esta extensión (ID fijo `kpjokcdpjbiljllmdobofmomhifebbbo`) puede leer o cambiar la configuración. Otras extensiones y las webs no pueden.
- **MCP por HTTP:** se escriben como `{"autocad": {"url": "http://127.0.0.1:8765/mcp"}}`. El puente no arranca nada para ellos, solo los anuncia a la extensión.
- **Formatos admitidos:** `{"nombre": {"command", "args", "port"}}`, `{"mcpServers": {...}}` (estilo Claude Desktop) y `{"servers": [...]}`. Sin `port` se asigna uno libre desde 8800.

## Actualización automática

`install.ps1` registra la tarea programada **WebMCPBridge-Update**. Cada 10 minutos, sin abrir ventanas:

1. Si la carpeta está en la rama `main` y no tiene cambios locales, baja la versión nueva (`git pull --ff-only`). Nunca sobrescribe trabajo tuyo.
2. Si cambió el puente (`server/`), lo reinicia.
3. Escribe `update-stamp.json`. La extensión lo lee cada minuto y, si hay versión nueva, **se recarga sola**. Nunca lo hace en mitad de una llamada a una herramienta.
4. Después de una recarga, las pestañas de chat abiertas muestran «La extensión se actualizó: recarga la pestaña». Pulsa F5 en ellas.

- **Requisito:** la carpeta debe estar en `main` (`git checkout main`). En otra rama la tarea no hace nada y lo indica en *Ajustes → Actualizaciones*.
- **Estado y log:** el estado aparece en *Ajustes → Actualizaciones* y el historial en `server\update.log`.
- **Actualizar a mano:**

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\windows\update.ps1
  ```

- **Desactivar:**
  - la recarga de la extensión: interruptor en *Ajustes*;
  - la tarea programada: `install.ps1 -NoAutoUpdate`, o `Unregister-ScheduledTask -TaskName WebMCPBridge-Update -Confirm:$false`.

## Problemas frecuentes

| Síntoma | Qué mirar |
|---|---|
| El servidor sale en rojo en el popup | `Get-Content server\bridge.log -Tail 20 -Encoding UTF8`; vuelve a ejecutar el script de instalación |
| «La extensión se actualizó: recarga la pestaña» | Recarga la pestaña del chat (F5) |
| La IA no usa la herramienta | Botón **Inyectar instrucciones** en el panel del chat |
| El editor dice «no autorizado» | La extensión cargada no es la de este repositorio (ID distinto): quítala y vuelve a cargarla desde la carpeta del repositorio |
| `py` no se reconoce | Reinstala Python marcando «Add python.exe to PATH» |

## Desinstalar

```powershell
py -3 server\install_service.py --uninstall
```

```powershell
Unregister-ScheduledTask -TaskName WebMCPBridge-Update -Confirm:$false
```

Después quita la extensión en `chrome://extensions`.

## Repos de GitHub (repo-github)

El MCP `repo-github` (archivos, git y API de GitHub para varios repos) vive ahora en un repositorio aparte, junto con los demás MCP propios. El puente lo lanza como cualquier otro MCP desde `server\servers.json`, por ejemplo: `{"repo-github": {"command": "py", "args": ["C:/ruta/repo-github/repo_mcp.py"], "port": 8793}}`.

La extensión trata de forma especial a cualquier MCP que ofrezca la herramienta `sync_check` (y `sync_apply`):

**Sincronización:** antes de trabajar con un repo, la extensión consulta GitHub. Si solo cambió GitHub, actualiza la copia local y se lo cuenta a la IA. Si cambiaron GitHub y lo local, te pregunta qué conservar (*Usar GitHub* guarda un respaldo de lo local; *Mantener lo local* mezcla lo nuevo). Se repite cada 10 minutos y siempre antes de `git_commit` y `git_push`.

## Auditoría de las llamadas (qué pidió cada chat y por qué falló)
La extensión envía cada evento de su registro (llamadas a herramientas, errores, avisos) al puente local, que los guarda como una línea JSON por evento en `server\auditoria\auditoria-AAAA-MM-DD.jsonl`: rotación diaria, 30 días, textos recortados y sin claves ni tokens. No se guarda el contenido de los mensajes del chat ni los resultados completos de las herramientas (solo su tamaño y, si fallan, el mensaje de error). Funciona con cualquier MCP y cualquier chat, en cualquier PC donde esté el puente (`--config`).

Resumen de lo registrado:
```
python server\auditoria.py                     # últimos 7 días: llamadas, errores y tiempos por herramienta
python server\auditoria.py --dias 1 --errores  # solo los errores de hoy
```
`autocad-mcp` escribe su propio registro (`autocad-mcp\auditoria\`, mismo formato) con los argumentos y el error de cada herramienta; el comando de arriba también lo entiende (`--carpeta`). Cruzando las horas de ambos se ve qué pidió el chat y qué respondió AutoCAD.

