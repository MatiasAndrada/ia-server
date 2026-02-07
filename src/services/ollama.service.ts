import { OllamaConfig } from '../config/ollama';
import { OllamaMessage, OllamaRequest, OllamaResponse } from '../types';
import { logger } from '../utils/logger';
import { buildFallbackResponse } from '../utils/prompts';
import { AxiosError } from 'axios';

export class OllamaService {
  private maxRetries = 2;
  private retryDelay = 1000; // 1 second

  /**
   * Send a chat completion request to Ollama
   */
  async chat(
    messages: OllamaMessage[],
    systemPrompt?: string
  ): Promise<string> {
    const fullMessages: OllamaMessage[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.info(`Ollama request attempt ${attempt}/${this.maxRetries}`, {
          messageCount: fullMessages.length,
        });

        const response = await this.makeRequest(fullMessages);
        
        logger.info('Ollama response received', {
          length: response.length,
          attempt,
        });

        return response;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Ollama request failed (attempt ${attempt}/${this.maxRetries})`, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (attempt < this.maxRetries) {
          // Exponential backoff
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    logger.error('All Ollama request attempts failed', {
      error: lastError?.message,
      attempts: this.maxRetries,
    });

    // Return fallback response
    return buildFallbackResponse();
  }

  /**
   * Make the actual request to Ollama API
   */
  private async makeRequest(messages: OllamaMessage[]): Promise<string> {
    const client = OllamaConfig.getClient();
    const model = OllamaConfig.getModel();

    const request: OllamaRequest = {
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
      },
    };

    try {
      const response = await client.post<OllamaResponse>('/api/chat', request);

      if (!response.data || !response.data.message) {
        throw new Error('Invalid response format from Ollama');
      }

      return response.data.message.content;
    } catch (error) {
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Cannot connect to Ollama. Make sure Ollama is running.');
        }
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          throw new Error('Ollama request timed out.');
        }
        if (error.response?.status === 404) {
          throw new Error(`Model ${model} not found. Make sure it's downloaded.`);
        }
      }
      throw error;
    }
  }

  /**
   * Check if Ollama is available and responsive
   */
  async healthCheck(): Promise<{ available: boolean; model: string; error?: string }> {
    try {
      const isHealthy = await OllamaConfig.healthCheck();
      const model = OllamaConfig.getModel();

      if (!isHealthy) {
        return {
          available: false,
          model,
          error: 'Ollama service not responding',
        };
      }

      // Try a simple chat to verify model is available
      try {
        await this.makeRequest([
          { role: 'user', content: 'Hi' },
        ]);

        return {
          available: true,
          model,
        };
      } catch (error) {
        return {
          available: false,
          model,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    } catch (error) {
      return {
        available: false,
        model: OllamaConfig.getModel(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const ollamaService = new OllamaService();
