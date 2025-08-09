// deal.ts - Main deal agent handler
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
  gatherMessageContent
} from '../utils/agents';
import { generateProductImage, queryListings } from '../utils/chatGPT';
import { ContentTypeReaction, Reaction } from '@xmtp/content-type-reaction';

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
  title: string;
  description: string;
  priceValue: string;
  priceAsset: string;
  inventory: number;
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
    logger.info(`[${name}] Processing message ${message.id} from conversation ${message.conversationId}`);
    
    const context = await getMessageContext(worker, message);
    if (!context) {
      logger.warn(`[${name}] Unable to get message context for ${message.id}`);
      return;
    }

    const { conversation, address, isDM, userKey } = context;
    
    // Only process group messages
    if (isDM) {
      await sendErrorResponse(
        conversation, 
        "This bot is only available in group chats."
      );
      return;
    }

    // Check if this is a reaction
    if (isReactionMessage(message)) {
      // Type guard and cast the content to Reaction
      if (!message.content || typeof message.content !== 'object') {
        logger.warn(`[${name}] Invalid reaction content structure`);
        return;
      }
      
      const reaction = message.content as Reaction;
      
      // Only process reactions on our own messages
      if (!publishableDeals.has(reaction.reference)) {
        return;
      }
      
      // Proceed with validation
      const userInfo = await validateUser(address);
      if (!userInfo) {
        await sendErrorResponse(
          conversation, 
          "Open a Store on Hopscotch.trade to publish."
        );
        return;
      }

      await handleReaction(worker, conversation, message, address, userKey);
      return;
    }

    // Check if this is a reply to our message OR contains @deal
    let isReplyToUs = false;
    if (isReplyMessage(message)) {
      // Type guard for reply content
      if (message.content && typeof message.content === 'object' && 'reference' in message.content) {
        const replyToId = (message.content as any).reference; 
        isReplyToUs = publishableDeals.has(replyToId);
      }
    }

    // Extract text content to check for @deal tag
    const textContent = extractTextContent(message);
    const hasAtDealTag = textContent.includes('@deal');

    // Only proceed if message has @deal tag (regardless of reply status)
    if (!hasAtDealTag) {
      return;
    }

    // NOW we know the message is intended for us, do validation
    const userInfo = await validateUser(address);
    if (!userInfo) {
      await sendErrorResponse(
        conversation, 
        "Open a Store on Hopscotch.trade to continue."
      );
      return;
    }

    // Process the tagged content
    const dealIndex = textContent.indexOf('@deal');
    const description = textContent.substring(dealIndex + '@deal'.length).trim();
    if (!description) {
      await sendErrorResponse(
        conversation, 
        "Please include a description for your deal."
      );
      return;
    }

    // Gather content from message chain (including images from previous messages)
    const { image, fullDescription } = await gatherMessageContent(conversation, message, description);

    await processContentMessage(worker, conversation, message, address, userKey, fullDescription, image);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    const processingTime = Date.now() - startTime;
    logger.error(`[${name}] Error handling message ${message.id}: ${errorMsg} (took ${processingTime}ms)`);
  }
}

async function handleReaction(
  worker: WorkerInstance,
  conversation: any, 
  message: DecodedMessage,
  address: string,
  userKey: string
) {
  // Type guard for reaction content
  if (!message.content || typeof message.content !== 'object') {
    logger.warn(`[${name}] Invalid reaction content structure`);
    return;
  }
  
  const reaction = message.content as Reaction;
  
  // Normalize reaction content
  let normalizedContent = reaction.content;
  if (reaction.content === '+1' || reaction.content === '👍') {
    normalizedContent = '👍';
  } else if (reaction.content === '-1' || reaction.content === '👎') {
    normalizedContent = '👎';
  }
  
  if (reaction.action !== 'added' || normalizedContent !== '👍') {
    return; // Only process thumbs up reactions
  }

  const approvalState = publishableDeals.get(reaction.reference);
  if (!approvalState) {
    return; // No deal to approve
  }

  const isCreator = address === approvalState.state.address;
  
  if (isCreator) {
    // Creator approval
    approvalState.creatorApproved = true;
    logger.info(`[${name}] Creator ${address} approved deal ${reaction.reference}`);
  } else {
    // Other user approval
    approvalState.otherApprovals.add(address);
    logger.info(`[${name}] User ${address} approved deal ${reaction.reference}. Total approvals: ${approvalState.otherApprovals.size}`);
  }

  // Check if we can publish (creator + at least one other)
  if (approvalState.creatorApproved && approvalState.otherApprovals.size >= 1) {
    await publishDeal(conversation, reaction.reference, approvalState, message);
  }
}

