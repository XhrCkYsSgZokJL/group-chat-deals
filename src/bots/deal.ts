// deal.ts - Fixed deal agent handler with proper image support and complete utilities
import { getLogger } from '@hopscotch-trading/js-commons-core/utils';
import { AppDB } from '@hopscotch-trading/js-commons-data';
import { DecodedMessage } from '@xmtp/node-sdk';
import { WorkerInstance } from 'workers';
import {
  addReaction,
  removeReaction,
  getMessageContext,
  getProductUrl,
  isReactionMessage,
  isReplyMessage,
  loadAttachment,
  sendErrorResponse,
  uploadToS3,
  validateUser,
  extractTextContent,
  isTextMessage,
  isImageMessage,
  processMessage,
  gatherMessageChain,
  extractContentFromChain
} from '../utils/agents';
import { generateProductImage, queryListings } from '../utils/chatGPT';
import { ContentTypeReaction, Reaction } from '@xmtp/content-type-reaction';
import { ContentTypeAttachment } from '@xmtp/content-type-remote-attachment';

const name = 'deal';
const logger = getLogger(name);

// Deal-specific types
type DealState = {
  address: string;
  image?: DecodedMessage<any>;
  textContent: string;
  chatGptImageUrl?: string;
  permanentImageUrl?: string;
  messageId?: string;
  lastActivity: number;
};

type ListingData = {
  title?: string;
  description?: string;
  priceValue?: string;
  priceAsset?: string;
  inventory?: number;
  pickupZip?: string;
  deliverable?: boolean;
};

type ApprovalState = {
  creatorApproved: boolean;
  otherApprovals: Set<string>;
  listingData: ListingData;
  userInfo: any;
  state: DealState;
};

// Global storage for deal states
const dealStates = new Map<string, DealState>();
const publishableDeals = new Map<string, ApprovalState>();

