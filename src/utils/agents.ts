// Updated agents utilities for deal agent - FIXED message chain processing
import { GetObjectCommand, PutObjectCommandInput, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getHopscotchEnv } from '@hopscotch-trading/js-commons-core/lang';
import { InSeconds, getLogger, sleep } from '@hopscotch-trading/js-commons-core/utils';
import { AppDB } from '@hopscotch-trading/js-commons-data';
import {
    ContentTypeReaction,
    Reaction,
} from "@xmtp/content-type-reaction";
import {
    Attachment,
    ContentTypeAttachment,
    ContentTypeRemoteAttachment,
    RemoteAttachmentCodec,
    type RemoteAttachment, 
} from "@xmtp/content-type-remote-attachment";
import { ContentTypeReply, Reply } from '@xmtp/content-type-reply';
import { ContentTypeText } from '@xmtp/content-type-text';
import { DecodedMessage } from '@xmtp/node-sdk';
import { v4 } from 'uuid';
import { WorkerInstance } from 'workers';

const logger = getLogger('agent-helpers');

const s3Client = new S3Client({
  region: process.env.AWS_REGION
});

// Shared types for deal agent
export type ConversationState = {
  address: string;
  image?: DecodedMessage<any>;
  imageMessageId?: string;
  textHistory: string[];
  chatGptImageUrl?: string;
  permanentImageUrl?: string;
  publishableListingId?: string;
  generatedListingKey?: string;
  lastActivity: number;
};

export type ListingData = {
  title?: string;
  description?: string;
  priceValue?: string;
  priceAsset?: string;
  inventory?: number;
  pickupZip?: string;
  deliverable?: boolean;
};

export type ConversationImageCache = {
  image: DecodedMessage<RemoteAttachment | Attachment>;
  uploadedBy: string;
  timestamp: number;
  timeout?: NodeJS.Timeout;
};

// Global cache and storage for deal agent
export const conversationImageCache = new Map<string, ConversationImageCache>();
export const publishableListings = new Map<string, ListingData>();
export const CACHE_TIMEOUT_MS = 60 * 1000;

/**
 * Get message context including conversation, address, and DM status
 */
export async function getMessageContext(worker: WorkerInstance, message: DecodedMessage) {
  try {
    const conversation = await worker.client.conversations.getConversationById(message.conversationId);
    if (!conversation) {
      logger.error(`[${worker.name}] Unable to find conversation ${message.conversationId}`);
      return null;
    }

    const inboxState = await worker.client.preferences.inboxStateFromInboxIds([message.senderInboxId]);
    const address = inboxState[0]?.identifiers[0]?.identifier || '';
    if (!address) {
      logger.error(`[${worker.name}] Unable to resolve address for inbox ${message.senderInboxId}`);
      return null;
    }

    let isDM = true;
    try {
      const members = await conversation.members();
      isDM = members.length <= 2;
      logger.debug(`[${worker.name}] Conversation has ${members.length} members, isDM: ${isDM}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[${worker.name}] Failed to get conversation members, defaulting to DM: ${errorMsg}`);
    }

    const userKey = `${message.conversationId}:${address}`;
    return { conversation, address, isDM, userKey };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${worker.name}] Error getting message context: ${errorMsg}`);
    return null;
  }
}

/**
 * Validate user has a store on Hopscotch
 */
export async function validateUser(address: string) {
  try {
    logger.debug(`[agent-helpers] Validating user ${address}`);
    
    address = "0xF69c8B1261b38352eAd7B91421dA38F5fd261EC9";

    const user = await AppDB.getUserByWallet(address);
    if (!user) {
      logger.debug(`[agent-helpers] No user found for address ${address}`);
      return null;
    }

    const merchant = await AppDB.getMerchantByUserId(user.did as string);
    if (!merchant) {
      logger.debug(`[agent-helpers] No merchant found for user ${user.did}`);
      return null;
    }

    logger.debug(`[agent-helpers] User ${address} validated with merchant ${merchant.merchantId}`);
    return { user, merchant };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-helpers] Error validating user ${address}: ${errorMsg}`);
    return null;
  }
}

/**
 * Unified message processing logic for deal agent only
 */
