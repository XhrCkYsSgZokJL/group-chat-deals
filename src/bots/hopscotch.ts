/**
 * Hopscotch Deal Bot
 * 
 * A conversational bot for creating, modifying, and approving product listings in group chats.
 * Features include:
 * - AI-powered listing generation from text and images
 * - Reply-based listing modifications with context preservation
 * - Creator approval system for publishing deals
 * - Integration with Hopscotch marketplace
 */

import { getLogger, sleep } from '@hopscotch-trading/js-commons-core/utils';
import { AppDB } from '@hopscotch-trading/js-commons-data';
import { DecodedMessage } from '@xmtp/node-sdk';
import { WorkerInstance } from 'workers';
import {
  addReaction,
  removeReaction,
  getMessageContext,
  isReactionMessage,
  isReplyMessage,
  loadAttachment,
  sendErrorResponse,
  extractTextContent,
  isTextMessage,
  isImageMessage,
  processMessage,
  gatherMessageContent,
} from '../utils/agents';
import {
  getProductUrl,
  uploadToS3,
  validateUser,
} from '../utils/agnostic';
import { generateProductImage, queryListings, queryListingsWithContext } from '../utils/chatGPT';
import { Reaction } from '@xmtp/content-type-reaction';
import { 
  Attachment,
  ContentTypeRemoteAttachment,
  RemoteAttachmentCodec,
  AttachmentCodec,
  RemoteAttachment
} from '@xmtp/content-type-remote-attachment';
import { ContentTypeReply, Reply } from '@xmtp/content-type-reply';
import { ContentTypeText } from '@xmtp/content-type-text';
import { botTags, botName } from '../utils/constants';

const name = botName;
const logger = getLogger(name);

// ================================================================================================
// TYPE DEFINITIONS
// ================================================================================================

/**
 * Tracks the state of an individual deal during creation and modification
 */
type DealState = {
  address: string;                    // Creator's wallet address
  image?: DecodedMessage<any>;        // User-provided image message
  textContent: string;                // Deal description text
  chatGptImageUrl?: string;           // AI-generated image URL (temporary)
  permanentImageUrl?: string;         // Permanent S3 image URL
  messageId?: string;                 // Bot's reply message ID
  lastActivity: number;               // Timestamp of last activity
};

/**
 * Product listing data structure compatible with Hopscotch marketplace
 */
type ListingData = {
  title?: string;                     // Product title
  description?: string;               // Product description
  priceValue?: string;                // Price amount as string
  priceAsset?: string;                // Currency (e.g., "USDC")
  inventory?: number;                 // Available quantity
  pickupZip?: string;                 // Pickup location ZIP code
  deliverable?: boolean;              // Whether item can be shipped
};

/**
 * Tracks approval state for deals requiring creator consent before publishing
 */
type ApprovalState = {
  creatorApproved: boolean;           // Creator has approved publication
  otherApprovals: Set<string>;        // Other users who have approved
  listingData: ListingData;           // Generated listing data
  userInfo: any;                      // User validation info
  state: DealState;                   // Associated deal state
  originalDealMessage?: DecodedMessage; // Original message that started the deal
  firstApprover?: string;             // First person to give approval
  modificationChain?: string[];       // History of modifications made
};

// ================================================================================================
// GLOBAL STATE
// ================================================================================================

/** In-memory storage for active deal states during creation */
const dealStates = new Map<string, DealState>();

/** In-memory storage for deals pending approval and publication */
const publishableDeals = new Map<string, ApprovalState>();

// Initialize bot
logger.info(`[${name}] Hopscotch deal bot initialized - Creator approval required for publishing`);

// ================================================================================================
// MAIN MESSAGE HANDLER
// ================================================================================================

/**
 * Main entry point for processing hopscotch bot messages
 * Handles message validation, user authorization, and routing to appropriate handlers
 * 
 * @param worker - XMTP worker instance for sending messages
 * @param message - Incoming message to process
 */
export default async function hopscotchHandler(
  worker: WorkerInstance,
  message: DecodedMessage,
): Promise<void> {
  const startTime = Date.now();
  
  try {
    logger.info(`[${name}] Processing deal message ${message.id} from conversation ${message.conversationId}`);
    
    const context = await getMessageContext(worker, message);
    if (!context) {
      logger.warn(`[${name}] Unable to get message context for ${message.id}`);
      return;
    }

    const { conversation, address, isDM, userKey } = context;
    logger.debug(`[${name}] Processing for user ${address}, isDM: ${isDM}, key: ${userKey}`);

    // Only process group messages - reject DMs
    if (isDM) {
      await sendErrorResponse(
        conversation, 
        message,
        "This bot is only available in group chats.",
        name,
        isDM
      );
      return;
    }

    // Use shared message processing logic adapted for deal agent
    const shouldProcess = await processMessage(message, isDM, conversation, worker, name, undefined, convertApprovalStateToListingData(publishableDeals));
    if (!shouldProcess.process) {
      logger.debug(`[${name}] ${shouldProcess.reason} from ${address}`);
      return;
    }

    logger.debug(`[${name}] Message passed filtering: ${shouldProcess.reason}`);

    // Validate user - only for messages we definitely want to process
    const userInfo = await validateUser(address);
    if (!userInfo) {
      await sendErrorResponse(
        conversation, 
        message, 
        "Open a Store on Hopscotch.trade to continue.", 
        name, 
        isDM
      );
      logger.info(`[${name}] User ${address} not authorized - no store found`);
      return;
    }

    logger.debug(`[${name}] User ${address} validated - merchant ID: ${userInfo.merchant.merchantId}`);

    // Process the message based on type
    if (isReactionMessage(message)) {
      logger.debug(`[${name}] Processing reaction message from ${address}`);
      await handleReaction(worker, conversation, message, address, userKey, userInfo);
    } else {
      logger.debug(`[${name}] Processing content message from ${address}`);
      await handleContentMessage(worker, conversation, message, address, userKey, userInfo);
    }

    const processingTime = Date.now() - startTime;
    logger.info(`[${name}] Successfully processed deal message ${message.id} in ${processingTime}ms`);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    const processingTime = Date.now() - startTime;
    logger.error(`[${name}] Error handling deal message ${message.id}: ${errorMsg} (took ${processingTime}ms)`);
  }
}

