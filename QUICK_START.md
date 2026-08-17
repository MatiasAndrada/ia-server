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

### Ejecución
- `npm run dev` - Desarrollo con hot reload
- `npm run build` - Compilar TypeScript
- `npm start` - Producción
- `npm run pm2:start` - Iniciar con PM2
- `npm run pm2:restart` - Reiniciar servicio con PM2
- `npm run pm2:stop` - Detener servicio con PM2
- `npm run pm2:logs` - Ver logs en tiempo real con PM2
- `npm run pm2:delete` - Eliminar servicio de PM2

### Tests
- `npm test` - Ejecutar todos los tests una sola vez (útil para CI/CD)
- `npm run test:watch` - Tests en modo observación (detecta cambios automáticamente)
- `npm run test:coverage` - Cobertura de tests (genera reporte HTML en `coverage/`)
- `npm run test:integration` - Tests de integración (valida flujos completos)
- `npm run test:manual` - Test manual contra negocio real (pruebas manuales con datos reales)
- `npm run test:reservation` - Tests del flujo de reservas (solo tests de reservación)

**Diferencias clave:**
- `npm test` - Una ejecución, resultado rápido
- `npm run test:watch` - Ejecución continua, ideal para desarrollo activo
- `npm run test:coverage` - Genera reportes de calidad de código
- `npm run test:integration` - Tests lentos que validan integración entre componentes
- `npm run test:manual` - Script manual (no automático), prueba contra BD/APIs reales
- `npm run test:reservation` - Filtra solo tests de reservas para desarrollo específico

### WhatsApp
- `npm run whatsapp:connect` - Conectar cliente WhatsApp
- `npm run whatsapp:clean` - Limpiar sesiones de autenticación

### Tipos & Base de datos
- `npm run supabase:gen` - Generar tipos de Supabase
- `npm run types:generate` - Generar tipos TypeScript

### Desarrollo
- `npm run chat:simulate` - Simular conversaciones de chat
- `npm run lint` - Validar código con ESLint
- `npm run format` - Formatear código con Prettier

## 📞 Soporte

Para más información, consultar la documentación completa o contactar al equipo de desarrollo.
