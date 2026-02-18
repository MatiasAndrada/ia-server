/**
 * 🧪 SCRIPT DE PRUEBA MANUAL CON BUSINESS REAL
 * 
 * Este script te permite probar el flujo completo de reservas
 * usando los datos reales de tu Supabase.
 * 
 * CONFIGURACIÓN PREVIA:
 * 1. Copia .env y configura TEST_BUSINESS_ID con tu business UUID real
 * 2. Asegúrate de tener table_types creados en ese business
 * 3. Ejecuta: npm run test:manual
 */

import dotenv from 'dotenv';
import { ReservationService } from '../../services/reservation.service';
import { SupabaseService } from '../../services/supabase.service';
import { RedisConfig } from '../../config/redis';
import { SupabaseConfig } from '../../config/supabase';

dotenv.config();

const TEST_BUSINESS_ID = process.env.TEST_BUSINESS_ID;
const TEST_PHONE = process.env.TEST_PHONE || '+1234567890';

if (!TEST_BUSINESS_ID) {
  console.error('❌ ERROR: Debes configurar TEST_BUSINESS_ID en .env');
  console.error('   Ejemplo: TEST_BUSINESS_ID=550e8400-e29b-41d4-a716-446655440000');
  process.exit(1);
}

// Type assertion after validation
const BUSINESS_ID: string = TEST_BUSINESS_ID;

async function testFullReservationFlow() {
  console.log('\n🚀 Iniciando test del flujo completo de reservas...\n');

  try {
    // 1. Inicializar servicios
    console.log('📦 Inicializando servicios...');
    
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_KEY || '';
    
    await RedisConfig.initialize(redisUrl);
    SupabaseConfig.initialize(supabaseUrl, supabaseKey);

    console.log('✅ Servicios inicializados\n');

    // 2. Verificar business existe
    console.log(`🔍 Verificando business: ${BUSINESS_ID}`);
    const zones = await SupabaseService.getZonesByBusiness(BUSINESS_ID);
    const tables = await SupabaseService.getTablesByBusiness(BUSINESS_ID);

    console.log(`✅ Business encontrado`);
    console.log(`   📍 Zonas disponibles: ${zones.length > 0 ? zones.map(z => z.name).join(', ') : 'NINGUNA'}`);
    console.log(`   🪑 Mesas: ${tables.length}`);

    if (zones.length === 0) {
      console.error('\n❌ ERROR: El business no tiene zonas/mesas configuradas');
      console.error('   Debes crear zonas y mesas en Supabase primero.');
      console.error('\n📝 SQL de ejemplo:');
      console.error(`
        -- Crear zona
        INSERT INTO zones (business_id, name, priority)
        VALUES ('${BUSINESS_ID}', 'Interior', 1);
        
        -- Luego crear mesas en esa zona
        INSERT INTO tables (business_id, zone_id, table_number, capacity)
        VALUES 
          ('${BUSINESS_ID}', '<zone_id>', '1', 2),
          ('${BUSINESS_ID}', '<zone_id>', '2', 4),
          ('${BUSINESS_ID}', '<zone_id>', '3', 8);
      `);
      process.exit(1);
    }

    console.log('\n📋 Mesas disponibles:');
    tables.forEach((table: any, i: number) => {
      console.log(`   ${i + 1}. Mesa ${table.table_number} (${table.capacity} personas) - ${table.zone_id || 'N/A'}`);
    });

    // 3. Simular flujo de reserva completo
    const conversationId = `manual-test-${Date.now()}`;
    console.log(`\n💬 Iniciando flujo de reserva: ${conversationId}\n`);

    //PASO 1: Iniciar reserva
    console.log('📌 PASO 1: Iniciar reserva');
    await ReservationService.startReservation(conversationId, BUSINESS_ID);
    let draft = await ReservationService.getDraft(conversationId);
    console.log(`   ✅ Draft iniciado: step=${draft?.step}\n`);

    await sleep(500);

    // PASO 2: Establecer nombre
    console.log('📌 PASO 2: Recopilar nombre del cliente');
    await ReservationService.setCustomerName(conversationId, 'Carlos García');
    draft = await ReservationService.getDraft(conversationId);
    console.log(`   ✅ Nombre guardado: ${draft?.customerName}, step=${draft?.step}\n`);

    await sleep(500);

    // PASO 3: Establecer número de personas
    console.log('📌 PASO 3: Recopilar tamaño del grupo');
    await ReservationService.setPartySize(conversationId, 4);
    draft = await ReservationService.getDraft(conversationId);
    console.log(`   ✅ Party size guardado: ${draft?.partySize}, step=${draft?.step}\n`);

    await sleep(500);

    // PASO 4: Seleccionar zona
    const selectedZone = zones[0];
    console.log(`📌 PASO 4: Seleccionar zona: ${selectedZone.name}`);
    await ReservationService.selectZone(conversationId, selectedZone.name);
    draft = await ReservationService.getDraft(conversationId);
    console.log(`   ✅ Zona guardada: ${draft?.selectedZoneId}, step=${draft?.step}\n`);

    await sleep(500);

    // PASO 5: Crear reserva en Supabase
    console.log('📌 PASO 5: Crear reserva en Supabase');
    const result = await ReservationService.createReservation(conversationId, TEST_PHONE);
    
    if (!result.success || !result.waitlistEntry) {
      throw new Error(result.error || 'Failed to create reservation');
    }
    
    const waitlistEntry = result.waitlistEntry;
    console.log('\n✅ RESERVA CREADA EN SUPABASE:');
    console.log(`   🎫 Código: ${waitlistEntry.display_code}`);
    console.log(`   👥 Personas: ${waitlistEntry.party_size}`);
    console.log(`   📍 Tabla: ${waitlistEntry.table_id}`);
    console.log(`   📊 Estado: ${waitlistEntry.status}`);
    console.log(`   🆔 Customer ID: ${waitlistEntry.customer_id}`);
    console.log(`   📅 Creado: ${new Date(waitlistEntry.created_at || '').toLocaleString()}`);

    // Verificar que el draft se limpió automáticamente
    draft = await ReservationService.getDraft(conversationId);
    console.log(`\n🗑️  Draft limpiado automáticamente: ${draft === null ? 'SÍ ✅' : 'NO ❌'}\n`);

    console.log('✅ TEST COMPLETADO EXITOSAMENTE\n');

  } catch (error) {
    console.error('\n❌ ERROR EN EL TEST:');
    console.error(error);
    process.exit(1);
  } finally {
    await RedisConfig.disconnect();
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ejecutar test
testFullReservationFlow();
