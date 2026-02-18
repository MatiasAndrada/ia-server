import { AgentConfig, AgentListItem } from '../types';
import { waitlistAgent } from './waitlist.agent';
import { logger } from '../utils/logger';

/**
 * Registro centralizado de agentes disponibles
 */
class AgentRegistry {
  private agents: Map<string, AgentConfig>;

  constructor() {
    this.agents = new Map();
    this.registerDefaultAgents();
  }

  /**
   * Registra los agentes predeterminados del sistema
   */
  private registerDefaultAgents(): void {
    this.register(waitlistAgent);
    
    logger.info('Default agents registered', {
      count: this.agents.size,
      agents: Array.from(this.agents.keys())
    });
  }

  /**
   * Registra un nuevo agente en el sistema
   */
  register(agent: AgentConfig): void {
    if (this.agents.has(agent.id)) {
      logger.warn(`Agent ${agent.id} already registered, overwriting`);
    }
    
    this.agents.set(agent.id, agent);
    logger.info(`Agent registered: ${agent.id} - ${agent.name}`);
  }

  /**
   * Obtiene un agente por su ID
   */
  get(agentId: string): AgentConfig | undefined {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      logger.warn(`Agent not found: ${agentId}`);
      return undefined;
    }

    if (!agent.enabled) {
      logger.warn(`Agent disabled: ${agentId}`);
      return undefined;
    }

    return agent;
  }

  /**
   * Obtiene todos los agentes registrados
   */
  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /**
   * Obtiene lista simplificada de agentes para API
   */
  list(): AgentListItem[] {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled ?? true,
      actions: agent.actions?.map(a => ({
        type: a.type,
        description: a.description
      }))
    }));
  }

  /**
   * Verifica si un agente existe
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Elimina un agente del registro
   */
  unregister(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    if (deleted) {
      logger.info(`Agent unregistered: ${agentId}`);
    }
    return deleted;
  }

  /**
   * Habilita o deshabilita un agente
   */
  setEnabled(agentId: string, enabled: boolean): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }
    
    agent.enabled = enabled;
    logger.info(`Agent ${agentId} ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }
}

// Singleton del registro de agentes
export const agentRegistry = new AgentRegistry();

// Exports de conveniencia
export { waitlistAgent };
export type { AgentConfig, AgentListItem };
