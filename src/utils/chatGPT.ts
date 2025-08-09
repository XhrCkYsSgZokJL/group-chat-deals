import { getLogger } from '@hopscotch-trading/js-commons-core/utils';
import OpenAI from 'openai';
import { assistantIds } from './constants';

const logger = getLogger('utils/chatGPT');

// OpenAI client and state
let chatGPT: OpenAI;
let initialized: boolean = false;
const assistants: { [id: string]: OpenAI.Beta.Assistant } = {};

// Initialize open ai client
export function initializeOpenAi(): void {
  if (!initialized) {
    logger.info('Initializing OpenAI');
    chatGPT = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    initialized = true;
  }
}

// Initialize and cache assistant
export async function initializeAssistant(name: keyof typeof assistantIds): Promise<void> {
  const assistantId = assistantIds[name];
  if (!assistants[assistantId]) {
    logger.info(`Initializing assistant ${name} ${assistantId}`);
    assistants[assistantId] = await chatGPT.beta.assistants.retrieve(assistantId);
  }
}

// Get cached assistant
export function getAssistant(name: keyof typeof assistantIds) {
  const assistantId = assistantIds[name];
  if (!assistants[assistantId]) {
    throw new Error(`Assistant ${name} not initialized`);
  }
  return assistants[assistantId];
}