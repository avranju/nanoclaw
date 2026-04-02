/**
 * Container Protocol: Provider-agnostic interface between host and agent containers
 */

export interface ContainerInput {
  /** User message or task to process */
  prompt: string;
  
  /** Session ID if continuing a conversation */
  sessionId?: string;
  
  /** Group folder name for isolation */
  groupFolder: string;
  
  /** Chat/JID identifier */
  chatJid: string;
  
  /** Whether this is the main control group (elevated privileges) */
  isMain: boolean;
  
  /** Whether this is a scheduled task */
  isScheduledTask?: boolean;
  
  /** Assistant name for messaging */
  assistantName?: string;
  
  /** Optional script to run */
  script?: string;
}

export interface ContainerOutput {
  /** Success or error status */
  status: 'success' | 'error';
  
  /** Result text (if success) */
  result: string | null;
  
  /** New session ID (if applicable) */
  newSessionId?: string;
  
  /** Error message (if error) */
  error?: string;
}

/** 
 * Output markers for robust streaming parsing
 * Container must wrap JSON output between these markers
 */
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Provider config format for /workspace/agent-config/provider.json
 */
export interface ProviderConfig {
  provider: string;  // 'claude' | 'openai' | 'custom'
  settings: Record<string, unknown>;  // Provider-specific settings
}