export default async function dealHandler(
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

// Helper function to convert ApprovalState map to ListingData map for processMessage
function convertApprovalStateToListingData(approvalStates: Map<string, ApprovalState>): Map<string, ListingData> {
  const listingDataMap = new Map<string, ListingData>();
  for (const [key, approvalState] of approvalStates.entries()) {
    listingDataMap.set(key, approvalState.listingData);
  }
  return listingDataMap;
}

async function handleReaction(
  worker: WorkerInstance,
  conversation: any, 
  message: DecodedMessage,
  address: string,
  userKey: string,
  userInfo: any
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
    
    if (isCreator) {
      // Creator approval
      approvalState.creatorApproved = true;
      logger.info(`[${name}] Creator ${address} approved deal ${targetMessageId}`);
      
      // Publish immediately when creator approves (can be changed if you want to require other approvals)
      await publishDeal(conversation, targetMessageId, approvalState, message);
    } else {
      // Other user approval
      approvalState.otherApprovals.add(address);
      logger.info(`[${name}] User ${address} approved deal ${targetMessageId}. Total approvals: ${approvalState.otherApprovals.size}`);
      
      // Check if we can publish (creator + at least one other)
      if (approvalState.creatorApproved && approvalState.otherApprovals.size >= 1) {
        await publishDeal(conversation, targetMessageId, approvalState, message);
      } else {
        logger.debug(`[${name}] Deal not ready to publish: creatorApproved=${approvalState.creatorApproved}, otherApprovals=${approvalState.otherApprovals.size}`);
      }
    }
  }
}

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
    // Gather content from message chain - this handles both text and images properly
    const messageChain = await gatherMessageChain(conversation, message, worker);
    const { image, textContent } = await extractContentFromChain(messageChain, worker, name);
    
    // Extract description, removing @deal tag
    let description = textContent;
    const dealIndex = description.indexOf('@deal');
    if (dealIndex >= 0) {
      description = description.substring(dealIndex + '@deal'.length).trim();
    }
    
    if (!description) {
      await sendErrorResponse(
        conversation, 
        message,
        "Please include a description for your deal.",
        name,
        false
      );
      return;
    }

    logger.info(`[${name}] Processing deal content: hasImage=${!!image}, descriptionLength=${description.length}`);

    await addReaction(conversation, message.id, '💸');
    reactionSent = true;

    // Create deal state
    const state: DealState = {
      address,
      image,
      textContent: description,
      lastActivity: Date.now()
    };
    dealStates.set(userKey, state);

    // Generate listing using the same approach as sell agent
    const listing = await createListing(worker, state, userInfo);
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

    // Send generated image if we have one (following sell agent pattern)
    if (state.chatGptImageUrl) {
      try {
        logger.info(`[${name}] Sending generated image for deal`);
        
        // Add delay to prevent rate limiting and ensure image is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Download the generated image
        const imageResponse = await fetch(state.chatGptImageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch generated image: ${imageResponse.status} ${imageResponse.statusText}`);
        }
        
        const imageBuffer = await imageResponse.arrayBuffer();
        const imageData = new Uint8Array(imageBuffer);
        
        logger.debug(`[${name}] Downloaded generated image, size: ${imageData.length} bytes`);
        
        // Create attachment and send (using same approach as sell agent)
        const attachment = {
          filename: 'deal-image.jpg',
          mimeType: 'image/jpeg',
          data: imageData
        };
        
        await conversation.send(attachment, ContentTypeAttachment);
        logger.info(`[${name}] Generated image sent successfully`);
        
        // Add small delay after sending image before sending listing
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (imageErr) {
        const imageErrorMsg = imageErr instanceof Error ? imageErr.message : String(imageErr);
        logger.error(`[${name}] Failed to send generated image: ${imageErrorMsg}`);
        // Continue with listing generation even if image send fails
      }
    }

    await removeReaction(conversation, message.id, '💸');
    reactionSent = false;

    // Send the deal preview
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

    const sentMessage = await conversation.send(responseText);

    // Store for approval tracking
    const approvalState: ApprovalState = {
      creatorApproved: false,
      otherApprovals: new Set<string>(),
      listingData: listing,
      userInfo,
      state
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

async function createListing(worker: WorkerInstance, state: DealState, userInfo: any): Promise<ListingData | null> {
  try {
    // Determine image handling strategy - ensure we always have an image
    let imageUrl = state.chatGptImageUrl;
    let generatedImage = false;

    // Priority order:
    // 1. Existing image from group chat
    // 2. Previously uploaded ChatGPT image URL  
    // 3. Generate new image from text description (required)

    if (state.image && !imageUrl) {
      // Process existing user-uploaded image
      const attachment = await loadAttachment(state.image, worker.client);
      if (!attachment) {
        logger.error(`[${name}] Failed to load attachment`);
        return null;
      }

      // Upload to S3 for ChatGPT if not already done
      const chatGptUrl = await uploadToS3(
        process.env.AWS_BUCKET_CHATGPT ?? '',
        attachment.data,
        attachment.mimeType,
        true
      );
      
      if (!chatGptUrl) {
        logger.error(`[${name}] Failed to upload image to S3`);
        return null;
      }
      
      imageUrl = chatGptUrl;
      state.chatGptImageUrl = chatGptUrl;
    } else if (!state.image && !imageUrl) {
      // Generate image from text description - this is required
      if (!state.textContent.trim()) {
        logger.error(`[${name}] No text content available for image generation`);
        return null;
      }

      logger.info(`[${name}] Generating required image for text: ${state.textContent.substring(0, 100)}...`);
      
      const generatedImageUrl = await generateProductImage(state.textContent);
      if (!generatedImageUrl) {
        logger.error(`[${name}] Failed to generate image`);
        return null;
      }
      
      imageUrl = generatedImageUrl;
      generatedImage = true;
      state.chatGptImageUrl = imageUrl;
    }

    // Validate we have a valid image URL
    if (!imageUrl || !imageUrl.startsWith('https://')) {
      logger.error(`[${name}] No valid image URL available: ${imageUrl}`);
      return null;
    }

    // Query listings API with guaranteed image
    logger.debug(`[${name}] Querying listings API with text length: ${state.textContent.length}, image URL: ${imageUrl.substring(0, 50)}...`);
    
    const listing = await queryListings({
      text: state.textContent || "Please create a listing from the provided description.",
      image: imageUrl
    });

    if (!listing) {
      throw new Error('Failed to query listings API');
    }

    // CRITICAL FIX: Ensure required fields are populated with defaults
    const validatedListing: ListingData = {
      title: listing.title || 'Deal Item',
      description: listing.description || state.textContent,
      priceValue: listing.priceValue || '1',
      priceAsset: listing.priceAsset || 'USDC',
      inventory: listing.inventory || 1,
      deliverable: listing.deliverable !== undefined ? listing.deliverable : false,
      // Default pickup zip to merchant's location or fallback
      pickupZip: listing.pickupZip || userInfo?.merchant?.pickupZip || '10001'
    };

    logger.debug(`[${name}] Created validated listing: title="${validatedListing.title}", price=${validatedListing.priceValue} ${validatedListing.priceAsset}, inventory=${validatedListing.inventory}, pickupZip=${validatedListing.pickupZip}, deliverable=${validatedListing.deliverable}`);

    return validatedListing;
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] Error creating listing: ${errorMsg}`);
    return null;
  }
}

