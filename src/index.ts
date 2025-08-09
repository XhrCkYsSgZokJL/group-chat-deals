import type { XmtpEnv } from "@xmtp/node-sdk";
import { initializeAssistant, initializeOpenAi } from "utils/chatGPT";
import { createXmtpWorkers, type WorkerConfig } from "./workers";
import dealHandler from "bots/deal";
import { injectSecrets } from './utils/secrets';
import { getLogger } from "@hopscotch-trading/js-commons-core/utils";
import { generateEncryptionKeyHex } from "utils/xmtp";

const logger = getLogger('main');
let workers: any;

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down...`);
  
  try {
    if (workers) await workers.terminateAll();
  } catch (error) {
    logger.error('Error during shutdown:', error);
  }
  
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main(): Promise<void> {
  logger.info('Starting Hopscotch XMTP Bot Application');
  
  try {
    // Initialize secrets and validate environment
    await injectSecrets();
    logger.info('Encryption key: %s', generateEncryptionKeyHex());

    const requiredVars = [
      'AWS_REGION',
      'AWS_BUCKET_CHATGPT',
      'AWS_BUCKET_CONTENT',
      'HS_ENV',
      'WALLET_PRIVATE_KEY_DEAL',
      'WALLET_ENCRYPTION_KEY_DEAL',
    ];
    
    const missingVars = requiredVars.filter(key => !process.env[key]?.trim());
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    // Initialize ai components
    await Promise.all([
      initializeOpenAi(),
      initializeAssistant('deal')
    ]);

    // Create and start xmtp workers
    const xmtpEnv: XmtpEnv = 'production';
    const workerConfigs: WorkerConfig[] = [{
      name: "deal",
      walletKey: process.env.WALLET_PRIVATE_KEY_DEAL!,
      encryptionKey: process.env.WALLET_ENCRYPTION_KEY_DEAL!,
      xmtpEnv
    }];
    
    workers = await createXmtpWorkers(workerConfigs);
    await workers.startMessageStream("deal", dealHandler);
    
    logger.info('Application initialized and listening for messages');

    // Keep process alive
    await new Promise<void>(() => {});

  } catch (error) {
    logger.error('Critical error during initialization:', error);
    logger.info(error);
    await gracefulShutdown('INIT_FAILURE');
  }
}

// Start the application
main().catch((error) => {
  logger.error('FATAL: Uncaught error from main function:', error);
  process.exit(1);
});