# IA Server - API de Inteligencia Artificial

Backend de IA para sistema de gestión de listas de espera vía WhatsApp.

## 🚀 Quick Start

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar entorno
```bash
cp .env.example .env
# Editar .env y configurar API_KEY
```

### 3. Iniciar en desarrollo
```bash
npm run dev
```

### 4. Probar
```bash
curl http://localhost:4000/health
```

## 📚 Documentación Completa

Ver [README.md](README.md) para documentación completa y:
- [docs/ENDPOINTS.md](docs/ENDPOINTS.md) para todos los endpoints HTTP
- [docs/AGENTS.md](docs/AGENTS.md) para configuración del sistema multi-agente

## 🔑 Variables de Entorno Requeridas

- `API_KEY` - Clave de autenticación (generarla con `openssl rand -hex 32`)
- `OPENROUTER_API_KEY` - API key de OpenRouter (obtenerla en https://openrouter.ai)
- `OPENROUTER_MODEL` - Modelo a usar, formato "vendor/modelo" (ej: `anthropic/claude-3.5-sonnet`)
- `REDIS_URL` - URL de Redis (default: redis://localhost:6379)
- `NODE_ENV` - Modo de ejecución:
  - `production`: responde a todos los chats de clientes
  - `test`: responde SOLO en tu chat personal de WhatsApp (útil para pruebas)

## 📡 Endpoints Principales

- `POST /api/chat` - Procesar mensaje con IA
- `POST /api/analyze-intent` - Analizar intención
- `POST /api/batch` - Procesar múltiples mensajes
- `GET /api/sessions` - Listar sesiones de WhatsApp
- `POST /api/messages/send` - Enviar mensajes por WhatsApp
- `GET /health` - Health check

## 🛠️ Scripts Útiles

- `npm run dev` - Desarrollo con hot reload
- `npm run build` - Compilar TypeScript
- `npm start` - Producción
- `npm test` - Ejecutar tests
- `npm run pm2:start` - Iniciar con PM2

## 📞 Soporte

Para más información, consultar la documentación completa o contactar al equipo de desarrollo.
