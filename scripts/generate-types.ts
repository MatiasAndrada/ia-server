#!/usr/bin/env ts-node
/**
 * Generate TypeScript types from Supabase schema
 * Uses the service role key (no personal access token required)
 * 
 * Usage:
 *   ts-node scripts/generate-types.ts
 *   npm run types:generate
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
config();

async function generateTypes() {
  console.log('🚀 Starting type generation...\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in environment');
    process.exit(1);
  }

  console.log('📡 Connected to:', supabaseUrl);

  const tables = [
    'businesses',
    'customers', 
    'zones',
    'tables',
    'waitlist_entries'
  ];

  const client = createClient(supabaseUrl, supabaseKey);

  // Verificar conexión
  const { error: testError } = await client.from('businesses').select('id').limit(1);
  if (testError) {
    console.error('❌ Cannot connect to Supabase:', testError.message);
    process.exit(1);
  }

  console.log('✅ Connection verified\n');

  let typeDefinitions = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {\n`;

  for (const tableName of tables) {
    console.log(`📋 Processing table: ${tableName}`);
    
    try {
      // Obtener una fila de muestra para inferir la estructura
      const { data, error } = await client
        .from(tableName)
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(`   ❌ Error fetching ${tableName}:`, error.message);
        continue;
      }

      if (!data) {
        console.warn(`   ⚠️  Table ${tableName} is empty, using basic types`);
        continue;
      }

      // Generar tipos basados en la muestra
      const columns = Object.entries(data).map(([key, value]) => {
        let type = 'string';
        if (typeof value === 'number') type = 'number';
        else if (typeof value === 'boolean') type = 'boolean';
        else if (value === null) type = 'string | null';
        
        return { name: key, type, nullable: value === null };
      });

      // Generar definición Row
      typeDefinitions += `      ${tableName}: {
        Row: {\n`;
      
      for (const col of columns) {
        const nullable = col.nullable ? ' | null' : '';
        typeDefinitions += `          ${col.name}: ${col.type}${nullable}\n`;
      }

      typeDefinitions += `        }\n`;

      // Generar definición Insert (todos opcionales excepto los requeridos)
      typeDefinitions += `        Insert: {\n`;
      for (const col of columns) {
        const isOptional = col.name.includes('_at') || col.name === 'id' || col.nullable;
        const optional = isOptional ? '?' : '';
        const nullable = col.nullable ? ' | null' : '';
        typeDefinitions += `          ${col.name}${optional}: ${col.type}${nullable}\n`;
      }
      typeDefinitions += `        }\n`;

      // Generar definición Update (todos opcionales)
      typeDefinitions += `        Update: {\n`;
      for (const col of columns) {
        const nullable = col.nullable ? ' | null' : '';
        typeDefinitions += `          ${col.name}?: ${col.type}${nullable}\n`;
      }
      typeDefinitions += `        }
        Relationships: []
      }\n`;

      console.log(`   ✅ Generated ${columns.length} columns`);

    } catch (err) {
      console.error(`   ❌ Error processing ${tableName}:`, err);
    }
  }

  typeDefinitions += `    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (Database["public"]["Tables"] & Database["public"]["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
      Database["public"]["Views"])
  ? (Database["public"]["Tables"] &
      Database["public"]["Views"])[PublicTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof Database["public"]["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof Database["public"]["Enums"]
  ? Database["public"]["Enums"][PublicEnumNameOrOptions]
  : never
`;

  // Escribir archivo
  const outputPath = path.join(__dirname, '..', 'src', 'types', 'supabase.ts');
  fs.writeFileSync(outputPath, typeDefinitions, 'utf-8');

  console.log(`\n✅ Types generated successfully!`);
  console.log(`📄 Output: ${outputPath}`);
  console.log(`📊 Generated ${tables.length} table definitions\n`);
}

// Ejecutar
generateTypes().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
