#!/usr/bin/env node

/**
 * 🚀 Cliente de prueba para WhatsApp
 * 
 * Este script conecta tu número de WhatsApp al servidor
 * y te permite probar el flujo completo de reservas.
 */

const io = require('socket.io-client');
const qrcode = require('qrcode-terminal');
const readline = require('readline');

// Configuración (tomada del .env)
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:4000';
const API_KEY = process.env.API_KEY || 'fccafbd66f81b937813e6c324abbb1cb6a6acaec1b02b3f62561a63c4b5c3a70';
const BUSINESS_ID = process.env.TEST_BUSINESS_ID || '134d829e-a1d8-417e-835a-11146b75de8b';

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  📱 Cliente de Prueba WhatsApp - IA Server               ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('📋 Configuración:');
console.log(`   Server: ${SERVER_URL}`);
console.log(`   Business ID: ${BUSINESS_ID}`);
console.log(`   API Key: ${API_KEY.substring(0, 20)}...\n`);

// Conectar al servidor vía Socket.IO
console.log('🔌 Conectando al servidor...\n');

const socket = io(SERVER_URL, {
  auth: {
    token: API_KEY,
  },
  query: {
    businessId: BUSINESS_ID,
  },
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
});

// Estado de la conexión
let isConnected = false;
let hasScannedQR = false;

// Eventos del socket
socket.on('connect', () => {
  console.log('✅ Conectado al servidor Socket.IO\n');
  console.log('📱 Iniciando sesión de WhatsApp...\n');
  
  // Solicitar inicio de sesión
  socket.emit('start_session');
});

socket.on('connect_error', (error) => {
  console.error('❌ Error de conexión:', error.message);
  console.log('\n💡 Asegúrate de que:');
  console.log('   1. El servidor esté corriendo (npm run dev)');
  console.log('   2. El API_KEY sea correcto');
  console.log('   3. El BUSINESS_ID exista en Supabase\n');
  process.exit(1);
});

socket.on('session_state', (data) => {
  console.log('📊 Estado de sesión:', data);
  if (data.isConnected) {
    isConnected = true;
    hasScannedQR = true;
    showConnectedMenu();
  }
});

socket.on('qr_generated', (data) => {
  console.log('\n═══════════════════════════════════════════════════════════\n');
  console.log('📷 ESCANEA ESTE CÓDIGO QR CON WHATSAPP:\n');
  console.log('   1. Abre WhatsApp en tu teléfono');
  console.log('   2. Toca Menú (⋮) o Configuración');
  console.log('   3. Toca "Dispositivos vinculados"');
  console.log('   4. Toca "Vincular un dispositivo"');
  console.log('   5. Escanea este código QR:\n');
  
  // Mostrar QR en la terminal
  qrcode.generate(data.qrCode, { small: true }, (qr) => {
    console.log(qr);
    console.log('\n═══════════════════════════════════════════════════════════\n');
  });
});

socket.on('session_ready', (data) => {
  console.log('\n✅ ¡WhatsApp conectado exitosamente!\n');
  console.log(`📱 Business: ${data.businessId}`);
  console.log(`💬 Mensaje: ${data.message}\n`);
  
  isConnected = true;
  hasScannedQR = true;
  
  showConnectedMenu();
});

socket.on('session_disconnected', (data) => {
  console.log('\n⚠️  WhatsApp desconectado');
  console.log(`   Business: ${data.businessId}\n`);
  isConnected = false;
  
  if (!hasScannedQR) {
    console.log('⏳ El servidor intentará reconectar en 3 segundos...');
    console.log('   Esperando nuevo código QR...\n');
    // No cerrar, esperar el nuevo QR
  } else {
    console.log('🔄 Para reconectar, ejecuta de nuevo este script.\n');
    process.exit(0);
  }
});

socket.on('session_error', (data) => {
  console.error('\n❌ Error en la sesión de WhatsApp:');
  console.error(`   ${data.error}\n`);
  
  if (data.error.includes('Max reconnection')) {
    console.log('💡 SOLUCIÓN:');
    console.log('   El servidor intentó reconectar varias veces sin éxito.');
    console.log('   Esto puede deberse a:');
    console.log('   1. Problema con la biblioteca de WhatsApp (Baileys)');
    console.log('   2. Sesión corrupta en auth_sessions/');
    console.log('   3. Restricciones de red o firewall\n');
    console.log('   Prueba:');
    console.log('   • Reiniciar el servidor');
    console.log('   • Eliminar: rm -rf auth_sessions/*');
    console.log('   • Ejecutar de nuevo este cliente\n');
  }
  
  process.exit(1);
});

socket.on('message_received', (data) => {
  console.log('\n📨 Mensaje recibido:');
  console.log(`   De: ${data.from}`);
  console.log(`   Mensaje: ${data.message}`);
  console.log(`   Business: ${data.businessId}\n`);
});

socket.on('disconnect', () => {
  console.log('\n🔌 Desconectado del servidor\n');
  process.exit(0);
});

// Menú interactivo cuando está conectado
function showConnectedMenu() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ WhatsApp Conectado - Listo para recibir mensajes     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  console.log('📱 CÓMO PROBAR EL FLUJO COMPLETO:\n');
  console.log('1. Desde OTRO teléfono, envía un WhatsApp al número conectado');
  console.log(`2. Business ID configurado: ${BUSINESS_ID}`);
  console.log('3. Envía un mensaje como: "Hola, quiero hacer una reserva"\n');
  
  console.log('💬 El bot debería responder automáticamente y guiarte por:');
  console.log('   • Solicitar tu nombre');
  console.log('   • Preguntar cuántas personas');
  console.log('   • Ofrecer zonas disponibles');
  console.log('   • Crear la reserva en Supabase\n');
  
  console.log('📊 MONITOREO:\n');
  console.log('   • Este cliente mostrará los mensajes recibidos');
  console.log('   • Los logs del servidor mostrarán el procesamiento completo');
  console.log('   • Puedes verificar la reserva en Supabase después\n');
  
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('💡 TIPS:');
  console.log('   • Mantén este cliente corriendo');
  console.log('   • Observa los logs del servidor (npm run dev)');
  console.log('   • Verifica las reservas: psql o Supabase Dashboard\n');
  
  console.log('🛑 Presiona Ctrl+C para desconectar\n');
  
  // Escuchar Ctrl+C para cerrar limpiamente
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Cerrando cliente...\n');
    socket.emit('stop_session');
    setTimeout(() => {
      console.log('✅ Cliente cerrado\n');
      process.exit(0);
    }, 1000);
  });
}

// Timeout de 3 minutos si no se conecta
setTimeout(() => {
  if (!hasScannedQR) {
    console.log('\n⏱️  Timeout: No se escaneó el código QR en 3 minutos\n');
    console.log('💡 Ejecuta el script de nuevo para obtener un nuevo QR\n');
    process.exit(0);
  }
}, 180000);
