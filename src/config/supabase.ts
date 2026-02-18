import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import type { Database } from '../types/supabase';

export class SupabaseConfig {
  private static client: SupabaseClient<Database> | null = null;
  private static isInitialized = false;

  static initialize(supabaseUrl?: string, supabaseKey?: string): void {
    try {
      if (this.isInitialized) {
        logger.warn('Supabase: Already initialized');
        return;
      }

      const resolvedUrl = supabaseUrl || process.env.SUPABASE_URL || '';
      const resolvedKey = supabaseKey || process.env.SUPABASE_KEY || '';

      if (!resolvedUrl || !resolvedKey) {
        logger.warn('Supabase: URL or Key not provided, skipping initialization');
        return;
      }

      this.client = createClient<Database>(resolvedUrl, resolvedKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });

      this.isInitialized = true;
      logger.info('Supabase: Initialized successfully');
    } catch (error) {
      logger.error('Supabase: Initialization failed', { error });
      throw error;
    }
  }

  static getClient(): SupabaseClient<Database> {
    if (!this.client) {
      throw new Error('Supabase client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  static isReady(): boolean {
    return this.isInitialized && this.client !== null;
  }

  static async healthCheck(): Promise<boolean> {
    if (!this.isReady()) {
      return false;
    }

    try {
      // Simple query to check connection
      const { error } = await this.client!.from('businesses').select('count').limit(1);
      return !error;
    } catch (error) {
      logger.error('Supabase: Health check failed', { error });
      return false;
    }
  }
}