// ================================================================================================
// UTILITY FUNCTIONS
// ================================================================================================

/**
 * Converts ApprovalState map to ListingData map for processMessage compatibility
 * @param approvalStates - Map of approval states to convert
 * @returns Map of listing data keyed by message ID
 */
function convertApprovalStateToListingData(approvalStates: Map<string, ApprovalState>): Map<string, ListingData> {
  const listingDataMap = new Map<string, ListingData>();
  for (const [key, approvalState] of approvalStates.entries()) {
    listingDataMap.set(key, approvalState.listingData);
  }
  return listingDataMap;
}

/**
 * Determines if a message is a reply to a hopscotch bot message
 * Uses approval state cache as primary detection method, falls back to conversation history
 * 
 * @param conversation - XMTP conversation to search
 * @param message - Message to check for reply status
 * @param worker - Worker instance for bot address comparison
 * @returns True if the message is a reply to this bot
 */
async function isReplyToHopscotchMessage(
  conversation: any,
  message: DecodedMessage,
  worker: WorkerInstance
): Promise<boolean> {
  if (!isReplyMessage(message)) {
    return false;
  }

  const replyContent = message.content as Reply;
  const referencedMessageId = replyContent.reference;

  try {
    logger.debug(`[${name}] Checking if reply to hopscotch message: ${referencedMessageId}`);
    
    // First check our approval state store as it's more reliable
    if (publishableDeals.has(referencedMessageId)) {
      logger.debug(`[${name}] Found referenced message in approval state - confirmed bot message`);
      return true;
    }
    
    // Get recent messages to find the referenced one
    const messages = await conversation.messages({ limit: 200 });
    const referencedMessage = messages.find((msg: DecodedMessage) => msg.id === referencedMessageId);
    
    if (!referencedMessage) {
      logger.debug(`[${name}] Referenced message ${referencedMessageId.substring(0, 8)} not found in ${messages.length} recent messages`);
      return false;
    }

    // Check if the referenced message is from our hopscotch bot
    const inboxState = await worker.client.preferences.inboxStateFromInboxIds([referencedMessage.senderInboxId]);
    const senderAddress = inboxState[0]?.identifiers[0]?.identifier || '';
    
    // Get our bot's address to compare
    const botInboxState = await worker.client.preferences.inboxState();
    const botAddress = botInboxState.identifiers[0]?.identifier || '';
    
    logger.debug(`[${name}] Reply check: referenced from ${senderAddress}, bot address ${botAddress}, match: ${senderAddress === botAddress}`);
    
    return senderAddress === botAddress;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[${name}] Error checking if reply is to hopscotch message: ${errorMsg}`);
    return false;
  }
}

// ================================================================================================
// IMAGE HANDLING HELPERS
// ================================================================================================

/**
 * Simplified function to send a generated image to the conversation
 * @param conversation - XMTP conversation
 * @param imageUrl - URL of the generated image
 * @param botName - Name of the bot for logging
 */
async function sendGeneratedImage(
  conversation: any,
  imageUrl: string,
  botName: string
): Promise<void> {
  try {
    logger.info(`[${botName}] 🖼️ Starting image send process`);
    logger.info(`[${botName}] 🔗 Source URL: ${imageUrl}`);
    
    await sleep(2000);
    
    // Download image
    logger.info(`[${botName}] 📥 Downloading image...`);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || 'image/png';
    const mimeType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
    const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    
    const imageArrayBuffer = await response.arrayBuffer();
    const imageAsBuffer = Buffer.from(imageArrayBuffer);
    
    logger.info(`[${botName}] ✅ Image downloaded: ${imageAsBuffer.length} bytes (${mimeType})`);
    
    // Create attachment
    const attachment: Attachment = {
      filename: `deal-image.${extension}`,
      mimeType,
      data: imageAsBuffer 
    };
    
    // Encrypt
    logger.info(`[${botName}] 🔐 Encrypting attachment...`);
    const encryptedEncoded = await RemoteAttachmentCodec.encodeEncrypted(
      attachment,
      new AttachmentCodec()
    );
    
    logger.info(`[${botName}] ✅ Encryption complete: ${encryptedEncoded.payload.length} bytes encrypted`);
    logger.info(`[${botName}] 🔑 Crypto info: digest=${encryptedEncoded.digest.length}B, salt=${encryptedEncoded.salt.length}B, nonce=${encryptedEncoded.nonce.length}B, secret=${encryptedEncoded.secret.length}B`);

    const payloadBuffer = Buffer.from(encryptedEncoded.payload);
    
    // Upload to S3
    logger.info(`[${botName}] ☁️ Uploading to S3: bucket=${process.env.AWS_BUCKET_CONTENT}`);
    const s3Url = await uploadToS3(
      process.env.AWS_BUCKET_CONTENT ?? '',
      payloadBuffer,
      'application/octet-stream', 
      false
    );
    
    if (!s3Url) {
      throw new Error('S3 upload returned null URL');
    }
    
    logger.info(`[${botName}] ✅ S3 upload successful: ${s3Url}`);
    
    // Test URL accessibility
    logger.info(`[${botName}] 🧪 Testing S3 URL accessibility...`);
    try {
      const testResponse = await fetch(s3Url);
      logger.info(`[${botName}] 📊 S3 URL test: ${testResponse.status} ${testResponse.statusText}`);
      if (testResponse.ok) {
        const testSize = parseInt(testResponse.headers.get('content-length') || '0');
        logger.info(`[${botName}] 📏 S3 content size: ${testSize} bytes (expected: ${payloadBuffer.length})`);
      }
    } catch (testErr) {
      logger.warn(`[${botName}] ⚠️ S3 URL test failed: ${testErr}`);
    }
    
    // Create remote attachment
    const remoteAttachment: RemoteAttachment = {
      url: s3Url,
      contentDigest: encryptedEncoded.digest,
      salt: encryptedEncoded.salt,
      nonce: encryptedEncoded.nonce,
      secret: encryptedEncoded.secret,
      scheme: 'https://',
      filename: attachment.filename,
      contentLength: payloadBuffer.byteLength, 
    };
    
    logger.info(`[${botName}] 📋 Remote attachment object:`);
    logger.info(`[${botName}] 📋   URL: ${remoteAttachment.url}`);
    logger.info(`[${botName}] 📋   Filename: ${remoteAttachment.filename}`);
    logger.info(`[${botName}] 📋   ContentLength: ${remoteAttachment.contentLength}`);
    logger.info(`[${botName}] 📋   Scheme: ${remoteAttachment.scheme}`);
    
    // Send via XMTP
    logger.info(`[${botName}] 📤 Sending via XMTP...`);
    await conversation.send(remoteAttachment, ContentTypeRemoteAttachment);
    logger.info(`[${botName}] ✅ Image sent successfully via XMTP!`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`[${botName}] ❌ Image send failed: ${errorMsg}`);
    if (errorStack) {
      logger.debug(`[${botName}] Stack trace: ${errorStack}`);
    }
  }
}

// ================================================================================================
// DEAL MODIFICATION HANDLERS
// ================================================================================================

/**
 * Handles modification of existing deals when users reply to bot listings
 * Preserves original listing data while applying context-aware modifications
 * 
 * @param worker - XMTP worker instance
 * @param conversation - Active conversation
 * @param message - Reply message containing modification request
 * @param address - User's wallet address
 * @param userInfo - Validated user information
 */
async function handleDealModification(
  worker: WorkerInstance,
  conversation: any,
  message: DecodedMessage,
  address: string,
  userInfo: any
): Promise<void> {
  const startTime = Date.now();
  let reactionSent = false;

  try {
    logger.info(`[${name}] Processing deal modification from ${address}`);

    const replyContent = message.content as Reply;
    const referencedMessageId = replyContent.reference;
    
    // Extract the actual reply text content properly - handle nested replies
    let modificationText = '';
    logger.debug(`[${name}] Reply content type: ${replyContent.contentType.typeId}, content type: ${typeof replyContent.content}`);
    
    if (replyContent.contentType.sameAs(ContentTypeText) && typeof replyContent.content === 'string') {
      modificationText = replyContent.content;
      logger.debug(`[${name}] Successfully extracted reply text: "${modificationText}"`);
    } else if (replyContent.contentType.sameAs(ContentTypeReply)) {
      // Handle reply-to-reply case (nested reply)
      const nestedReply = replyContent.content as Reply;
      logger.debug(`[${name}] Nested reply content type: ${nestedReply.contentType.typeId}`);
      if (nestedReply.contentType.sameAs(ContentTypeText) && typeof nestedReply.content === 'string') {
        modificationText = nestedReply.content;
        logger.debug(`[${name}] Successfully extracted nested reply text: "${modificationText}"`);
      }
    } else {
      // Try to use the message's extractTextContent as fallback
      modificationText = extractTextContent(message);
      logger.debug(`[${name}] Using extractTextContent fallback: "${modificationText}"`);
    }
    
    logger.info(`[${name}] Final modification text extracted: "${modificationText}"`);
    
    if (!modificationText.trim()) {
      logger.warn(`[${name}] No modification text extracted from reply message`);
      return; // Exit early if we can't get the modification text
    }

    // Find the approval state for the referenced message
    const approvalState = publishableDeals.get(referencedMessageId);
    if (!approvalState) {
      logger.debug(`[${name}] No approval state found for referenced message ${referencedMessageId}`);
      logger.debug(`[${name}] Available approval states: ${Array.from(publishableDeals.keys()).join(', ')}`);
      return;
    }

    // Only allow the original creator to modify the deal
    if (address !== approvalState.state.address) {
      await sendErrorResponse(
        conversation,
        message,
        "Only the deal creator can modify this listing.",
        name,
        false
      );
      return;
    }

    await addReaction(conversation, message.id, '🔄');
    reactionSent = true;

    // Store the modification chain for future updates
    const existingModifications = approvalState.modificationChain || [];
    const newModificationChain = [...existingModifications, modificationText];
    approvalState.modificationChain = newModificationChain;
    
    logger.info(`🔵 [${name}] MODIFICATION REQUEST: ${modificationText}`);
    logger.info(`🔵 [${name}] EXISTING LISTING: ${JSON.stringify(approvalState.listingData, null, 2)}`);

    // Update activity timestamp
    approvalState.state.lastActivity = Date.now();

    // Generate new image if needed for modification (use the modification text for context)
    let imageUrl = approvalState.state.chatGptImageUrl;
    if (!imageUrl) {
      logger.info(`[${name}] Generating new image for modification: ${modificationText}`);
      
      const generatedImageUrl = await generateProductImage(modificationText);
      if (generatedImageUrl) {
        imageUrl = generatedImageUrl;
        approvalState.state.chatGptImageUrl = imageUrl;
        logger.info(`[${name}] Successfully generated new image for modification`);
      }
    }

    // Create modified listing using context-aware approach
    const updatedListing = await queryListingsWithContext({
      text: modificationText,
      image: imageUrl,
      existingListing: approvalState.listingData
    });
    
    if (!updatedListing || updatedListing === 'Internal error') {
      await removeReaction(conversation, message.id, '🔄');
      await sendErrorResponse(
        conversation,
        message,
        "Failed to update deal listing. Please try again.",
        name,
        false
      );
      return;
    }

    // Check if modification request mentions delivery/pickup changes
    const mentionsDeliveryChanges = /remove delivery|no delivery|no shipping|pickup only|remove pickup|no pickup|delivery only|shipping only|shipping|delivery|pickup|from \d{5}/i.test(modificationText);
    
    // Validate and merge the updated listing with intelligent preservation
    const validatedListing: ListingData = {
      title: updatedListing.title || approvalState.listingData.title || 'Deal Item',
      description: updatedListing.description || approvalState.listingData.description || 'Modified item',
      priceValue: updatedListing.priceValue || approvalState.listingData.priceValue || '1',
      priceAsset: updatedListing.priceAsset || approvalState.listingData.priceAsset || 'USDC',
      inventory: updatedListing.inventory !== undefined ? updatedListing.inventory : (approvalState.listingData.inventory || 1),
      
      // Handle deliverable - only change if delivery/pickup modifications were mentioned
      deliverable: mentionsDeliveryChanges 
        ? (updatedListing.deliverable !== undefined ? updatedListing.deliverable : approvalState.listingData.deliverable)
        : (approvalState.listingData.deliverable || false),
      
      // Handle pickupZip - preserve existing logic but respect delivery changes
      ...(mentionsDeliveryChanges 
          ? (updatedListing.pickupZip ? { pickupZip: updatedListing.pickupZip } : 
             (!updatedListing.pickupZip && approvalState.listingData.pickupZip && updatedListing.deliverable !== true) ? 
             { pickupZip: approvalState.listingData.pickupZip } : {})
          : (approvalState.listingData.pickupZip ? { pickupZip: approvalState.listingData.pickupZip } : {})),
    };

    logger.debug(`[${name}] Merged listing data: ${JSON.stringify(validatedListing, null, 2)}`);

    // Update the approval state with new listing data and reset approvals
    approvalState.listingData = validatedListing;
    approvalState.creatorApproved = false;
    approvalState.otherApprovals.clear();

    await removeReaction(conversation, message.id, '🔄');
    reactionSent = false;

    // Send the updated deal preview as a reply
    const responseText = formatDealListing(validatedListing);
    if (!responseText) {
      await sendErrorResponse(
        conversation,
        message,
        "Failed to format updated deal listing.",
        name,
        false
      );
      return;
    }

    const replyToModification = {
      reference: message.id,
      content: `${responseText}`,
      contentType: ContentTypeText
    };

    const sentModificationMessage = await conversation.send(replyToModification, ContentTypeReply);

    // Store the approval state for the new reply message too, so future replies can reference it
    let newMessageId: string;
    if (typeof sentModificationMessage === 'string') {
      newMessageId = sentModificationMessage;
    } else if (sentModificationMessage && sentModificationMessage.id) {
      newMessageId = sentModificationMessage.id;
    } else {
      logger.warn(`[${name}] Could not get message ID for modification reply`);
      newMessageId = '';
    }

    if (newMessageId) {
      // Store the same approval state under the new message ID so replies to this message work
      publishableDeals.set(newMessageId, approvalState);
      logger.debug(`[${name}] Stored approval state for modification reply message ID: ${newMessageId}`);
    }

    const totalTime = Date.now() - startTime;
    logger.info(`[${name}] Deal modification processed successfully in ${totalTime}ms`);

  } catch (err) {
    const processingTime = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] Error processing deal modification: ${errorMsg} (took ${processingTime}ms)`);
    
    if (reactionSent) {
      try {
        await removeReaction(conversation, message.id, '🔄');
      } catch {
        logger.warn(`[${name}] Failed to remove modification reaction on error`);
      }
    }
    
    await sendErrorResponse(
      conversation,
      message,
      "Something went wrong updating the deal. Please try again.",
      name,
      false
    );
  }
}

