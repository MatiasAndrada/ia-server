#!/bin/bash

# Deploy de producción.
#
# Despliega exactamente el commit en el que está parado el repo, y sólo si:
#   - no hay cambios sin commitear ni archivos sin trackear. `tsc` compila todo
#     `src/`, esté en git o no: así llegó a producción la lista de números
#     bloqueados de De La Fonte (23/09) sin haberse commiteado nunca, y se
#     perdió con el siguiente reset;
#   - el commit ya está en GitHub;
#   - el build y los tests pasan (los tests nunca llaman al modelo real).
#
# El build se hace desde cero, así no quedan en `dist/` archivos que ya no
# existen en `src/`.
#
# Cada deploy deja un tag `deploy-AAAAMMDD-HHMM`. Para volver atrás:
#   git checkout deploy-AAAAMMDD-HHMM && ./deploy.sh
#   git checkout main          # para seguir trabajando después
#
# No toca `auth_sessions*/` ni `data/`: las sesiones de WhatsApp y los
# silencios sobreviven al deploy.

set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() {
    echo -e "${RED}❌ $1${NC}" >&2
    exit 1
}

echo "🚀 Deploy de IA Server"
echo "======================"
echo ""

# ─── 1. Árbol limpio ───
if [ -n "$(git status --porcelain)" ]; then
    git status --short
    fail "Hay cambios sin commitear o archivos sin trackear. Commitealos (o descartalos) y pushealos antes de desplegar."
fi

# ─── 2. El commit está en GitHub ───
echo "📥 Consultando GitHub..."
git fetch --quiet --tags origin

BRANCH=$(git symbolic-ref --quiet --short HEAD || true)
if [ -n "$BRANCH" ] && git rev-parse --quiet --verify '@{u}' >/dev/null; then
    BEHIND=$(git rev-list --count 'HEAD..@{u}')
    if [ "$BEHIND" -gt 0 ]; then
        echo "📥 $BRANCH está $BEHIND commit(s) atrás de GitHub, actualizando..."
        git pull --ff-only || fail "No se pudo actualizar $BRANCH sin merge. Resolvelo a mano."
    fi
fi

if [ -z "$(git branch -r --contains HEAD)" ]; then
    fail "El commit $(git rev-parse --short HEAD) no está en GitHub. Hacé git push antes de desplegar."
fi

COMMIT=$(git rev-parse --short HEAD)
ok "Commit $COMMIT (${BRANCH:-sin rama}) limpio y en GitHub"

# ─── 3. Dependencias ───
echo "📦 Instalando dependencias..."
pnpm install --frozen-lockfile
ok "Dependencias instaladas"

# ─── 4. Build desde cero, en un directorio aparte ───
# El proceso sigue corriendo con el `dist/` viejo hasta el reinicio: el nuevo
# se arma al costado y se cambia recién cuando compiló y pasaron los tests.
echo "🔨 Compilando..."
rm -rf dist.new
pnpm exec tsc --outDir dist.new
ok "Build listo"

# ─── 5. Tests ───
echo "🧪 Corriendo tests..."
if ! OPENROUTER_API_KEY= OPENROUTER_EVAL_API_KEY= pnpm exec jest --silent; then
    rm -rf dist.new
    fail "Fallaron los tests. No se desplegó nada."
fi
ok "Tests en verde"

rm -rf dist
mv dist.new dist

# ─── 6. Reinicio ───
echo "🔄 Reiniciando PM2..."

# Rotación de logs: PM2 no rota out_file/error_file por su cuenta.
# Sin esto, logs/pm2-out.log crece sin techo (llegó a 94 MB).
if ! sudo pm2 list | grep -q "pm2-logrotate"; then
    echo "🌀 Instalando pm2-logrotate..."
    sudo pm2 install pm2-logrotate
    sudo pm2 set pm2-logrotate:max_size 20M
    sudo pm2 set pm2-logrotate:retain 14
    sudo pm2 set pm2-logrotate:compress true
    sudo pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
    ok "Rotación de logs configurada"
fi

if sudo pm2 describe ia-server >/dev/null 2>&1; then
    sudo pm2 restart ia-server
else
    sudo pm2 start ecosystem.config.js
    sudo pm2 save
fi

# ─── 7. Verificación ───
echo "⏳ Esperando que arranque..."
sleep 15

STATUS=$(sudo pm2 jlist | node -e '
  const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const app = list.find((p) => p.name === "ia-server");
  process.stdout.write(app ? app.pm2_env.status : "missing");
')
if [ "$STATUS" != "online" ]; then
    sudo pm2 status ia-server || true
    fail "ia-server quedó en estado '$STATUS'. Revisá: sudo pm2 logs ia-server --lines 100"
fi

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]"' || true)
if curl -fsS --max-time 10 "http://localhost:${PORT:-4000}/health" >/dev/null; then
    ok "ia-server online y respondiendo /health"
else
    warn "ia-server está online pero /health no respondió todavía. Revisá los logs."
fi

# ─── 8. Tag para poder volver atrás ───
PREVIOUS=$(git tag -l 'deploy-*' --sort=-creatordate | head -1)
TAG="deploy-$(date +%Y%m%d-%H%M)"
if git tag "$TAG"; then
    git push --quiet origin "$TAG" || warn "No se pudo subir el tag $TAG a GitHub; quedó sólo local."
    ok "Tag $TAG"
else
    warn "No se pudo crear el tag $TAG."
fi

echo ""
echo -e "${GREEN}🎉 Deploy de $COMMIT completo${NC}"
echo ""
if [ -n "$PREVIOUS" ]; then
    echo "Volver al deploy anterior: git checkout $PREVIOUS && ./deploy.sh"
fi
echo "Logs:               sudo pm2 logs ia-server"
echo "Mensajes perdidos:  sudo pm2 logs ia-server --raw --nostream --lines 5000 | grep '\"event\":\"msg.dropped\"'"
echo "Silencios:          npx ts-node scripts/handoff-silences.ts delafonte list"
echo ""
