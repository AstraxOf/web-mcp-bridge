FROM python:3.11-slim

WORKDIR /app

# Instalar dependencias del servidor
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copiar los archivos del servidor
COPY server/ ./server/

# Glama necesita que el contenedor se comporte como un servidor MCP (stdio).
# Ejecutamos el servidor demo que viene incluido y habla el protocolo MCP por consola.
CMD ["python", "server/examples/demo_mcp_server.py"]