// ================================================================================================
// LISTING FORMATTING AND VALIDATION
// ================================================================================================

/**
 * Formats listing data into human-readable deal preview for chat display
 * @param listing - Listing data to format
 * @returns Formatted string for display, or null if invalid
 */
function formatDealListing(listing: ListingData): string | null {
  if (!isValidListing(listing)) {
    logger.error(`[${name}] Cannot format invalid listing: title="${listing.title}", description="${listing.description?.substring(0, 50)}...", priceValue="${listing.priceValue}", priceAsset="${listing.priceAsset}", inventory=${listing.inventory}, deliverable=${listing.deliverable}, pickupZip="${listing.pickupZip}"`);
    return null;
  }

  // Determine delivery/pickup text with emoji
  let deliveryInfo = "";
  if (listing.deliverable && listing.pickupZip) {
    // Both shipping and pickup available
    deliveryInfo = `📦 Shipping supported\n📍 Pickup from ${listing.pickupZip}`;
  } else if (listing.deliverable) {
    // Shipping only
    deliveryInfo = "📦 Shipping supported";
  } else if (listing.pickupZip) {
    // Pickup only
    deliveryInfo = `📍 Pickup from ${listing.pickupZip}`;
  } else {
    // Neither pickup nor delivery specified - assume remote/digital
    deliveryInfo = "💻 Delivered remotely";
  }

  // Action text for publishing
  const actionText = "↩️ Reply to refine";
  const actionText2 = "👍 Creator can publish";

  const formatted = `${listing.title}

${listing.description}

🏷️ ${listing.inventory} available for ${listing.priceValue} ${listing.priceAsset}
${deliveryInfo}

${actionText}
${actionText2}`;

  logger.debug(`[${name}] Formatted deal listing: ${listing.title} - ${listing.priceValue} ${listing.priceAsset}, delivery: ${deliveryInfo.replace('\n', ', ')}`);
  return formatted;
}

