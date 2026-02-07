import axios, { AxiosInstance } from 'axios';
import { EnvConfig } from '../types';

export class OllamaConfig {
  private static instance: AxiosInstance;
  private static config: {
    baseUrl: string;
    model: string;
    timeout: number;
  };

  static initialize(env: EnvConfig): void {
    this.config = {
      baseUrl: env.ollamaBaseUrl,
      model: env.ollamaModel,
      timeout: env.ollamaTimeout,
    };

    this.instance = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  static getClient(): AxiosInstance {
    if (!this.instance) {
      throw new Error('Ollama client not initialized. Call initialize() first.');
    }
    return this.instance;
  }

  static getModel(): string {
    if (!this.config) {
      throw new Error('Ollama config not initialized.');
    }
    return this.config.model;
  }

  static getConfig() {
    return this.config;
  }

  static async healthCheck(): Promise<boolean> {
    try {
      const response = await this.instance.get('/api/tags', {
        timeout: 5000,
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }
}
