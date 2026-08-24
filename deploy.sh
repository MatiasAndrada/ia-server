#!/bin/bash

# Deploy script for production environment

set -e

echo "🚀 Deploying IA Server to Production"
echo "====================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Pull latest changes (if using git)
if [ -d .git ]; then
    echo "📥 Pulling latest changes..."
    git pull
    echo -e "${GREEN}✅ Code updated${NC}"
fi

# Install/update dependencies
echo "📦 Installing dependencies..."
npm install --production

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Build TypeScript
echo "🔨 Building project..."
npm run build

echo -e "${GREEN}✅ Build completed${NC}"

# Restart PM2
if command -v pm2 &> /dev/null; then
    echo "🔄 Restarting PM2..."
    
    # Rotación de logs: PM2 no rota out_file/error_file por su cuenta.
    # Sin esto, logs/pm2-out.log crece sin techo (llegó a 94 MB).
    if ! pm2 list | grep -q "pm2-logrotate"; then
        echo "🌀 Installing pm2-logrotate..."
        pm2 install pm2-logrotate
        pm2 set pm2-logrotate:max_size 20M
        pm2 set pm2-logrotate:retain 14
        pm2 set pm2-logrotate:compress true
        pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
        echo -e "${GREEN}✅ Log rotation configured${NC}"
    fi

    if pm2 list | grep -q "ia-server"; then
        pm2 restart ia-server
        echo -e "${GREEN}✅ Server restarted${NC}"
    else
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✅ Server started${NC}"
    fi
    
    # Show status
    pm2 status ia-server
else
    echo -e "${YELLOW}⚠️  PM2 not found. Install with: npm install -g pm2${NC}"
    echo "Starting server with node..."
    npm start
fi

echo ""
echo -e "${GREEN}🎉 Deployment completed!${NC}"
echo ""
echo "Monitor logs with: pm2 logs ia-server"
echo "Filter by event:   pm2 logs ia-server --raw | grep '\"event\":\"turn.completed\"'"
echo "Check status with: pm2 status"
echo ""
