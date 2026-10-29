<div align="center">

<img src="icons/icon128.png" width="96" alt="Web MCP Bridge">

# Web MCP Bridge

**Usa tus servidores MCP locales con ChatGPT, Gemini y Claude Web, sin API keys ni suscripciones extra.**

[![English](https://img.shields.io/badge/English-Click-2563eb?style=flat-square)](README.md)
[![Español](https://img.shields.io/badge/Español-Clic-eab308?style=flat-square)](README.es.md)

[![CI](https://github.com/AstraxOf/web-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/AstraxOf/web-mcp-bridge/actions)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0f766e?style=flat-square&logo=googlechrome&logoColor=white)
![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Dependencias](https://img.shields.io/badge/deps%20extensión-0-success?style=flat-square)
![Chrome | Edge | Brave](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-116%2B-informational?style=flat-square)

[![Telegram](https://img.shields.io/badge/Telegram-Canal-26A5E4?style=flat-square&logo=telegram&logoColor=white)](https://t.me/AstraxMCP)
[![YouTube](https://img.shields.io/badge/YouTube-@AstraxOf-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtube.com/@AstraxOf)
[![Sitio web](https://img.shields.io/badge/astrabots.pro-0f766e?style=flat-square&logo=googlechrome&logoColor=white)](https://astrabots.pro)
[![SDK principal](https://img.shields.io/badge/astrax--mcp-Python-3776AB?style=flat-square&logo=python&logoColor=white)](https://github.com/AstraxOf/astrax-mcp)
[![GitHub](https://img.shields.io/badge/GitHub-AstraxOf-181717?style=flat-square&logo=github)](https://github.com/AstraxOf)

</div>

---
<div align="center">
  <img src="assets/demo.gif" width="700" alt="Demostración de Web MCP Bridge">
</div>

Las interfaces web gratuitas de IA no hablan MCP. **Web MCP Bridge** les añade esa capacidad:
la IA pide una herramienta con un bloque JSON, la extensión la ejecuta en tu servidor MCP local
y devuelve el resultado al chat. Tú decides qué se ejecuta.

> [!IMPORTANT]
> Solo conecta servidores MCP en los que confíes: una herramienta con acceso al sistema de archivos puede leer lo que le permitas.

```mermaid
flowchart LR
    subgraph Navegador
      A[ChatGPT / Gemini / Claude] <--> B[Content script<br/>+ adaptador]
      B <--> C[Service Worker]
      D[Popup] --> C
    end
    C <-- WebSocket --> E[mcp_ws_bridge.py]
    E <-- stdio --> F[astrax-mcp]
    E2[mcp_ws_bridge.py] <-- stdio --> G[filesystem-mcp]
    C <-- WebSocket --> E2
```

## 🧩 Plataformas compatibles

| Plataforma | Estado | Adaptador |
|---|---|---|
| ![ChatGPT](https://img.shields.io/badge/ChatGPT-74aa9c?style=for-the-badge&logo=openai&logoColor=white) | ✅ Soportada | `adapters/chatgpt.js` |
| ![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white) | ✅ Soportada | `adapters/gemini.js` |
| ![Claude](https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white) | ✅ Soportada | `adapters/claude.js` |
| ![Perplexity](https://img.shields.io/badge/Perplexity-1FB8CD?style=for-the-badge&logo=perplexity&logoColor=white) · ![DeepSeek](https://img.shields.io/badge/DeepSeek-4D6BFE?style=for-the-badge) · ![Le Chat](https://img.shields.io/badge/Le%20Chat-FA520F?style=for-the-badge&logo=mistralai&logoColor=white) | 🗺️ Roadmap | [Contribuir](CONTRIBUTING.md) |

## ✨ Características de un vistazo

| | Habilidad | Qué hace |
|---|---|---|
| ![multi](https://img.shields.io/badge/Multi--MCP-0f766e?style=flat-square) | **Control de contexto** | Registra los servidores que quieras, activa **1 por defecto** (hasta **5**). Solo las herramientas de los activos se describen a la IA; el popup muestra los tokens aproximados. |
| ![perms](https://img.shields.io/badge/Permisos-dc2626?style=flat-square) | **Permisos por MCP** | Selector de 3 estados: *Permitir siempre* (no pregunta nunca) · *Preguntar siempre* (cada llamada aparece con sus argumentos: *Ejecutar*, *Permitir siempre* o *Rechazar*) · *No permitir* (el MCP no se describe a la IA). Global y por servidor, en el popup y en el panel. |
| ![files](https://img.shields.io/badge/Adjuntos-7c3aed?style=flat-square) | **Nada se omite** | Imágenes, audio y recursos binarios (p. ej. `astrax_ver_pantalla`) se adjuntan al chat como archivos reales; un texto largo se adjunta completo como `.txt`. Si el chat no admite adjuntos, se descarga y el mensaje lo indica. |
| ![empty](https://img.shields.io/badge/Instala%20vac%C3%ADo-475569?style=flat-square) | **Sin MCP preinstalados** | Añade los tuyos o el servidor demo con un clic. |
| ![bg](https://img.shields.io/badge/Segundo%20plano-0891b2?style=flat-square) | **Funciona con la pestaña oculta** | Ningún paso depende de los temporizadores de la página; hay un latido de estado, el envío se comprueba y reintenta, y una llamada atascada no bloquea las siguientes. Último recurso: trae la pestaña al frente un instante (desactivable). |
| ![memory](https://img.shields.io/badge/Memoria%20de%20tools-ca8a04?style=flat-square) | **La IA no olvida sus herramientas** | Línea corta (~45 tokens) en cada mensaje, reenvío completo cada N mensajes y reenvío automático si la IA dice que no tiene acceso. |
| ![compact](https://img.shields.io/badge/Prompt%20compacto-16a34a?style=flat-square) | **≈ 50 % menos tokens** | Firmas `nombre(param: tipo)` en lugar de JSON Schema. |
| ![adapter](https://img.shields.io/badge/Patr%C3%B3n%20adaptador-2563eb?style=flat-square) | **~40 líneas por plataforma** | Una plataforma nueva son solo selectores. |
| ![selectors](https://img.shields.io/badge/Selectores%20resilientes-0d9488?style=flat-square) | **Resistente a cambios de UI** | Varios candidatos por elemento + detección de visibilidad. |
| ![secure](https://img.shields.io/badge/Seguro%20por%20dise%C3%B1o-b91c1c?style=flat-square&logo=letsencrypt&logoColor=white) | **Blindado** | El puente escucha en `127.0.0.1`, solo acepta orígenes `chrome-extension://` y admite token. Las webs no pueden conectarse a tus herramientas. |
| ![reliable](https://img.shields.io/badge/Fiabilidad-9333ea?style=flat-square) | **Sin duplicados y con reconexión** | ID por llamada, línea base al cargar un chat, solo se actúa sobre el último mensaje, backoff exponencial, keep-alive MV3, historial y tema claro/oscuro. |

> [!TIP]
> ¿Quieres probarlo en 60 segundos? Incluye un **servidor MCP de demostración**. Ve a [Prueba en 60 segundos](#-prueba-en-60-segundos).

## ⚡ Instalación en 2 pasos (y después solo un botón)

Los navegadores no pueden lanzar programas de tu equipo, así que hace falta **una sola vez** este comando.
Deja el puente corriendo en segundo plano y arrancando solo con tu sesión (Windows, macOS y Linux):

```bash
python server/install_service.py
```

Luego carga la extensión (`chrome://extensions` → Modo desarrollador → *Cargar descomprimida*).
Desde ese momento todo se controla con el **interruptor del popup** (o el botón *Desactivar bridge* del panel dentro del chat).
Con el bridge apagado no hay conexiones, no se inyecta nada y el icono muestra `OFF`.
Para quitar el arranque automático: `python server/install_service.py --uninstall`.

## 🚀 Prueba en 60 segundos

```bash
pip install -r server/requirements.txt
python server/mcp_ws_bridge.py --port 8080 --name demo -- python server/examples/demo_mcp_server.py
```

1. Abre `chrome://extensions` → activa **Modo desarrollador** → **Cargar descomprimida** → elige esta carpeta.
2. Abre el popup y añade tu servidor (nombre `astrax_mcp`, dirección `ws://localhost:8080`); se pone en verde al conectar. Para probar sin nada propio, usa *Añadir servidor de prueba (demo)*.
3. Entra en ChatGPT, Gemini o Claude, abre el panel **Web MCP Bridge** (abajo a la izquierda) y pulsa **Inyectar instrucciones**.
4. Escribe: *«¿Qué hora es? Usa tus herramientas.»* → aprueba la llamada → listo.

### Con tu propio MCP (por ejemplo `astrax-mcp`)

```bash
python server/mcp_ws_bridge.py --port 8080 --name astrax -- python -m astrax_mcp
```

Varios a la vez: copia `server/servers.example.json` a `servers.json` y ejecuta
`python server/mcp_ws_bridge.py --config servers.json`. Después regístralos en el popup.

## 📡 Protocolo de llamada

La IA responde con un único bloque y se detiene:

````json
{
  "mcp_call": {
    "server": "nombre_del_servidor_mcp",
    "name": "nombre_de_la_herramienta",
    "arguments": { "arg1": "valor" }
  }
}
````

El resultado vuelve como mensaje del usuario:

```
[MCP_RESULT server="demo" tool="sumar" status="ok"]
42
[/MCP_RESULT]
```

`status` puede ser `ok`, `error` o `rejected`.

> [!NOTE]
> El contenido de `MCP_RESULT` se presenta a la IA como *datos*, no como instrucciones (mitigación de *prompt injection*).

## 📁 Estructura

```
manifest.json
background/      background.js (service worker) · ws_client.js (conexión MCP + reconexión)
popup/           popup.html · popup.js · popup.css
content_scripts/ core_bridge.js · prompt_builder.js · ui_widget.js · utils.js
  adapters/      base_adapter.js · chatgpt.js · gemini.js · claude.js
server/          mcp_ws_bridge.py · examples/demo_mcp_server.py · servers.example.json
tests/ scripts/  pruebas, validador, generador de iconos y empaquetado
```

## 🔧 Si una web cambia su interfaz

Los selectores viven al principio de cada adaptador (`content_scripts/adapters/*.js`). Añade el nuevo
selector **al inicio** de la lista correspondiente (`composer`, `sendButton`, `assistantMessages`, `stopButton`).
Abre un issue con la plantilla «Selector roto»: suele resolverse con una línea.

## 🔒 Modelo de seguridad

| Riesgo | Mitigación |
|---|---|
| Una web abre `ws://localhost` y ejecuta herramientas | El puente rechaza cualquier `Origin` que no sea de una extensión |
| La IA ejecuta acciones no deseadas | Permiso «Preguntar siempre» por defecto; «Permitir siempre» es una decisión explícita por MCP (o global) y «No permitir» bloquea el MCP |
| Instrucciones ocultas en resultados (*prompt injection*) | El prompt indica que `MCP_RESULT` es solo datos; tú ves cada llamada antes de ejecutarla |
| Exposición en red | Escucha solo en `127.0.0.1`; token opcional (`--token`) |

## 🧪 Desarrollo

```bash
npm test        # sintaxis, parser, prompt y prueba de integración del puente
npm run pack    # genera dist/web-mcp-bridge.zip
```

## 🗺️ Roadmap

- [ ] Soporte para Firefox (MV3) y Perplexity / DeepSeek / Mistral Le Chat
- [ ] Llamadas múltiples por mensaje
- [ ] Selectores configurables desde el popup
- [ ] Transporte SSE / Streamable HTTP además de WebSocket
- [ ] Publicación en Chrome Web Store

## 🤝 Comunidad y contribuciones

**Astrax** es Open Source y crece con la comunidad. Si quieres sumarte, eres bienvenido: puedes abrir issues, enviar pull requests, proponer ideas, probar Astrax en otros sistemas o clientes MCP y reportar errores. Lee [CONTRIBUTING.md](CONTRIBUTING.md): los adaptadores nuevos son la mejor forma de empezar.

[![Canal de Telegram](https://img.shields.io/badge/Telegram-Canal%20oficial-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/AstraxMCP)
[![YouTube](https://img.shields.io/badge/YouTube-@AstraxOf-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtube.com/@AstraxOf)
[![Creador en Telegram](https://img.shields.io/badge/Creador-@RufusOficial-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/RufusOficial)
[![Correo](https://img.shields.io/badge/Correo-avpn497%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:avpn497@gmail.com)

Si te sirvió el proyecto, deja una ⭐ en el repositorio y suscríbete al canal.

<div align="center">

Hecho con 💙 por Rufus · [@AstraxOf](https://github.com/AstraxOf) · [astrabots.pro](https://astrabots.pro)

**[Licencia MIT](LICENSE)**

</div>