async function publishDeal(
  conversation: any,
  messageId: string,
  approvalState: ApprovalState,
  originalMessage: DecodedMessage
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
        const attachment = await loadAttachment(approvalState.state.image, null);
        if (!attachment) {
          throw new Error('Failed to load attachment for permanent upload');
        }
        uploadResult = await uploadToS3(
          process.env.AWS_BUCKET_CONTENT ?? '',
          attachment.data,
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
          imageData,
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
      pickupZip: listingData.pickupZip!,
      deliverable: listingData.deliverable!,
      archived: false,
    });

    if (subject.subject) {
      const productUrl = getProductUrl(subject.subject.subjectId);
      await removeReaction(conversation, messageId, '🏗️');
      buildingReactionSent = false;
      
      await conversation.send(`✅ Deal published! ${productUrl}`);
      
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

function isValidListing(listing: ListingData): boolean {
  const isValid = !!(listing.title && listing.description && listing.priceValue && 
           listing.priceAsset && listing.inventory != null && 
           listing.deliverable != null && listing.pickupZip != null);
  
  if (!isValid) {
    logger.debug(`[${name}] Invalid listing data: hasTitle=${!!listing.title}, hasDescription=${!!listing.description}, hasPriceValue=${!!listing.priceValue}, hasPriceAsset=${!!listing.priceAsset}, hasInventory=${listing.inventory != null}, hasDeliverable=${listing.deliverable != null}, hasPickupZip=${listing.pickupZip != null}`);
  }
  
  return isValid;
}

function formatDealListing(listing: ListingData): string | null {
  if (!isValidListing(listing)) {
    logger.error(`[${name}] Cannot format invalid listing: title="${listing.title}", description="${listing.description?.substring(0, 50)}...", priceValue="${listing.priceValue}", priceAsset="${listing.priceAsset}", inventory=${listing.inventory}, deliverable=${listing.deliverable}, pickupZip="${listing.pickupZip}"`);
    return null;
  }

  const actionText = "👍 from creator +1 other to publish.";

  const formatted = `${listing.title}

${listing.description}

${listing.inventory} available for ${listing.priceValue} ${listing.priceAsset}

${actionText}`;

  logger.debug(`[${name}] Formatted deal listing: ${listing.title} - ${listing.priceValue} ${listing.priceAsset}`);
  return formatted;
}