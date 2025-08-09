import { type GroupUpdated } from "@xmtp/content-type-group-updated";
import { Reaction, ReactionCodec } from "@xmtp/content-type-reaction";
import { Attachment, AttachmentCodec, RemoteAttachment, RemoteAttachmentCodec } from "@xmtp/content-type-remote-attachment";
import { Client, type DecodedMessage, type XmtpEnv } from "@xmtp/node-sdk";
import { createSigner, getEncryptionKeyFromHex } from './utils/xmtp';
import { Reply, ReplyCodec } from "@xmtp/content-type-reply";

// Types and interfaces
export interface WorkerConfig {
  name: string;
  walletKey: string;
  encryptionKey: string;
  xmtpEnv: XmtpEnv;
}

type AllContentTypes = string | GroupUpdated | Attachment | RemoteAttachment | Reaction | Reply;

export interface WorkerInstance {
  name: string;
  address: string;
  inboxId: string;
  client: Client<AllContentTypes>;
  messageStream?: AsyncIterable<DecodedMessage>;
  isTerminated: boolean;
}

// XMTP worker manager
export class XmtpWorkerManager {
  private workers: Record<string, WorkerInstance> = {};
  private activeWorkers: WorkerInstance[] = [];
  private xmtpEnv: XmtpEnv;

  constructor(xmtpEnv: XmtpEnv) {
    this.xmtpEnv = xmtpEnv;
  }

  get(name: string): WorkerInstance | undefined {
    return this.workers[name];
  }

  // Create multiple workers
  async createWorkers(configs: WorkerConfig[]): Promise<WorkerInstance[]> {
    return Promise.all(configs.map(config => this.createWorker(config)));
  }

  // Create single worker with XMTP client
  async createWorker(config: WorkerConfig): Promise<WorkerInstance> {
    console.log(`Creating worker: ${config.name}`);

    const signer = createSigner(config.walletKey);
    const dbEncryptionKey = getEncryptionKeyFromHex(config.encryptionKey);

    const client = await Client.create(signer, {
      dbEncryptionKey,
      env: config.xmtpEnv,
      codecs: [
        new AttachmentCodec(), 
        new RemoteAttachmentCodec(),
        new ReactionCodec(),
        new ReplyCodec()
      ],
    });

    const identifier = await signer.getIdentifier();
    const address = identifier.identifier;

    console.log(`✓ Worker ${config.name} created: ${address} (${client.inboxId})`);

    const worker: WorkerInstance = {
      name: config.name,
      address,
      inboxId: client.inboxId,
      client,
      isTerminated: false,
    };

    this.workers[config.name] = worker;
    this.activeWorkers.push(worker);

    return worker;
  }

  // Start message streaming for worker
  async startMessageStream(
    name: string,
    messageHandler: (worker: WorkerInstance, message: DecodedMessage) => Promise<void>
  ): Promise<void> {
    const worker = this.get(name);
    if (!worker) {
      throw new Error(`Worker ${name} not found`);
    }

    console.log(`✓ Syncing conversations for ${name}...`);
    await worker.client.conversations.sync();

    console.log(`✓ Starting message stream for ${name}...`);
    const stream = await worker.client.conversations.streamAllMessages();
    worker.messageStream = stream as unknown as AsyncIterable<DecodedMessage>;

    // Process messages in background
    this.processMessages(worker, messageHandler).catch((error: unknown) => {
      console.error(`Error in message stream for ${name}:`, error);
    });
  }

  // Process messages from worker stream
  private async processMessages(
    worker: WorkerInstance,
    messageHandler: (worker: WorkerInstance, message: DecodedMessage) => Promise<void>
  ): Promise<void> {
    if (!worker.messageStream) {
      console.error(`No message stream available for ${worker.name}`);
      return;
    }

    try {
      for await (const message of worker.messageStream) {
        if (worker.isTerminated) break;

        // Skip self messages
        if (message.senderInboxId.toLowerCase() === worker.client.inboxId.toLowerCase()) {
          continue;
        }

        await messageHandler(worker, message);
      }
    } catch (error) {
      if (!worker.isTerminated) {
        console.error(`Stream error for ${worker.name}:`, error);
      }
    }
  }

  // Terminate all workers
  async terminateAll(): Promise<void> {
    console.log("Terminating all workers...");

    for (const worker of this.activeWorkers) {
      worker.isTerminated = true;
      
      // Close stream if possible
      if (worker.messageStream && "return" in worker.messageStream) {
        try {
          const stream = worker.messageStream as AsyncIterable<DecodedMessage> & {
            return?: () => Promise<unknown>;
          };
          if (stream.return) await stream.return();
        } catch (error) {
          console.error(`Error closing stream for ${worker.name}:`, error);
        }
      }
    }

    this.activeWorkers = [];
    this.workers = {};
    console.log("All workers terminated");
  }
}

// Helper function to create WorkerManager with initialized workers
export async function createXmtpWorkers(configs: WorkerConfig[]): Promise<XmtpWorkerManager> {
  const manager = new XmtpWorkerManager(configs[0]?.xmtpEnv);
  await manager.createWorkers(configs);
  return manager;
}