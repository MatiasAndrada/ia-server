import { ReservationService } from '../src/services/reservation.service';
import { agentService } from '../src/services/agent.service';
import { agentRegistry } from '../src/agents';
import { SupabaseConfig } from '../src/config/supabase';
import * as dotenv from 'dotenv';

dotenv.config();

const BUSINESS_ID = '8361f000-d50c-4c9c-b5d7-1b9fd3b60838';
const TEST_PHONE = '5493532401540';
const CONVERSATION_ID = `${BUSINESS_ID}-${TEST_PHONE}`;

async function simulateReservationFlow() {
  try {
    console.log('\n🎭 Simulating Agent Response with Zone Context\n');
    console.log('='.repeat(70));
    
    // Initialize
    SupabaseConfig.initialize();
    const agent = agentRegistry.get('waitlist');
    
    if (!agent) {
      console.error('❌ Waitlist agent not found');
      return;
    }
    
    // Step: User provides party size - THE CRITICAL STEP
    console.log('\n📱 User message: "2" (for party size)');
    
    // Get available zones (what the handler does)
    console.log('\n🔍 Fetching available zones from database...');
    const zonesMap = await ReservationService.getAvailableZonesWithTables(
      BUSINESS_ID,
      2
    );
    
    const availableZones = Array.from(zonesMap.keys());
    const availableZonesFormatted = availableZones
      .map((zone, idx) => `${idx + 1}. ${zone}`)
      .join('\n');
    
    console.log(`\n📊 Database returned ${availableZones.length} zones`);
    console.log(`📋 Zones: ${availableZones.join(', ')}`);
    console.log(`\n📝 Formatted for agent:\n${availableZonesFormatted}`);
    
    // Generate agent response WITH zone context
    console.log('\n🤖 Calling agent with proper context...');
    const response = await agentService.generateResponse(
      '2',
      agent,
      CONVERSATION_ID,
      { 
        businessName: 'Restaurante del centro',
        currentStep: 'zone_selection',
        draftData: { 
          customerName: 'Matias Andrada',
          partySize: 2
        },
        availableZones: availableZones,
        availableZonesFormatted: availableZonesFormatted
      }
    );
    
    console.log('\n' + '='.repeat(70));
    console.log('🎯 AGENT RESPONSE (what user would receive):\n');
    console.log(response.response);
    console.log('\n' + '='.repeat(70));
    
    // Show what the CUSTOM message would be
    console.log('\n📨 CUSTOM MESSAGE (what SHOULD be sent instead):\n');
    if (availableZones.length === 1) {
      console.log(`Genial! Tenemos disponible la zona **${availableZones[0]}**. ¿Confirmas esta zona?`);
    } else {
      const zonesFormatted = availableZones
        .map((zone, idx) => `${idx + 1}. ${zone}`)
        .join('\n');
      console.log(`Perfecto! Tenemos las siguientes zonas disponibles:\n\n${zonesFormatted}\n\n¿Qué zona prefieres?`);
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('\n💡 ANALYSIS:\n');
    console.log(`   - Database has ${availableZones.length} zones available`);
    console.log(`   - Agent received context with ${availableZones.length} zones`);
    console.log(`   - Custom message SHOULD be sent (not agent response)`);
    console.log(`   - The handler should return TRUE to skip agent response\n`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

simulateReservationFlow()
  .then(() => {
    console.log('✅ Simulation complete\\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Simulation failed:', error);
    process.exit(1);
  });