/**
 * Checks if deal is ready for publication based on approval status
 * Currently requires creator approval only
 * @param approvalState - Current approval state to check
 * @returns True if ready to publish
 */
function isReadyToPublish(approvalState: ApprovalState): boolean {
  // Must have creator approval to publish
  return approvalState.creatorApproved;
}

// ================================================================================================
// APPROVAL AND REACTION HANDLERS
// ================================================================================================

/**
 * Handles reaction messages for deal approval and cancellation
 * Supports thumbs up (👍) for approval and thumbs down (👎) for cancellation
 * 
 * @param worker - XMTP worker instance
 * @param conversation - Active conversation
 * @param message - Reaction message
 * @param address - User's wallet address
 * @param userKey - Unique user key for state tracking
 * @param _userInfo - Validated user information (unused in reactions)
 */
async function handleReaction(
  worker: WorkerInstance,
  conversation: any, 
  message: DecodedMessage,
  address: string,
  userKey: string,
  _userInfo: any
) {
  if (!message.content || typeof message.content !== 'object') {
    logger.warn(`[${name}] Invalid reaction content structure`);
    return;
  }
  
  const reaction = message.content as Reaction;
  
  // Normalize reaction content to handle different formats
  let normalizedContent = reaction.content;
  if (reaction.content === '-1' || reaction.content === '👎') {
    normalizedContent = '👎';
  } else if (reaction.content === '+1' || reaction.content === '👍') {
    normalizedContent = '👍';
  }
  
  logger.debug(`[${name}] Processing reaction: ${reaction.action} ${reaction.content} (normalized: ${normalizedContent})`);
  logger.debug(`[${name}] Reaction target message ID: ${reaction.reference}`);
  
  if (reaction.action !== 'added') {
    logger.debug(`[${name}] Ignoring reaction removal`);
    return;
  }

  // Look up the approval state using the reaction target message ID
  const targetMessageId = reaction.reference;
  const approvalState = publishableDeals.get(targetMessageId);
  
  if (!approvalState) {
    logger.debug(`[${name}] No approval state found for message ID ${targetMessageId}`);
    return;
  }

  logger.debug(`[${name}] Found approval state for message ${targetMessageId}, creator: ${approvalState.state.address}`);

  // Handle thumbs down - cancel deal
  if (normalizedContent === '👎') {
    if (address === approvalState.state.address) {
      // Only creator can cancel
      publishableDeals.delete(targetMessageId);
      dealStates.delete(userKey);
      
      await addReaction(conversation, targetMessageId, '🗑️');
      logger.info(`[${name}] Deal cancelled by creator ${address}`);
    } else {
      logger.debug(`[${name}] Non-creator ${address} attempted to cancel deal from ${approvalState.state.address}`);
    }
    return;
  }

  // Handle thumbs up - approval process
  if (normalizedContent === '👍') {
    const isCreator = address === approvalState.state.address;
    
    // Check if this is the very first thumbs up overall
    const isFirstThumbsUp = approvalState.otherApprovals.size === 0 && !approvalState.creatorApproved;
    
    if (isCreator) {
      // Creator approval
      if (approvalState.creatorApproved) {
        logger.debug(`[${name}] Creator ${address} has already approved deal ${targetMessageId}`);
        return;
      }
      
      approvalState.creatorApproved = true;
      if (isFirstThumbsUp) {
        approvalState.firstApprover = address;
      }
      logger.info(`[${name}] Creator ${address} approved deal ${targetMessageId}`);
      
    } else {
      // Other user approval - make sure they haven't already approved
      if (approvalState.otherApprovals.has(address)) {
        logger.debug(`[${name}] User ${address} has already approved deal ${targetMessageId}`);
        return;
      }
      
      approvalState.otherApprovals.add(address);
      if (isFirstThumbsUp) {
        approvalState.firstApprover = address;
      }
      logger.info(`[${name}] User ${address} approved deal ${targetMessageId}. Total other approvals: ${approvalState.otherApprovals.size}`);
    }

    // Log first approver for tracking
    if (isFirstThumbsUp) {
      logger.info(`[${name}] First approval received from ${address} for deal ${targetMessageId}`);
    }

    // Check if we can publish - requires creator approval
    if (isReadyToPublish(approvalState)) {
      const totalApprovals = (approvalState.creatorApproved ? 1 : 0) + approvalState.otherApprovals.size;
      logger.info(`[${name}] Deal ready to publish - creator approved, total approvals: ${totalApprovals}`);
      
      await publishDeal(conversation, targetMessageId, approvalState, message, worker, approvalState.originalDealMessage || message);
    } else {
      logger.debug(`[${name}] Deal not ready: creatorApproved=${approvalState.creatorApproved} (creator approval required)`);
    }
  }
}

