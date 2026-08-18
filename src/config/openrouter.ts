import axios, { AxiosInstance } from 'axios';
import { EnvConfig } from '../types/index.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterConfig {
  private static instance: AxiosInstance;
  private static config: {
    apiKey: string;
    model: string;
    fallbackModels: string[];
    timeout: number;
    siteUrl?: string;
    siteName?: string;
  };

  static initialize(env: EnvConfig): void {
    this.config = {
      apiKey: env.openRouterApiKey,
      model: env.openRouterModel,
      fallbackModels: env.openRouterFallbackModels,
      timeout: env.openRouterTimeout,
      siteUrl: env.openRouterSiteUrl,
      siteName: env.openRouterSiteName,
    };

    this.instance = axios.create({
      baseURL: OPENROUTER_BASE_URL,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        // OpenRouter usa estos headers opcionales para atribución en su leaderboard;
        // no son obligatorios para que funcione la API.
        ...(this.config.siteUrl ? { 'HTTP-Referer': this.config.siteUrl } : {}),
        ...(this.config.siteName ? { 'X-Title': this.config.siteName } : {}),
      },
    });
  }

  static getClient(): AxiosInstance {
    if (!this.instance) {
      throw new Error('OpenRouter client not initialized. Call initialize() first.');
    }
    return this.instance;
  }

  static getModel(): string {
    if (!this.config) {
      throw new Error('OpenRouter config not initialized.');
    }
    return this.config.model;
  }

  static getFallbackModels(): string[] {
    if (!this.config) {
      throw new Error('OpenRouter config not initialized.');
    }
    return this.config.fallbackModels;
  }

  static getConfig() {
    return this.config;
  }

  static async healthCheck(): Promise<boolean> {
    try {
      const response = await this.instance.get('/models', { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }
}
