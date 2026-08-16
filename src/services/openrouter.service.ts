import { OpenRouterConfig } from '../config/openrouter';
import {
  LlmGenerationOptions,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  OpenRouterChatCompletionRequest,
  OpenRouterChatCompletionResponse,
} from '../types';
import { logger } from '../utils/logger';
import { buildBlockedDateReasonPrompt, buildFallbackResponse } from '../utils/prompts';
import { AxiosError } from 'axios';

const DEFAULT_GENERATION_OPTIONS: LlmGenerationOptions = {
  temperature: 0.7,
  top_p: 0.9,
  // Default cap so any call site that forgets to set this still can't have its
  // whole maxTokens budget silently eaten by reasoning (see LlmGenerationOptions).
  reasoningMaxTokens: 150,
};

export interface ChatWithActionsResult {
  content: string;
  toolCalls: LlmToolCall[];
  model: string;
}

export class OpenRouterService {
  private maxRetries = 2;
  private retryDelay = 500; // ms — OpenRouter's own `models` fallback already covers model-level failover

  /**
   * Send a chat completion request to OpenRouter and return the assistant's text.
   */
  async chat(
    messages: LlmMessage[],
    systemPrompt?: string,
    options?: LlmGenerationOptions
  ): Promise<string> {
    const result = await this.chatWithActions(messages, systemPrompt, undefined, options);
    return result.content;
  }

  /**
   * Send a chat completion request with optional tool definitions and return
   * both the assistant's text and any tool calls it made. Used to replace the
   * old [ACTION:tipo:{json}] text-marker convention with real tool calling.
   */
  async chatWithActions(
    messages: LlmMessage[],
    systemPrompt?: string,
    tools?: LlmToolDefinition[],
    options?: LlmGenerationOptions
  ): Promise<ChatWithActionsResult> {
    const fullMessages: LlmMessage[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.info(`OpenRouter request attempt ${attempt}/${this.maxRetries}`, {
          messageCount: fullMessages.length,
          hasTools: !!tools?.length,
        });

        const result = await this.makeRequest(fullMessages, tools, options);

        logger.info('OpenRouter response received', {
          length: result.content.length,
          toolCallCount: result.toolCalls.length,
          attempt,
          model: result.model,
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`OpenRouter request failed (attempt ${attempt}/${this.maxRetries})`, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay);
        }
      }
    }

    logger.error('All OpenRouter request attempts failed', {
      error: lastError?.message,
      attempts: this.maxRetries,
    });

    // Never let an AI outage break the request — degrade to a fallback
    // response with no tool calls, same resilience contract as before.
    return { content: buildFallbackResponse(), toolCalls: [], model: 'none' };
  }

  /**
   * Turn a short, informal closure reason (e.g. "duelo", "vacaciones") into a
   * professional, client-facing message explaining why the business isn't
   * taking reservations on a blocked date. Falls back to a generic-but-honest
   * message if OpenRouter is unavailable, so blocked-date creation never fails
   * because of the AI call.
   */
  async generateBlockedDateReasonMessage(
    reason: string,
    businessName?: string | null,
    businessType?: string | null
  ): Promise<string> {
    const trimmedReason = reason.trim();
    const name = businessName?.trim() || 'el local';

    try {
      const response = await this.chat(
        [{ role: 'user', content: `Motivo indicado por el dueño del negocio: "${trimmedReason}"` }],
        buildBlockedDateReasonPrompt(name, businessType),
        { temperature: 0.4, maxTokens: 350 }
      );

      const message = response.trim().replace(/^"|"$/g, '');
      if (!message || message.includes('problemas técnicos')) {
        throw new Error('OpenRouter returned an unusable response');
      }

      return message;
    } catch (error) {
      logger.warn('Failed to generate blocked-date reason message, using fallback', {
        error: error instanceof Error ? error.message : 'Unknown error',
        reason: trimmedReason,
      });

      return `${name} no estará tomando reservas en esta fecha debido a: ${trimmedReason}. Disculpá las molestias.`;
    }
  }

  /**
   * Make the actual request to OpenRouter's OpenAI-compatible /chat/completions endpoint
   */
  private async makeRequest(
    messages: LlmMessage[],
    tools?: LlmToolDefinition[],
    options?: LlmGenerationOptions
  ): Promise<ChatWithActionsResult> {
    const client = OpenRouterConfig.getClient();
    const model = OpenRouterConfig.getModel();
    const fallbackModels = OpenRouterConfig.getFallbackModels();
    const mergedOptions = { ...DEFAULT_GENERATION_OPTIONS, ...options };

    const request: OpenRouterChatCompletionRequest = {
      model,
      ...(fallbackModels.length > 0 ? { models: [model, ...fallbackModels] } : {}),
      messages,
      temperature: mergedOptions.temperature,
      top_p: mergedOptions.top_p,
      ...(mergedOptions.maxTokens ? { max_tokens: mergedOptions.maxTokens } : {}),
      ...(mergedOptions.reasoningMaxTokens
        ? { reasoning: { max_tokens: mergedOptions.reasoningMaxTokens } }
        : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    };

    try {
      const response = await client.post<OpenRouterChatCompletionResponse>(
        '/chat/completions',
        request
      );

      const choice = response.data?.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error('Invalid response format from OpenRouter');
      }

      if (choice.finish_reason === 'length') {
        logger.warn('OpenRouter response was truncated by max_tokens', {
          model: response.data.model,
          maxTokens: request.max_tokens,
          completionTokens: response.data.usage?.completion_tokens,
        });
      }

      if (response.data.model !== model) {
        logger.warn('OpenRouter served a fallback model instead of the primary model', {
          requested: model,
          served: response.data.model,
        });
      }

      return {
        content: choice.message.content ?? '',
        toolCalls: choice.message.tool_calls ?? [],
        model: response.data.model,
      };
    } catch (error) {
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNREFUSED') {
          throw new Error('Cannot connect to OpenRouter.');
        }
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
          throw new Error('OpenRouter request timed out.');
        }
        if (error.response?.status === 401) {
          throw new Error('OpenRouter authentication failed. Check OPENROUTER_API_KEY.');
        }
        if (error.response?.status === 404) {
          throw new Error(`Model ${model} not found on OpenRouter.`);
        }
        if (error.response?.data) {
          throw new Error(
            `OpenRouter error: ${JSON.stringify(error.response.data).slice(0, 300)}`
          );
        }
      }
      throw error;
    }
  }

  /**
   * Check if OpenRouter is reachable and the API key is valid
   */
  async healthCheck(): Promise<{ available: boolean; model: string; error?: string }> {
    const model = OpenRouterConfig.getModel();
    try {
      const isHealthy = await OpenRouterConfig.healthCheck();

      return {
        available: isHealthy,
        model,
        error: isHealthy ? undefined : 'OpenRouter API not responding',
      };
    } catch (error) {
      return {
        available: false,
        model,
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
export const openRouterService = new OpenRouterService();