// ================================================================================================
// DEAL CREATION HANDLERS
// ================================================================================================

/**
 * Handles content messages for creating new deals or modifying existing ones
 * Routes to modification handler if message is a reply to bot, otherwise creates new deal
 * 
 * @param worker - XMTP worker instance
 * @param conversation - Active conversation
 * @param message - Content message from user
 * @param address - User's wallet address
 * @param userKey - Unique user key for state tracking
 * @param userInfo - Validated user information
 */
async function handleContentMessage(
  worker: WorkerInstance,
  conversation: any,
  message: DecodedMessage,
  address: string,
  userKey: string,
  userInfo: any
) {
  const startTime = Date.now();
  let reactionSent = false;
  
  try {
    // Check if this is a reply to a hopscotch bot message
    const isModifyingExistingDeal = await isReplyToHopscotchMessage(conversation, message, worker);
    
    if (isModifyingExistingDeal) {
      return await handleDealModification(worker, conversation, message, address, userInfo);
    }
    
    // Extract description, removing bot tags first
    let initialDescription = '';
    if (isTextMessage(message)) {
      initialDescription = extractTextContent(message);
    } else if (isReplyMessage(message)) {
      const replyContent = message.content as Reply;
      if (replyContent.contentType.sameAs(ContentTypeText)) {
        initialDescription = replyContent.content as string;
      }
    }
    
    // Remove any bot tag from the beginning
    for (const tag of botTags) {
      const tagWithAt = `@${tag}`;
      const tagIndex = initialDescription.indexOf(tagWithAt);
      if (tagIndex >= 0) {
        initialDescription = initialDescription.substring(tagIndex + tagWithAt.length).trim();
        break; // Remove only the first matching tag
      }
    }
    
    // Use the legacy function to gather content from reply chain
    const { image, fullDescription } = await gatherMessageContent(conversation, message, initialDescription);
    const textContent = fullDescription;
    
    // Additional debug logging
    logger.debug(`[${name}] Content extraction result: hasImage=${!!image}, textLength=${textContent.length}`);
    if (image) {
      logger.debug(`[${name}] Found image from message: ${image.id}`);
    }
    
    // Better validation logic
    const hasImage = !!image;
    const hasText = textContent.length > 0;
    
    // Check if the message is a standalone image with no text and no bot tags
    if (isImageMessage(message) && !hasText && initialDescription.length === 0) {
      logger.debug(`[${name}] Ignoring standalone untagged image message.`);
      return;
    }

    // Validate we have either meaningful text OR an image
    if (!hasText && !hasImage) {
      await sendErrorResponse(
        conversation, 
        message,
        "Please include a description or image for your deal.",
        name,
        false
      );
      return;
    }

    // If we only have very short text and no image, reject
    if (!hasImage && textContent.trim().length < 3) {
      await sendErrorResponse(
        conversation, 
        message,
        "Please provide a more detailed description for your deal.",
        name,
        false
      );
      return;
    }

    const description = textContent || "Item from image"; // Fallback if only image

    logger.info(`[${name}] Processing deal content: hasImage=${!!image}, descriptionLength=${description.length}`);

    await addReaction(conversation, message.id, '💸');
    reactionSent = true;

    // Create deal state - ensure image from reply chain is captured
    const state: DealState = {
      address,
      image, // This should now properly contain the image from the reply chain
      textContent: description,
      lastActivity: Date.now()
    };
    dealStates.set(userKey, state);

    // Generate listing using the same approach as sell agent
    const listing = await createListing(worker, state);
    if (!listing) {
      await removeReaction(conversation, message.id, '💸');
      reactionSent = false;
      
      await sendErrorResponse(
        conversation, 
        message,
        "Failed to create deal listing. Please try again.",
        name,
        false
      );
      return;
    }

    // Send generated image if we have one and no user-provided image
    if (state.chatGptImageUrl && !state.image) {
      await sendGeneratedImage(conversation, state.chatGptImageUrl, name);
    }

    await removeReaction(conversation, message.id, '💸');
    reactionSent = false;

    // Send the deal preview as a reply to the original message
    const responseText = formatDealListing(listing);
    if (!responseText) {
      await sendErrorResponse(
        conversation, 
        message,
        "Failed to format deal listing. Please try again.",
        name,
        false
      );
      return;
    }

    const replyContent = {
      reference: message.id,
      content: responseText,
      contentType: ContentTypeText
    };
    
    await sleep(1000);// xmtp timing issues
    const sentMessage = await conversation.send(replyContent, ContentTypeReply);

    // Store for approval tracking
    const approvalState: ApprovalState = {
      creatorApproved: false,
      otherApprovals: new Set<string>(),
      listingData: listing,
      userInfo,
      state,
      modificationChain: [] // Initialize empty modification chain
    };

    // Get the message ID - XMTP returns it as a string directly
    let messageId: string;

    if (typeof sentMessage === 'string') {
      messageId = sentMessage;
      logger.info(`[${name}] Got message ID from send response: ${messageId}`);
    } else if (sentMessage && sentMessage.id) {
      messageId = sentMessage.id;
      logger.info(`[${name}] Got message ID from response.id: ${messageId}`);
    } else {
      logger.error(`[${name}] Unexpected response format from conversation.send(): ${typeof sentMessage}`);
      logger.debug(`[${name}] Response properties: ${Object.keys(sentMessage || {}).join(', ')}`);
      
      await sendErrorResponse(
        conversation, 
        message,
        "Failed to set up deal tracking. Please try again.",
        name,
        false
      );
      return;
    }

    // Store the approval state with the message ID
    publishableDeals.set(messageId, approvalState);
    state.messageId = messageId;

    // Store original deal message for replies
    approvalState.originalDealMessage = message;

    logger.info(`[${name}] Stored approval state with message ID: ${messageId}`);
    logger.debug(`[${name}] Total deals stored: ${publishableDeals.size}`);

    const totalTime = Date.now() - startTime;
    logger.info(`[${name}] Deal content processed successfully in ${totalTime}ms`);

  } catch (err) {
    const processingTime = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] Error processing deal content: ${errorMsg} (took ${processingTime}ms)`);
    
    if (reactionSent) {
      try {
        await removeReaction(conversation, message.id, '💸');
      } catch (reactionErr) {
        const reactionErrorMsg = reactionErr instanceof Error ? reactionErr.message : String(reactionErr);
        logger.warn(`[${name}] Failed to remove reaction on error: ${reactionErrorMsg}`);
      }
    }
    
    await sendErrorResponse(
      conversation, 
      message,
      "Something went wrong. Please try again.",
      name,
      false
    );
  }
}

/**
 * Creates structured listing data from deal state and user information
 * Handles image processing (existing or generated) and API communication with OpenAI
 * 
 * @param worker - XMTP worker instance for attachment processing
 * @param state - Current deal state containing description and images
 * @param _userInfo - Validated user information (unused in current implementation)
 * @returns Promise resolving to validated listing data or null on failure
 */
async function createListing(worker: WorkerInstance, state: DealState): Promise<ListingData | null> {
  try {
    let imageUrl: string | undefined = state.chatGptImageUrl;
    let generatedImage = false;

    logger.debug(`[${name}] Creating listing - hasUserImage=${!!state.image}, hasChatGptUrl=${!!imageUrl}`);

    // Priority 1: Use existing image from the conversation/reply chain
    if (state.image && !imageUrl) {
      logger.info(`[${name}] Using existing image from conversation for text: ${state.textContent.substring(0, 50)}...`);

      const attachment = await loadAttachment(state.image, worker.client);
      if (!attachment) {
        logger.error(`[${name}] Failed to load attachment from existing image`);
        return null;
      }

      const chatGptUrl = await uploadToS3(
        process.env.AWS_BUCKET_CHATGPT ?? '',
        Buffer.from(attachment.data),
        attachment.mimeType,
        true
      );

      if (!chatGptUrl) {
        logger.error(`[${name}] Failed to upload existing image to S3`);
        return null;
      }
      
      imageUrl = chatGptUrl;
      state.chatGptImageUrl = chatGptUrl;
      logger.info(`[${name}] Successfully processed existing image for ChatGPT API`);
    }

    // Priority 2: Generate new image from text description (only if no image exists)
    if (!imageUrl) {
      if (!state.textContent.trim()) {
        logger.error(`[${name}] No text content available for image generation`);
        return null;
      }

      logger.info(`[${name}] No existing image found, generating new image for text: ${state.textContent.substring(0, 100)}...`);

      const generatedImageUrl = await generateProductImage(state.textContent);
      if (!generatedImageUrl) {
        logger.error(`[${name}] Failed to generate image`);
        return null;
      }

      imageUrl = generatedImageUrl;
      generatedImage = true;
      state.chatGptImageUrl = imageUrl;
      logger.info(`[${name}] Successfully generated new image`);
    }

    // Now, with a guaranteed imageUrl, the rest of the function can proceed
    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) {
      logger.error(`[${name}] No valid image URL available: ${imageUrl}`);
      return null;
    }

    // Query listings API with guaranteed image
    logger.debug(`[${name}] Querying listings API with text length: ${state.textContent.length}, image URL: ${imageUrl.substring(0, 50)}..., generated: ${generatedImage}`);
    
    const listing = await queryListings({
      text: state.textContent || "Please create a listing from the provided description.",
      image: imageUrl
    });

    if (!listing) {
      throw new Error('Failed to query listings API');
    }

    // Ensure required fields are populated with defaults
    const validatedListing: ListingData = {
      title: listing.title || 'Deal Item',
      description: listing.description || state.textContent,
      priceValue: listing.priceValue || '1',
      priceAsset: listing.priceAsset || 'USDC',
      inventory: listing.inventory || 1,
      deliverable: listing.deliverable !== undefined ? listing.deliverable : false,
      ...(listing.pickupZip && { pickupZip: listing.pickupZip }),
    };

    logger.debug(`[${name}] Created validated listing: title="${validatedListing.title}", price=${validatedListing.priceValue} ${validatedListing.priceAsset}, inventory=${validatedListing.inventory}, pickupZip=${validatedListing.pickupZip}, deliverable=${validatedListing.deliverable}`);

    return validatedListing;
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] Error creating listing: ${errorMsg}`);
    return null;
  }
}