async function processContentMessage(
  worker: WorkerInstance,
  conversation: any,
  message: DecodedMessage,
  address: string,
  userKey: string,
  description: string,
  image?: DecodedMessage<any>
) {
  await addReaction(conversation, message.id, '💸');
  
  try {
    // Create deal state
    const state: DealState = {
      address,
      image,
      textContent: description,
      lastActivity: Date.now()
    };
    dealStates.set(userKey, state);

    // Generate listing
    const listing = await createListing(worker, state);
    if (!listing) {
      await sendErrorResponse(
        conversation, 
        "Failed to create deal listing. Please try again."
      );
      return;
    }

    // Send the generated image if we have one
    if (state.chatGptImageUrl) {
      try {
        logger.info(`[${name}] Sending generated image: ${state.chatGptImageUrl}`);
        await conversation.send(state.chatGptImageUrl);
        
        // Add 1 second delay after sending image
        await new Promise(resolve => setTimeout(resolve, 1000));
        logger.debug(`[${name}] Added 1 second delay after image`);
      } catch (err) {
        logger.warn(`[${name}] Failed to send generated image: ${err}`);
      }
    }

    // Send the deal preview
    const responseText = formatDealListing(listing);
    const sentMessage = await conversation.send(responseText);
    
    // Store for approval tracking
    const userInfo = await validateUser(address);
    const approvalState: ApprovalState = {
      creatorApproved: false,
      otherApprovals: new Set<string>(),
      listingData: listing,
      userInfo,
      state
    };
    
    publishableDeals.set(sentMessage.id, approvalState);
    state.messageId = sentMessage.id;

  } catch (err) {
    logger.error(`[${name}] Error processing content: ${err}`);
    await sendErrorResponse(
      conversation, 
      "Something went wrong. Please try again."
    );
  } finally {
    await removeReaction(conversation, message.id, '💸');
  }
}

async function createListing(worker: WorkerInstance, state: DealState): Promise<ListingData | null> {
  try {
    let userProvidedImageUrl: string | undefined;
    let shouldGenerateImage = false;
    
    // Handle user-provided images (uploaded or from replies)
    if (state.image && !state.chatGptImageUrl) {
      const attachment = await loadAttachment(state.image, worker.client);
      if (attachment) {
        const uploadedUrl = await uploadToS3(
          process.env.AWS_BUCKET_CHATGPT ?? '',
          attachment.data,
          attachment.mimeType,
          true
        );
        if (uploadedUrl) {
          userProvidedImageUrl = uploadedUrl;
          state.chatGptImageUrl = uploadedUrl; // Store for chat display
        }
      }
    }
    
    // If no user-provided image, we'll need to generate one for display
    if (!userProvidedImageUrl && !state.chatGptImageUrl) {
      shouldGenerateImage = true;
    }
    
    // Run listings query and image generation in parallel
    const promises: Promise<any>[] = [];
    
    // Always query listings API
    promises.push(
      queryListings({
        text: state.textContent,
        image: userProvidedImageUrl // Only include user-provided images, not generated ones
      })
    );
    
    // Generate image for display if needed
    if (shouldGenerateImage) {
      promises.push(generateProductImage(state.textContent));
    }
    
    const results = await Promise.all(promises);
    const listing = results[0];
    
    // Store generated image if we created one
    if (shouldGenerateImage && results[1]) {
      state.chatGptImageUrl = results[1];
    }
    
    if (!listing) {
      throw new Error('Failed to query listings API');
    }

    return listing;
    
  } catch (err) {
    logger.error(`[${name}] Error creating listing: ${err}`);
    return null;
  }
}

async function publishDeal(
  conversation: any,
  messageId: string,
  approvalState: ApprovalState,
  originalMessage: DecodedMessage
) {
  await addReaction(conversation, messageId, '🏗️');
  
  try {
    const { listingData, userInfo, state } = approvalState;
    
    // Ensure we have a permanent image URL
    let permanentImageUrl = state.permanentImageUrl;
    
    if (!permanentImageUrl && state.chatGptImageUrl) {
      // Download generated image and upload permanently
      const imageResponse = await fetch(state.chatGptImageUrl);
      if (imageResponse.ok) {
        const imageBuffer = await imageResponse.arrayBuffer();
        const imageData = new Uint8Array(imageBuffer);
        
        const permanentImageUrl = await uploadToS3(
          process.env.AWS_BUCKET_CONTENT ?? '',
          imageData,
          'image/jpeg',
          false
        );

        if (permanentImageUrl) {
          state.permanentImageUrl = permanentImageUrl;
        }
        
      }
    }

    if (!permanentImageUrl) {
      throw new Error('No permanent image URL available');
    }

    const strippedImageUrl = permanentImageUrl.replace(
      `.s3.${process.env.AWS_REGION}.amazonaws.com`, 
      ''
    );

    // Create subject in database
    const subject = await AppDB.createSubject({
      did: userInfo.user.did,
      merchantId: userInfo.merchant.merchantId,
      title: listingData.title,
      description: listingData.description,
      imageUrl: strippedImageUrl,
      priceValue: listingData.priceValue,
      priceAsset: listingData.priceAsset,
      priceAssetChain: 8453,
      paymentAsset: listingData.priceAsset,
      paymentAssetChain: 8453,
      inventory: listingData.inventory,
      pickupZip: listingData.pickupZip || '',
      deliverable: listingData.deliverable || false,
      archived: false,
    });

    if (subject.subject) {
      const productUrl = getProductUrl(subject.subject.subjectId);
      await conversation.send(`✅ Deal published! ${productUrl}`);
      
      // Cleanup
      publishableDeals.delete(messageId);
      dealStates.delete(`${originalMessage.conversationId}:${state.address}`);
      
      logger.info(`[${name}] Deal published successfully - Subject ID: ${subject.subject.subjectId}`);
    } else {
      throw new Error('Failed to create subject in database');
    }

  } catch (err) {
    logger.error(`[${name}] Error publishing deal: ${err}`);
    await sendErrorResponse(
      conversation, 
      "Failed to publish deal. Please try again."
    );
  } finally {
    await removeReaction(conversation, messageId, '🏗️');
  }
}

function formatDealListing(listing: ListingData): string {
  const actionText = "👍 from creator + 1 other to publish this deal!";

  return `🤝 DEAL: ${listing.title}

${listing.description}

${listing.inventory} available for ${listing.priceValue} ${listing.priceAsset}

${actionText}`;
}