import { Request, Response } from 'express';
import { ChatRequest, ChatResponse, BatchRequest, BatchResponse, LlmMessage } from '../types/index.js';
import { openRouterService } from '../services/openrouter.service.js';
import { conversationService } from '../services/conversation.service.js';
import { intentService } from '../services/intent.service.js';
import { buildSystemPrompt } from '../utils/prompts.js';
import { buildActionTool, parseToolCallActions, calculateConfidence, cleanResponseText } from '../utils/actions.js';
import { logger } from '../utils/logger.js';

/**
 * POST /api/chat
 * Process a chat message with AI
 */
export async function chatHandler(req: Request, res: Response) {
  const startTime = Date.now();
  
  try {
    const { phone, message, businessId, context }: ChatRequest = req.body;

    logger.debug('Processing chat request', {
      phone,
      businessId,
      messageLength: message.length,
    });

    // Get conversation history
    const history = await conversationService.getHistory(phone);

    // Build system prompt with business context
    const systemPrompt = buildSystemPrompt(context);

    // Build messages array for the LLM
    const llmMessages: LlmMessage[] = [
      ...history.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      {
        role: 'user' as const,
        content: message,
      },
    ];

    // Get AI response — actions come back as native tool calls, not a text marker
    const { content: aiResponse, toolCalls } = await openRouterService.chatWithActions(
      llmMessages,
      systemPrompt,
      [buildActionTool()],
      undefined,
      'agent'
    );

    // Parse actions from tool calls (schema-validated, not regex-guessed)
    const actions = parseToolCallActions(toolCalls);

    // Clean response text (defensive: strips any stray legacy markers)
    const cleanResponse = cleanResponseText(aiResponse);

    // Calculate confidence
    const confidence = calculateConfidence(cleanResponse, actions);

    // Save conversation history
    await conversationService.addMessage(phone, 'user', message);
    await conversationService.addMessage(phone, 'assistant', cleanResponse);

    const duration = Date.now() - startTime;

    logger.debug('Chat request completed', {
      phone,
      businessId,
      actionsCount: actions.length,
      confidence,
      duration: `${duration}ms`,
    });

    const response: ChatResponse = {
      response: cleanResponse,
      actions,
      confidence,
    };

    res.json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Chat request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process chat message',
    });
  }
}

/**
 * POST /api/analyze-intent
 * Analyze message intent
 */
export async function analyzeIntentHandler(req: Request, res: Response) {
  try {
    const { message, context } = req.body;

    logger.debug('Analyzing intent', {
      messageLength: message.length,
      hasContext: !!context,
    });

    const result = await intentService.analyzeIntent(message, context);

    logger.debug('Intent analysis completed', {
      intent: result.intent,
      confidence: result.confidence,
    });

    res.json(result);
  } catch (error) {
    logger.error('Intent analysis failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to analyze intent',
    });
  }
}

/**
 * DELETE /api/conversations/:phone
 * Clear conversation history
 */
export async function clearConversationHandler(req: Request, res: Response) {
  try {
    const { phone } = req.params;

    logger.debug('Clearing conversation', { phone });

    const cleared = await conversationService.clearHistory(phone);

    if (cleared) {
      logger.debug('Conversation cleared', { phone });
      res.status(204).send();
    } else {
      logger.debug('No conversation found to clear', { phone });
      res.status(404).json({
        error: 'Not Found',
        message: 'No conversation history found for this phone number',
      });
    }
  } catch (error) {
    logger.error('Failed to clear conversation', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to clear conversation',
    });
  }
}

/**
 * POST /api/batch
 * Process multiple messages in batch
 */
export async function batchHandler(req: Request, res: Response) {
  const startTime = Date.now();
  
  try {
    const { messages }: BatchRequest = req.body;

    logger.debug('Processing batch request', {
      count: messages.length,
    });

    // Process all messages in parallel
    const results = await Promise.allSettled(
      messages.map(async (msg, index) => {
        try {
          // Get conversation history
          const history = await conversationService.getHistory(msg.phone);

          // Build system prompt
          const systemPrompt = buildSystemPrompt(msg.context);

          // Build messages array
          const llmMessages: LlmMessage[] = [
            ...history.map((h) => ({
              role: h.role as 'user' | 'assistant',
              content: h.content,
            })),
            {
              role: 'user' as const,
              content: msg.message,
            },
          ];

          // Get AI response — actions come back as native tool calls
          const { content: aiResponse, toolCalls } = await openRouterService.chatWithActions(
            llmMessages,
            systemPrompt,
            [buildActionTool()],
            undefined,
            'agent'
          );

          // Parse actions from tool calls
          const actions = parseToolCallActions(toolCalls);

          // Clean response
          const cleanResponse = cleanResponseText(aiResponse);

          // Calculate confidence
          const confidence = calculateConfidence(cleanResponse, actions);

          // Save to history
          await conversationService.addMessage(msg.phone, 'user', msg.message);
          await conversationService.addMessage(msg.phone, 'assistant', cleanResponse);

          return {
            index,
            success: true,
            data: {
              response: cleanResponse,
              actions,
              confidence,
            } as ChatResponse,
          };
        } catch (error) {
          logger.error('Batch item failed', {
            index,
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          return {
            index,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      })
    );

    // Transform results
    const processedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          index,
          success: false,
          error: result.reason?.message || 'Unknown error',
        };
      }
    });

    const successCount = processedResults.filter((r) => r.success).length;
    const failedCount = processedResults.length - successCount;

    const duration = Date.now() - startTime;

    logger.debug('Batch request completed', {
      total: messages.length,
      successful: successCount,
      failed: failedCount,
      duration: `${duration}ms`,
    });

    const response: BatchResponse = {
      results: processedResults,
      processedCount: successCount,
      failedCount,
    };

    res.json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Batch request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: `${duration}ms`,
    });

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process batch request',
    });
  }
}
