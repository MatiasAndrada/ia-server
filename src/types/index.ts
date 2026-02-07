// Request/Response Types
export interface ChatRequest {
  phone: string;
  message: string;
  businessId: string;
  context?: BusinessContext;
}

export interface ChatResponse {
  response: string;
  actions: Action[];
  confidence: number;
}

export interface IntentRequest {
  message: string;
  context?: Partial<BusinessContext>;
}

export interface IntentResponse {
  intent: IntentType;
  entities: Record<string, any>;
  confidence: number;
}

export interface BatchRequest {
  messages: Array<{
    phone: string;
    message: string;
    businessId: string;
    context?: BusinessContext;
  }>;
}

export interface BatchResponse {
  results: Array<{
    index: number;
    success: boolean;
    data?: ChatResponse;
    error?: string;
  }>;
  processedCount: number;
  failedCount: number;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  ollama: boolean;
  redis: boolean;
  model: string;
  uptime: number;
  timestamp: string;
}

// Action Types
export type ActionType = 
  | 'REGISTER' 
  | 'CHECK_STATUS' 
  | 'CONFIRM_ARRIVAL' 
  | 'CANCEL' 
  | 'INFO_REQUEST'
  | 'UNKNOWN';

export interface Action {
  type: ActionType;
  data: Record<string, any>;
  confidence?: number;
}

// Intent Types
export type IntentType =
  | 'register'
  | 'query_status'
  | 'confirm_arrival'
  | 'cancel'
  | 'request_info'
  | 'general_question'
  | 'greeting'
  | 'unknown';

// Business Context
export interface BusinessContext {
  businessName: string;
  businessAddress?: string;
  businessHours?: string;
  currentWaitlist: number;
  averageWaitTime: number;
  customerInfo?: CustomerInfo;
  additionalInfo?: Record<string, any>;
}

export interface CustomerInfo {
  isKnown: boolean;
  name?: string;
  previousVisits?: number;
  lastVisit?: string;
  preferences?: string[];
}

// Conversation Types
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ConversationHistory {
  phone: string;
  messages: ConversationMessage[];
  lastUpdated: number;
}

// Ollama Types
export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  };
}

export interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Error Types
export interface ApiError {
  code: string;
  message: string;
  details?: any;
}

// Cache Types
export interface CachedBusinessContext extends BusinessContext {
  cachedAt: number;
  expiresAt: number;
}

// Environment Variables
export interface EnvConfig {
  port: number;
  nodeEnv: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeout: number;
  apiKey: string;
  allowedOrigins: string[];
  redisUrl: string;
  logLevel: string;
}
