import { OpenRouterConfig } from '../config/openrouter.js';
import {
  LlmGenerationOptions,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  OpenRouterChatCompletionRequest,
  OpenRouterChatCompletionResponse,
} from '../types/index.js';
import { logger, logEvent } from '../utils/logger.js';
import type { AiCallPurpose } from '../utils/log-events.js';
import { recordLlmCall } from '../utils/turn-stats.js';
import { buildBlockedDateReasonPrompt, buildFallbackResponse } from '../utils/prompts.js';
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
  /** Consumo informado por OpenRouter, cuando viene en la respuesta. */
  usage?: OpenRouterChatCompletionResponse['usage'];
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
    options?: LlmGenerationOptions,
    purpose: AiCallPurpose = 'agent'
  ): Promise<string> {
    const result = await this.chatWithActions(messages, systemPrompt, undefined, options, purpose);
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
    options?: LlmGenerationOptions,
    purpose: AiCallPurpose = 'agent'
  ): Promise<ChatWithActionsResult> {
    const fullMessages: LlmMessage[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        logger.debug('OpenRouter request', {
          purpose,
          attempt,
          messageCount: fullMessages.length,
          hasTools: !!tools?.length,
        });

        const result = await this.makeRequest(fullMessages, tools, options);
        const durationMs = Date.now() - startedAt;
        recordLlmCall(durationMs);

        // El evento que antes no existía: latencia y consumo por llamada. El
        // `usage` ya venía en la respuesta y sólo se leía dentro del warn de
        // truncamiento, así que no había forma de medir gasto ni lentitud.
        logEvent('info', 'ai.call', {
          purpose,
          model: result.model,
          durationMs,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          totalTokens: result.usage?.total_tokens,
          toolCalls: result.toolCalls.length,
          responseLength: result.content.length,
          ...(attempt > 1 && { attempt }),
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        recordLlmCall(Date.now() - startedAt);
        logger.debug('OpenRouter request failed, will retry', {
          purpose,
          attempt,
          maxRetries: this.maxRetries,
          error,
        });

        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay);
        }
      }
    }

    logEvent('error', 'ai.failed', {
      purpose,
      attempts: this.maxRetries,
      error: lastError,
    });

    // Never let an AI outage break the request — degrade to a fallback
    // response with no tool calls, same resilience contract as before.
    logEvent('warn', 'ai.degraded', { purpose });
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
        { temperature: 0.4, maxTokens: 350 },
        'blocked_date_reason'
      );

      const message = response.trim().replace(/^"|"$/g, '');
      if (!message || message.includes('problemas técnicos')) {
        throw new Error('OpenRouter returned an unusable response');
      }

      return message;
    } catch (error) {
      logger.warn('Failed to generate blocked-date reason message, using fallback', {
        error,
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
        logger.debug('OpenRouter response was truncated by max_tokens', {
          model: response.data.model,
          maxTokens: request.max_tokens,
          completionTokens: response.data.usage?.completion_tokens,
        });
      }

      if (response.data.model !== model) {
        logEvent('warn', 'ai.fallback_model', {
          requested: model,
          served: response.data.model,
        });
      }

      return {
        content: choice.message.content ?? '',
        toolCalls: choice.message.tool_calls ?? [],
        model: response.data.model,
        usage: response.data.usage,
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
