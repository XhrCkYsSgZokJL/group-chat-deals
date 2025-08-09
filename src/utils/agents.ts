import { GetObjectCommand, PutObjectCommandInput, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getHopscotchEnv } from '@hopscotch-trading/js-commons-core/lang';
import { InSeconds, getLogger } from '@hopscotch-trading/js-commons-core/utils';
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

export async function getMessageContext(worker: WorkerInstance, message: DecodedMessage) {
  try {
    const conversation = await worker.client.conversations.getConversationById(message.conversationId);
    if (!conversation) {
      logger.error(`Unable to find conversation ${message.conversationId}`);
      return null;
    }

    const inboxState = await worker.client.preferences.inboxStateFromInboxIds([message.senderInboxId]);
    const address = inboxState[0]?.identifiers[0]?.identifier || '';
    if (!address) {
      logger.error(`Unable to resolve address for inbox ${message.senderInboxId}`);
      return null;
    }

    let isDM = true;
    try {
      const members = await conversation.members();
      isDM = members.length <= 2;
      logger.debug(`Conversation has ${members.length} members, isDM: ${isDM}`);
    } catch (err) {
      logger.warn(`Failed to get conversation members, defaulting to DM: ${err}`);
    }

    const userKey = `${message.conversationId}:${address}`;
    return { conversation, address, isDM, userKey };
  } catch (err) {
    logger.error(`Error getting message context: ${err}`);
    return null;
  }
}

export async function validateUser(address: string) {
  try {
    logger.debug(`Validating user ${address}`);
    
    address = "0xF69c8B1261b38352eAd7B91421dA38F5fd261EC9";
    const user = await AppDB.getUserByWallet(address);
    if (!user) {
      logger.debug(`No user found for address ${address}`);
      return null;
    }

    const merchant = await AppDB.getMerchantByUserId(user.did as string);
    if (!merchant) {
      logger.debug(`No merchant found for user ${user.did}`);
      return null;
    }

    logger.debug(`User ${address} validated with merchant ${merchant.merchantId}`);
    return { user, merchant };
  } catch (err) {
    logger.error(`Error validating user ${address}: ${err}`);
    return null;
  }
}

export async function gatherMessageContent(
  conversation: any,
  message: DecodedMessage,
  description: string
): Promise<{ image: DecodedMessage<any> | undefined; fullDescription: string }> {
  let image: DecodedMessage<any> | undefined;
  const textParts: string[] = [description];
  
  // Check current message for image
  if (isImageMessage(message)) {
    image = message;
  }
  
  // If this is a reply, gather content from the reply chain
  if (isReplyMessage(message)) {
    try {
      const replyContent = message.content as Reply;
      let currentReference = replyContent.reference;
      
      // Follow the reply chain backwards to find images and collect text
      const messages = await conversation.messages({ limit: 50 });
      const visited = new Set<string>();
      
      while (currentReference && !visited.has(currentReference)) {
        visited.add(currentReference);
        
        const referencedMessage = messages.find((msg: DecodedMessage) => msg.id === currentReference);
        if (!referencedMessage) break;
        
        // Check for image (prioritize most recent)
        if (isImageMessage(referencedMessage) && !image) {
          image = referencedMessage;
          logger.debug(`Found image in reply chain: ${referencedMessage.id}`);
        }
        
        // Collect text content
        if (isTextMessage(referencedMessage)) {
          const text = extractTextContent(referencedMessage);
          if (text.trim() && !text.startsWith('@deal')) {
            textParts.unshift(text);
          }
        }
        
        // Follow the chain if this message is also a reply
        if (isReplyMessage(referencedMessage)) {
          const chainReplyContent = referencedMessage.content as Reply;
          currentReference = chainReplyContent.reference;
        } else {
          break;
        }
      }
    } catch (err) {
      logger.warn(`Error gathering reply chain content: ${err}`);
    }
  }
  
  const fullDescription = textParts.join('\n\n');
  logger.debug(`Gathered content: hasImage=${!!image}, textLength=${fullDescription.length}`);
  
  return { image, fullDescription };
}

// Message type checkers
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