/**
 * Publishes approved deal to Hopscotch database and sends confirmation message
 * Handles permanent image storage, subject creation, and cleanup of temporary state
 * 
 * @param conversation - Active conversation for messaging
 * @param messageId - ID of the message being approved
 * @param approvalState - Complete approval state with listing data
 * @param originalMessage - Original message that triggered the deal
 * @param worker - XMTP worker instance for attachment processing
 * @param dealMessage - The deal message to reply to with publication confirmation
 */
async function publishDeal(
  conversation: any,
  messageId: string,
  approvalState: ApprovalState,
  originalMessage: DecodedMessage,
  worker: WorkerInstance,
  dealMessage: DecodedMessage
) {
  const startTime = Date.now();
  let buildingReactionSent = false;
  
  try {
    logger.info(`[${name}] Publishing deal for message ${messageId}`);
    
    if (!isValidListing(approvalState.listingData)) {
      logger.error(`[${name}] Invalid listing data for message ${messageId}: ${JSON.stringify(approvalState.listingData)}`);
      await sendErrorResponse(
        conversation, 
        originalMessage, 
        "Something went wrong. Please try again.", 
        name, 
        false
      );
      return;
    }

    // Validate userInfo is not null
    if (!approvalState.userInfo?.user?.did || !approvalState.userInfo?.merchant?.merchantId) {
      logger.error(`[${name}] Invalid userInfo for listing ${messageId}`);
      await sendErrorResponse(
        conversation, 
        originalMessage, 
        "User validation failed. Please try again.", 
        name, 
        false
      );
      return;
    }

    await addReaction(conversation, messageId, '🏗️');
    buildingReactionSent = true;

    // Handle image - we should always have one by this point
    let permanentImageUrl = approvalState.state.permanentImageUrl;
    
    if (!permanentImageUrl) {
      let uploadResult: string | null = null;
      
      if (approvalState.state.image) {
        // Upload existing image permanently
        const attachment = await loadAttachment(approvalState.state.image, worker.client);
        if (!attachment) {
          throw new Error('Failed to load attachment for permanent upload');
        }
        uploadResult = await uploadToS3(
          process.env.AWS_BUCKET_CONTENT ?? '',
          Buffer.from(attachment.data),
          attachment.mimeType,
          false
        );
      } else if (approvalState.state.chatGptImageUrl) {
        // Download generated image and upload permanently
        logger.debug(`[${name}] Downloading generated image for permanent storage`);
        
        const imageResponse = await fetch(approvalState.state.chatGptImageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch generated image for permanent upload: ${imageResponse.status}`);
        }
        
        const imageBuffer = await imageResponse.arrayBuffer();
        const imageData = new Uint8Array(imageBuffer);
        
        uploadResult = await uploadToS3(
          process.env.AWS_BUCKET_CONTENT ?? '',
          Buffer.from(imageData),
          'image/jpeg',
          false
        );
        
        logger.debug(`[${name}] Generated image uploaded permanently`);
      } else {
        throw new Error('No image available for permanent upload');
      }
      
      if (!uploadResult) {
        throw new Error('Failed to create permanent image URL');
      }
      
      permanentImageUrl = uploadResult;
      approvalState.state.permanentImageUrl = permanentImageUrl;
    }

    const strippedImageUrl = permanentImageUrl.replace(
      `.s3.${process.env.AWS_REGION}.amazonaws.com`, 
      ''
    );

    const { listingData, userInfo } = approvalState;

    logger.debug(`[${name}] Creating subject with data: did=${userInfo.user.did}, merchantId=${userInfo.merchant.merchantId}, title="${listingData.title}", priceValue=${listingData.priceValue}, priceAsset=${listingData.priceAsset}, inventory=${listingData.inventory}, pickupZip=${listingData.pickupZip}, deliverable=${listingData.deliverable}`);

    // Create subject in database
    const subject = await AppDB.createSubject({
      did: userInfo.user.did,
      merchantId: userInfo.merchant.merchantId,
      title: listingData.title!,
      description: listingData.description!,
      imageUrl: strippedImageUrl,
      priceValue: listingData.priceValue!,
      priceAsset: listingData.priceAsset!,
      priceAssetChain: 8453,
      paymentAsset: listingData.priceAsset!,
      paymentAssetChain: 8453,
      inventory: listingData.inventory!,
      ...(listingData.pickupZip && { pickupZip: listingData.pickupZip }),
      deliverable: listingData.deliverable!,
      archived: false,
    });

    if (subject.subject) {
      const productUrl = getProductUrl(subject.subject.subjectId);
      await removeReaction(conversation, messageId, '🏗️');
      buildingReactionSent = false;
      
      // Reply to the original deal message
      const publishMessage = `Published deal #${subject.subject.subjectId} ${productUrl}`;
      const replyContent = {
        reference: dealMessage.id,
        content: publishMessage,
        contentType: ContentTypeText
      };
      
      await conversation.send(replyContent, ContentTypeReply);
      
      // Cleanup
      publishableDeals.delete(messageId);
      const userKey = `${originalMessage.conversationId}:${approvalState.state.address}`;
      dealStates.delete(userKey);
      
      const totalTime = Date.now() - startTime;
      logger.info(`[${name}] Deal published successfully in ${totalTime}ms - Subject ID: ${subject.subject.subjectId}`);
    } else {
      logger.error(`[${name}] Failed to create subject in database for deal ${messageId}`);
      await removeReaction(conversation, messageId, '🏗️');
      buildingReactionSent = false;
      
      await sendErrorResponse(
        conversation, 
        originalMessage, 
        "Something went wrong. Please try again.", 
        name, 
        false
      );
    }

  } catch (err) {
    const processingTime = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] Error publishing deal: ${errorMsg} (took ${processingTime}ms)`);
    
    if (buildingReactionSent) {
      try {
        await removeReaction(conversation, messageId, '🏗️');
      } catch (reactionErr) {
        const reactionErrorMsg = reactionErr instanceof Error ? reactionErr.message : String(reactionErr);
        logger.warn(`[${name}] Failed to remove building reaction on error: ${reactionErrorMsg}`);
      }
    }
    
    await sendErrorResponse(
      conversation, 
      originalMessage, 
      "Something went wrong. Please try again.", 
      name, 
      false
    );
  }
}


/**
 * Validates that listing data contains all required fields for publication
 * Ensures title, description, pricing, inventory, and shipping info are present
 * 
 * @param listing - Listing data to validate
 * @returns True if all required fields are present and valid
 */
function isValidListing(listing: ListingData): boolean {
  const isValid = !!(listing.title && listing.description && listing.priceValue && 
           listing.priceAsset && listing.inventory != null && 
           listing.deliverable != null);
  
  if (!isValid) {
    logger.debug(`[${name}] Invalid listing data: hasTitle=${!!listing.title}, hasDescription=${!!listing.description}, hasPriceValue=${!!listing.priceValue}, hasPriceAsset=${!!listing.priceAsset}, hasInventory=${listing.inventory != null}, hasDeliverable=${listing.deliverable != null}`);
  }
  
  return isValid;
}