export async function processMessage(
  message: DecodedMessage, 
  isDM: boolean, 
  conversation: any, 
  worker: WorkerInstance,
  agentName: string,
  conversationStates?: Map<string, ConversationState>,
  publishableListings?: Map<string, ListingData>
): Promise<{ process: boolean; reason: string }> {
  // For reactions, check if they're valid for our context (deal agent only)
  if (isReactionMessage(message)) {
    const reaction = message.content as Reaction;
    
    // Normalize reaction content to handle different formats
    let normalizedContent = reaction.content;
    if (reaction.content === '-1' || reaction.content === '👎') {
      normalizedContent = '👎';
    } else if (reaction.content === '+1' || reaction.content === '👍') {
      normalizedContent = '👍';
    }
    
    logger.debug(`[${agentName}] Detected reaction message: action=${reaction.action}, content=${reaction.content} (normalized: ${normalizedContent}), reference=${reaction.reference}`);
    
    if (reaction.action !== 'added') {
      return { process: false, reason: "Ignoring reaction removal" };
    }

    // Allow reset reactions (👎) to be processed
    if (normalizedContent === '👎') {
        logger.debug(`[${agentName}] Reset reaction detected - will be processed for authorization check`);
        return { process: true, reason: "Processing reset reaction" };
    }

    // Allow publish reactions (👍) to be processed  
    if (normalizedContent === '👍') {
        logger.debug(`[${agentName}] Publish reaction detected - checking for listing data`);
        
        // Check if this reaction reference has publishable listing data
        const hasListingData = publishableListings?.has(reaction.reference) ?? false;
        
        logger.debug(`[${agentName}] Reaction reference check: reference=${reaction.reference}, hasListingData=${hasListingData}`);
        
        if (hasListingData) {
          return { process: true, reason: "Processing publish reaction to bot message" };
        } else {
          return { process: false, reason: "Ignoring publish reaction to non-bot message" };
        }
    }
    
    // Ignore all other reaction types
    return { process: false, reason: `Ignoring unsupported reaction: ${normalizedContent}` };
  }

  // Deal agent only works in groups - reject DMs
  if (isDM) {
    return { process: false, reason: "Deal agent only works in group chats" };
  }

  // For groups, only process tagged messages with @deal
  if (isTextMessage(message)) {
    const text = extractTextContent(message);
    const isTagged = isTaggedMessage(text, agentName);
    
    if (isTagged) {
      return { process: true, reason: "Processing tagged group text message" };
    } else {
      return { process: false, reason: "Ignoring untagged group text message" };
    }
  }

  // For reply messages in groups
  if (isReplyMessage(message)) {
    const replyContent = message.content as Reply;
    const text = replyContent.content || '';
    const isTagged = typeof text === 'string' && isTaggedMessage(text, agentName);
    
    if (isTagged) {
      return { process: true, reason: "Processing tagged group reply message" };
    }
    
    // Check if this is a reply to a bot message
    const isReplyToBot = await isReplyToBotMessage(conversation, replyContent.reference, worker, agentName);
    if (isReplyToBot) {
      return { process: true, reason: "Processing reply to bot message in group" };
    }
    
    return { process: false, reason: "Ignoring untagged reply to non-bot message in group" };
  }

    if (isImageMessage(message)) {
        return { process: true, reason: "Processing image message in a group" };
    }

  return { process: false, reason: "Ignoring unsupported message type" };
}

/**
 * FIXED: Gather message chain by following reply references
 */