export async function loadAttachment(
  imageMessage: DecodedMessage<RemoteAttachment | Attachment>,
  client: any
): Promise<Attachment | null> {
  try {
    logger.debug(`Loading attachment of type: ${imageMessage.contentType?.typeId}`);
    
    if (imageMessage.contentType?.sameAs(ContentTypeRemoteAttachment)) {
      const attachment = await RemoteAttachmentCodec.load(
        imageMessage.content as RemoteAttachment,
        client
      ) as Attachment;
      logger.debug(`Remote attachment loaded, size: ${attachment.data.length} bytes`);
      return attachment;
    } else {
      const attachment = imageMessage.content as Attachment;
      logger.debug(`Direct attachment loaded, size: ${attachment.data.length} bytes`);
      return attachment;
    }
  } catch (err) {
    logger.error(`Failed to load attachment: ${err}`);
    return null;
  }
}

export async function addReaction(conversation: any, messageId: string, emoji: string): Promise<void> {
  try {
    const reaction: Reaction = {
      reference: messageId,
      action: 'added',
      content: emoji,
      schema: 'unicode',
    };
    await conversation.send(reaction, ContentTypeReaction);
    logger.debug(`Added reaction ${emoji} to message ${messageId}`);
  } catch (err) {
    logger.warn(`Failed to add reaction ${emoji} to message ${messageId}: ${err}`);
  }
}

export async function removeReaction(conversation: any, messageId: string, emoji: string): Promise<void> {
  try {
    const reaction: Reaction = {
      reference: messageId,
      action: 'removed', 
      content: emoji,
      schema: 'unicode',
    };
    await conversation.send(reaction, ContentTypeReaction);
    logger.debug(`Removed reaction ${emoji} from message ${messageId}`);
  } catch (err) {
    logger.warn(`Failed to remove reaction ${emoji} from message ${messageId}: ${err}`);
  }
}

export async function uploadToS3(
  bucket: string,
  data: Uint8Array,
  mimeType: string,
  returnSignedUrl: boolean = false
): Promise<string | null> {
  const uploadStartTime = Date.now();
  const key = `usercontent/${getHopscotchEnv()}/${v4()}.${mimeType.split('/')[1]}`;

  logger.debug(`Uploading to S3: bucket=${bucket}, key=${key}, size=${data.length}, signedUrl=${returnSignedUrl}`);

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
    logger.debug(`S3 upload completed in ${uploadTime}ms`);

    if (returnSignedUrl) {
      const signedUrlStartTime = Date.now();
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: InSeconds.FifteenMinutes });
      const signedUrlTime = Date.now() - signedUrlStartTime;
      
      logger.debug(`Signed URL generated in ${signedUrlTime}ms`);
      return signedUrl?.startsWith('https://') ? signedUrl : null;
    }

    const publicUrl = `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    logger.debug(`Public URL: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    const uploadTime = Date.now() - uploadStartTime;
    logger.error(`S3 upload failed after ${uploadTime}ms: ${err}`);
    return null;
  }
}

export function getProductUrl(subjectId: number): string {
  const env = process.env.HS_ENV;
  const subdomain = env === 'test' ? 'test.' : env === 'dev' ? 'dev.' : '';
  const url = `https://${subdomain}hopscotch.trade/store/products/${subjectId}`;
  logger.debug(`Generated product URL: ${url}`);
  return url;
}

export function extractTextContent(message: DecodedMessage): string {
  if (message.contentType?.sameAs(ContentTypeText)) {
    return message.content as string;
  } else if (message.contentType?.sameAs(ContentTypeReply)) {
    const replyContent = message.content as Reply;
    if (replyContent.contentType.sameAs(ContentTypeText)) {
      return replyContent.content as string;
    } else {
      logger.warn(`Reply content type is not text: ${replyContent.contentType.typeId}`);
      return '';
    }
  }
  return '';
}

export async function sendErrorResponse(
  conversation: any,
  errorText: string,
): Promise<void> {
  try {
    await conversation.send(errorText);
  } catch (err) {
    logger.error(`Failed to send error response: ${err}`);
  }
}