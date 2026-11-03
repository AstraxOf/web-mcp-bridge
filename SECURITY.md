# Security Policy

> [Leer en español](#política-de-seguridad)

Web MCP Bridge connects web chats (ChatGPT, Gemini, Claude, DeepSeek) with MCP servers running on your own computer. Because it can trigger tools with access to local files and programs, we take security reports seriously and appreciate responsible disclosure.

## Supported versions

Security fixes are provided for the latest minor release only.

| Version | Supported |
|---------|-----------|
| 1.6.x   | ✅ Yes    |
| < 1.6   | ❌ No     |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use one of these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred): go to the [Security tab](https://github.com/AstraxOf/web-mcp-bridge/security/advisories/new) and click *Report a vulnerability*.
2. **Email**: [avpn497@gmail.com](mailto:avpn497@gmail.com) with the subject `[SECURITY] Web MCP Bridge`.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version, operating system and browser.
- Any suggested fix or mitigation.

### What to expect

| Stage | Target time |
|-------|-------------|
| Acknowledgement of your report | within 72 hours |
| Initial assessment and severity | within 7 days |
| Fix or mitigation plan | within 30 days for confirmed issues |

We will keep you informed, credit you in the release notes if you wish, and coordinate a disclosure date with you. Please give us a reasonable time to release a fix before any public disclosure.

## Scope

In scope (examples):

- A website being able to reach the bridge, the control port (`:8099`) or the launcher port (`:8098`), bypassing `Origin` / `Host` checks.
- Bypassing the permission system ("Ask every time", "Allow always", "Don't allow").
- Execution of tools without user approval.
- Prompt-injection paths that escape the `MCP_RESULT` data framing.
- Token handling flaws, path traversal, or command injection in the Python bridge or launcher.
- Unsafe use of `eval`, `innerHTML` with page data, or unexpected external network requests in the extension.

Out of scope:

- Actions performed by an MCP server that the user chose to install and approve (the server's own behavior is its author's responsibility).
- Attacks requiring prior full control of the user's machine or browser profile.
- Social engineering of the user, and issues in third-party sites (ChatGPT, Gemini, Claude, DeepSeek) themselves.
- Selector breakage after a site redesign (please use the *selector roto* issue template).

## Security model summary

- The bridge listens on `127.0.0.1` only and accepts only `chrome-extension://` origins; an optional `--token` is supported.
- The control and launcher ports accept only extension origins and local hosts; state-changing routes require `POST`.
- Every tool call requires approval by default.
- Tool results are presented to the AI as data, not instructions.

More details are in the [Security model](README.md#-security-model) section of the README.

## Safe usage recommendations

- Only connect MCP servers you trust and review the commands in `server/servers.json`.
- Restrict filesystem MCP servers to the narrowest folder possible.
- Prefer "Ask every time" over "Allow always" for tools that write, delete or execute.
- Keep the project and your browser up to date.

---

# Política de seguridad

> [Read in English](#security-policy)

Web MCP Bridge conecta los chats web (ChatGPT, Gemini, Claude, DeepSeek) con servidores MCP que se ejecutan en tu propio equipo. Como puede disparar herramientas con acceso a archivos y programas locales, tomamos los reportes de seguridad muy en serio y agradecemos la divulgación responsable.

## Versiones con soporte

Las correcciones de seguridad se publican solo para la última versión menor.

| Versión | Soportada |
|---------|-----------|
| 1.6.x   | ✅ Sí     |
| < 1.6   | ❌ No     |

## Cómo reportar una vulnerabilidad

**Por favor, no abras un issue público para problemas de seguridad.**

Usa uno de estos canales privados:

1. **Reporte privado de vulnerabilidades de GitHub** (preferido): ve a la [pestaña Security](https://github.com/AstraxOf/web-mcp-bridge/security/advisories/new) y pulsa *Report a vulnerability*.
2. **Correo**: [avpn497@gmail.com](mailto:avpn497@gmail.com) con el asunto `[SECURITY] Web MCP Bridge`.

Incluye, en lo posible:

- Descripción del problema y su impacto.
- Pasos para reproducirlo (o una prueba de concepto).
- Versión afectada, sistema operativo y navegador.
- Sugerencia de corrección o mitigación, si la tienes.

### Qué puedes esperar

| Etapa | Plazo objetivo |
|-------|----------------|
| Confirmación de recepción | en 72 horas |
| Evaluación inicial y severidad | en 7 días |
| Plan de corrección o mitigación | en 30 días para problemas confirmados |

Te mantendremos informado, te daremos crédito en las notas de la versión si lo deseas y acordaremos contigo la fecha de divulgación. Te pedimos un plazo razonable para publicar la corrección antes de cualquier divulgación pública.

## Alcance

Dentro del alcance (ejemplos):

- Que una web logre acceder al puente, al puerto de control (`:8099`) o al del lanzador (`:8098`), saltándose las comprobaciones de `Origin` / `Host`.
- Saltarse el sistema de permisos ("Preguntar siempre", "Permitir siempre", "No permitir").
- Ejecución de herramientas sin aprobación del usuario.
- Vías de *prompt injection* que escapen del marco de datos de `MCP_RESULT`.
- Fallos en el manejo del token, *path traversal* o inyección de comandos en el puente Python o el lanzador.
- Uso inseguro de `eval`, `innerHTML` con datos de la página o peticiones de red externas inesperadas en la extensión.

Fuera del alcance:

- Acciones realizadas por un servidor MCP que el usuario decidió instalar y aprobar (su comportamiento es responsabilidad de su autor).
- Ataques que requieran control total previo del equipo o del perfil del navegador.
- Ingeniería social al usuario y problemas de los propios sitios (ChatGPT, Gemini, Claude, DeepSeek).
- Selectores rotos tras un rediseño de una web (usa la plantilla de issue *selector roto*).

## Resumen del modelo de seguridad

- El puente escucha solo en `127.0.0.1` y acepta únicamente orígenes `chrome-extension://`; admite un `--token` opcional.
- Los puertos de control y lanzador aceptan solo orígenes de extensión y hosts locales; las rutas que cambian estado exigen `POST`.
- Toda llamada a una herramienta requiere aprobación por defecto.
- Los resultados de las herramientas se presentan a la IA como datos, no como instrucciones.

Más detalles en la sección [Security model](README.md#-security-model) del README.

## Recomendaciones de uso seguro

- Conecta solo servidores MCP de confianza y revisa los comandos de `server/servers.json`.
- Limita los servidores MCP de archivos a la carpeta más pequeña posible.
- Prefiere "Preguntar siempre" frente a "Permitir siempre" en herramientas que escriben, borran o ejecutan.
- Mantén el proyecto y tu navegador actualizados.