export async function gatherMessageChain(
  conversation: any,
  message: DecodedMessage,
  worker: WorkerInstance
): Promise<DecodedMessage[]> {
  const chain: DecodedMessage[] = [message];
  let currentMessage = message;
  
  // Follow reply chain backwards to get full context
  while (isReplyMessage(currentMessage)) {
    try {
      const replyContent = currentMessage.content as Reply;
      
      // FIXED: Get conversation messages (this is an async method)
      const messages = await conversation.messages({ limit: 100 });
      const referencedMessage = messages.find((m: DecodedMessage) => m.id === replyContent.reference);
      
      if (referencedMessage) {
        chain.unshift(referencedMessage);
        currentMessage = referencedMessage;
        logger.debug(`[agent-helpers] Found referenced message ${referencedMessage.id.substring(0, 8)} in reply chain`);
      } else {
        logger.debug(`[agent-helpers] Referenced message ${replyContent.reference.substring(0, 8)} not found in recent messages`);
        break;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[agent-helpers] Failed to follow reply chain: ${errorMsg}`);
      break;
    }
  }
  
  logger.debug(`[agent-helpers] Gathered message chain of length: ${chain.length}`);
  return chain;
}

/**
 * FIXED: Extract content from message chain for deal agent
 */
export async function extractContentFromChain(
  messageChain: DecodedMessage[],
  worker: WorkerInstance,
  agentName: string
): Promise<{ image: DecodedMessage<any> | undefined; textContent: string }> {
  let image: DecodedMessage<any> | undefined;
  const textParts: string[] = [];
  
  // Process chain from oldest to newest
  for (const msg of messageChain) {
    if (isImageMessage(msg)) {
      image = msg; // Use the most recent image
      logger.debug(`[${agentName}] Found image in chain: ${msg.id}`);
      
      // For deal agent, we don't analyze images - just use them directly
      // Image analysis is handled elsewhere if needed
    } else if (isTextMessage(msg)) {
      const text = extractTextContent(msg);
      if (text.trim()) {
        textParts.push(text);
      }
    } else if (isReplyMessage(msg)) {
      const replyContent = msg.content as Reply;
      if (typeof replyContent.content === 'string' && replyContent.content.trim()) {
        textParts.push(replyContent.content);
      }
    }
  }
  
  const textContent = textParts.join('\n\n');
  logger.debug(`[${agentName}] Extracted content: hasImage=${!!image}, textLength=${textContent.length}`);
  
  return { image, textContent };
}

/**
 * FIXED: Check if a reply is directed to a bot message
 */
export async function isReplyToBotMessage(
  conversation: any, 
  referencedMessageId: string, 
  worker: WorkerInstance,
  botName: string
): Promise<boolean> {
  try {
    // FIXED: Get conversation messages to find the referenced message
    const messages = await conversation.messages({ limit: 100 });
    const referencedMessage = messages.find((msg: any) => msg.id === referencedMessageId);
    
    if (!referencedMessage) {
      logger.debug(`[${worker.name}] Referenced message ${referencedMessageId.substring(0, 8)} not found in recent messages`);
      return false;
    }

    // Check if the referenced message is from our bot
    const botInboxState = await worker.client.preferences.inboxStateFromInboxIds([referencedMessage.senderInboxId]);
    const botAddress = botInboxState[0]?.identifiers[0]?.identifier || '';
    
    // Check if it's from the specified bot
    const isBotMessage = botAddress === `${botName}.hopscotch.eth`;
    
    logger.debug(`[${worker.name}] Reply reference check - referenced message from: ${botAddress}, is bot: ${isBotMessage}`);
    return isBotMessage;
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[${worker.name}] Error checking reply reference: ${errorMsg}`);
    return false;
  }
}

/**
 * Message type checkers
 */
export function isReactionMessage(message: DecodedMessage): boolean {
  return message.contentType?.sameAs(ContentTypeReaction) ?? false;
}

export function isImageMessage(message: DecodedMessage): boolean {
  return message.contentType?.sameAs(ContentTypeAttachment) || 
         message.contentType?.sameAs(ContentTypeRemoteAttachment) || false;
}

export function isTextMessage(message: DecodedMessage): boolean {
  if (!message.contentType) {
    return false;
  }
  return message.contentType.typeId === 'text' || message.contentType.sameAs(ContentTypeText);
}

export function isReplyMessage(message: DecodedMessage): boolean {
  return message.contentType?.sameAs(ContentTypeReply) ?? false;
}

/**
 * Load attachment from message
 */
export async function loadAttachment(
  imageMessage: DecodedMessage<RemoteAttachment | Attachment>,
  client: any
): Promise<Attachment | null> {
  try {
    logger.debug(`[agent-helpers] Loading attachment of type: ${imageMessage.contentType?.typeId}`);
    
    if (imageMessage.contentType?.sameAs(ContentTypeRemoteAttachment)) {
      const attachment = await RemoteAttachmentCodec.load(
        imageMessage.content as RemoteAttachment,
        client
      ) as Attachment;
      logger.debug(`[agent-helpers] Remote attachment loaded, size: ${attachment.data.length} bytes`);
      return attachment;
    } else {
      const attachment = imageMessage.content as Attachment;
      logger.debug(`[agent-helpers] Direct attachment loaded, size: ${attachment.data.length} bytes`);
      return attachment;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-helpers] Failed to load attachment: ${errorMsg}`);
    return null;
  }
}

/**
 * Add reaction to message
 */
export async function addReaction(conversation: any, messageId: string, emoji: string): Promise<void> {
  try {
    const reaction: Reaction = {
      reference: messageId,
      action: 'added',
      content: emoji,
      schema: 'unicode',
    };
    await conversation.send(reaction, ContentTypeReaction);
    logger.debug(`[agent-helpers] Added reaction ${emoji} to message ${messageId}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[agent-helpers] Failed to add reaction ${emoji} to message ${messageId}: ${errorMsg}`);
  }
}

/**
 * Remove reaction from message
 */
export async function removeReaction(conversation: any, messageId: string, emoji: string): Promise<void> {
  try {
    const reaction: Reaction = {
      reference: messageId,
      action: 'removed', 
      content: emoji,
      schema: 'unicode',
    };
    await conversation.send(reaction, ContentTypeReaction);
    logger.debug(`[agent-helpers] Removed reaction ${emoji} from message ${messageId}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[agent-helpers] Failed to remove reaction ${emoji} from message ${messageId}: ${errorMsg}`);
  }
}

/**
 * Upload file to S3
 */
export async function uploadToS3(
  bucket: string,
  data: Uint8Array,
  mimeType: string,
  returnSignedUrl: boolean = false
): Promise<string | null> {
  const uploadStartTime = Date.now();
  const key = `usercontent/${getHopscotchEnv()}/${v4()}.${mimeType.split('/')[1]}`;

  logger.debug(`[agent-helpers] Uploading to S3: bucket=${bucket}, key=${key}, size=${data.length}, signedUrl=${returnSignedUrl}`);

  const uploadParams: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: data,
    ContentType: mimeType
  };

  try {
    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
    });

    await upload.done();
    const uploadTime = Date.now() - uploadStartTime;
    logger.debug(`[agent-helpers] S3 upload completed in ${uploadTime}ms`);

    if (returnSignedUrl) {
      const signedUrlStartTime = Date.now();
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: InSeconds.FifteenMinutes });
      const signedUrlTime = Date.now() - signedUrlStartTime;
      
      logger.debug(`[agent-helpers] Signed URL generated in ${signedUrlTime}ms`);
      return signedUrl?.startsWith('https://') ? signedUrl : null;
    }

    const publicUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    logger.debug(`[agent-helpers] Public URL: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    const uploadTime = Date.now() - uploadStartTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-helpers] S3 upload failed after ${uploadTime}ms: ${errorMsg}`);
    return null;
  }
}

/**
 * Generate product URL for different environments
 */
export function getProductUrl(subjectId: number): string {
  const env = process.env.HS_ENV;
  const subdomain = env === 'test' ? 'test.' : env === 'dev' ? 'dev.' : '';
  const url = `https://${subdomain}hopscotch.trade/store/products/${subjectId}`;
  logger.debug(`[agent-helpers] Generated product URL: ${url}`);
  return url;
}

/**
 * Extract text content from text or reply messages
 */
export function extractTextContent(message: DecodedMessage): string {
  if (message.contentType?.sameAs(ContentTypeText)) {
    return message.content as string;
  } else if (message.contentType?.sameAs(ContentTypeReply)) {
    const replyContent = message.content as Reply;
    if (replyContent.contentType.sameAs(ContentTypeText)) {
      return replyContent.content as string;
    } else {
      logger.warn(`[agent-helpers] Reply content type is not text: ${replyContent.contentType.typeId}`);
      return '';
    }
  }
  return '';
}

/**
 * Check if text message is tagged with agent name
 */
export function isTaggedMessage(text: string, agentName: string): boolean {
  return text.includes(`@${agentName}`);
}

/**
 * Extract description by removing agent tag
 */
export function extractDescription(text: string, agentName: string): string {
  const isTagged = isTaggedMessage(text, agentName);
  return isTagged ? text.substring(`@${agentName}`.length).trim() : text.trim();
}

/**
 * Send error response and log to Influx
 */
export async function sendErrorResponse(
  conversation: any,
  message: DecodedMessage,
  errorText: string,
  agentName: string,
  isDM: boolean
): Promise<void> {
  try {
    await conversation.send(errorText);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[agent-helpers] Failed to send error response: ${errorMsg}`);
  }
}

// FIXED: Legacy function for backward compatibility with existing deal agent code
export async function gatherMessageContent(
  conversation: any,
  message: DecodedMessage,
  description: string
): Promise<{ image: DecodedMessage<any> | undefined; fullDescription: string }> {
  let image: DecodedMessage<any> | undefined;
  const textParts: string[] = [];
  
  // Add the current message's text, cleaned of the @deal tag.
  const cleanedText = description.replace('@deal', '').trim();
  if (cleanedText) {
    textParts.unshift(cleanedText);
  }
  
  let currentMessage = message;
  const visitedMessageIds = new Set<string>();

  // FIRST: Check if the current message itself is an image
  if (isImageMessage(currentMessage)) {
    image = currentMessage;
    logger.debug(`[gatherMessageContent] Current message is an image: ${currentMessage.id}`);
  }

  // Loop backward through the reply chain until an image or a non-reply message is found.
  while (isReplyMessage(currentMessage) && !image) {
    const replyContent = currentMessage.content as Reply;
    const referencedMessageId = replyContent.reference;

    if (visitedMessageIds.has(referencedMessageId)) {
      logger.warn(`[gatherMessageContent] Detected circular reply chain. Breaking loop.`);
      break;
    }
    visitedMessageIds.add(referencedMessageId);

    try {
      logger.debug(`[gatherMessageContent] Searching for message ${referencedMessageId}`);
      
      // FIX: Use higher limit to ensure we get enough message history
      const messages = await conversation.messages({ limit: 500 });
      logger.debug(`[gatherMessageContent] Fetched ${messages.length} messages from conversation`);
      
      const referencedMessage = messages.find((msg: DecodedMessage) => msg.id === referencedMessageId);
      
      if (!referencedMessage) {
        logger.warn(`[gatherMessageContent] Referenced message ${referencedMessageId} not found in recent messages.`);
        break;
      }

      logger.debug(`[gatherMessageContent] Found referenced message: ${referencedMessage.id}`);
      logger.debug(`[gatherMessageContent] Referenced message content type: ${referencedMessage.contentType?.typeId}`);

      // Check for image FIRST before collecting text
      if (isImageMessage(referencedMessage)) {
        image = referencedMessage;
        logger.info(`[gatherMessageContent] SUCCESS: Found image in reply chain: ${referencedMessage.id}`);
        break; // Stop traversing once the image is found.
      }
      
      // If it's a text message, collect its content.
      if (isTextMessage(referencedMessage)) {
        const text = extractTextContent(referencedMessage);
        if (text.trim()) {
          textParts.unshift(text);
          logger.debug(`[gatherMessageContent] Collected text from message ${referencedMessage.id}. Current textParts: [${textParts.join(', ')}]`);
        }
      }

      // If the referenced message is NOT a reply, we've reached the end of the chain
      if (!isReplyMessage(referencedMessage)) {
        logger.debug(`[gatherMessageContent] Reached end of reply chain at message ${referencedMessage.id}`);
        break;
      }

      // Continue traversing the reply chain
      currentMessage = referencedMessage;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[gatherMessageContent] Error fetching referenced message ${referencedMessageId}: ${errorMsg}`);
      break;
    }
  }

  const fullDescription = textParts.join('\n\n');
  logger.info(`[gatherMessageContent] FINAL RESULT: hasImage=${!!image}, textLength=${fullDescription.length}, imageId=${image?.id || 'none'}`);
  logger.debug(`[gatherMessageContent] Full description: "${fullDescription}"`);

  return { image, fullDescription };
}