// Script de prueba para verificar zonas disponibles
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function testZones() {
  try {
    console.log('\n🔍 Testing zone availability...\n');
    
    // Obtener el primer negocio
    const { data: businesses, error: bizError } = await supabase
      .from('businesses')
      .select('id, name')
      .limit(1);
    
    if (bizError) throw bizError;
    if (!businesses || businesses.length === 0) {
      console.log('❌ No businesses found');
      return;
    }
    
    const business = businesses[0];
    console.log(`📍 Business: ${business.name} (${business.id})\n`);
    
    // Obtener todas las zonas
    const { data: zones, error: zonesError } = await supabase
      .from('zones')
      .select('*')
      .eq('business_id', business.id);
    
    if (zonesError) throw zonesError;
    
    console.log(`📊 Total Zones: ${zones?.length || 0}`);
    zones?.forEach((zone, idx) => {
      console.log(`  ${idx + 1}. ${zone.name} (${zone.id})`);
    });
    
    // Obtener todas las mesas
    const { data: tables, error: tablesError } = await supabase
      .from('tables')
      .select('*')
      .eq('business_id', business.id);
    
    if (tablesError) throw tablesError;
    
    console.log(`\n🪑 Total Tables: ${tables?.length || 0}\n`);
    
    // Agrupar mesas por zona
    const tablesByZone = {};
    tables?.forEach(table => {
      if (!tablesByZone[table.zone_id]) {
        tablesByZone[table.zone_id] = [];
      }
      tablesByZone[table.zone_id].push(table);
    });
    
    // Mostrar mesas por zona
    zones?.forEach(zone => {
      const zoneTables = tablesByZone[zone.id] || [];
      console.log(`Zone: ${zone.name}`);
      console.log(`  Tables: ${zoneTables.length}`);
      zoneTables.forEach(table => {
        console.log(`    - Table ${table.table_number}: capacity ${table.capacity}, active: ${table.is_active}`);
      });
      console.log('');
    });
    
    // Simular búsqueda para 2 personas
    console.log('\n🎯 Simulating search for 2 people:\n');
    
    const availableZonesFor2 = new Map();
    
    zones?.forEach(zone => {
      const zoneTables = tablesByZone[zone.id] || [];
      const availableTables = zoneTables.filter(
        table => table.is_active && (!table.capacity || table.capacity >= 2)
      );
      
      console.log(`Zone "${zone.name}": ${availableTables.length} tables available for 2 people`);
      
      if (availableTables.length > 0) {
        availableZonesFor2.set(zone.name, {
          zoneId: zone.id,
          tables: availableTables
        });
      }
    });
    
    console.log(`\n✅ Available zones for 2 people: ${availableZonesFor2.size}`);
    console.log('Zone names:', Array.from(availableZonesFor2.keys()).join(', '));
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testZones().then(() => process.exit(0));
