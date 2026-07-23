#!/bin/bash

# IA Server Setup Script
# This script sets up the environment and dependencies for the IA server

set -e

echo "🚀 IA Server Setup"
echo "=================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Node.js is installed
echo "📦 Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js version must be 18 or higher (current: $(node -v))${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) found${NC}"

# Check if npm is installed
echo "📦 Checking npm..."
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✅ npm $(npm -v) found${NC}"

# Check if Redis is installed and running
echo "🔍 Checking Redis..."
if ! command -v redis-cli &> /dev/null; then
    echo -e "${YELLOW}⚠️  redis-cli not found${NC}"
    echo "Redis is recommended for conversation caching"
    echo "Install Redis: https://redis.io/download"
else
    echo -e "${GREEN}✅ Redis CLI found${NC}"
    
    # Try to ping Redis
    if redis-cli ping &> /dev/null; then
        echo -e "${GREEN}✅ Redis server is running${NC}"
    else
        echo -e "${YELLOW}⚠️  Redis server is not running${NC}"
        echo "Start Redis with: redis-server"
    fi
fi

# Check OpenRouter reachability (no local install needed — it's an external API)
echo "🤖 Checking OpenRouter..."
if curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models | grep -q "200"; then
    echo -e "${GREEN}✅ OpenRouter API is reachable${NC}"
else
    echo -e "${YELLOW}⚠️  Could not reach OpenRouter API (check your network connection)${NC}"
fi

if [ -f .env ] && grep -q "^OPENROUTER_API_KEY=.\+" .env; then
    echo -e "${GREEN}✅ OPENROUTER_API_KEY is set in .env${NC}"
else
    echo -e "${YELLOW}⚠️  OPENROUTER_API_KEY is not set — get one at https://openrouter.ai${NC}"
fi

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p logs
echo -e "${GREEN}✅ Logs directory created${NC}"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo -e "${GREEN}✅ .env file created${NC}"
    echo -e "${YELLOW}⚠️  Please edit .env and set your API_KEY and other variables${NC}"
else
    echo -e "${GREEN}✅ .env file already exists${NC}"
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

echo -e "${GREEN}✅ Build completed${NC}"

# Check if PM2 is installed globally
echo "🔍 Checking PM2..."
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}⚠️  PM2 is not installed globally${NC}"
    echo "Install PM2 with: npm install -g pm2"
    echo "Or use npm scripts: npm run dev or npm start"
else
    echo -e "${GREEN}✅ PM2 found${NC}"
fi

echo ""
echo -e "${GREEN}🎉 Setup completed successfully!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit .env file and set your API_KEY"
echo "2. Make sure Redis is running: redis-server"
echo "3. Make sure OPENROUTER_API_KEY is set in .env (get one at https://openrouter.ai)"
echo "4. Start in development mode: npm run dev"
echo "   OR"
echo "   Start with PM2: npm run pm2:start"
echo ""
echo "Test the server:"
echo "  curl http://localhost:4000/health"
echo ""
