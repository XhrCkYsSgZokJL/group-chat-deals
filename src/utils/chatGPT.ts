import { errorString, getLogger } from '@hopscotch-trading/js-commons-core/utils';
import OpenAI from 'openai';
import { listingsDesc, listingsModel, listingsName, listingsPrompt, listingsSchema, modificationPromptTemplate, modificationSystemPrompt, imagePromptTemplate } from './constants';
import { QuerySell } from '../../types';

const logger = getLogger('utils/chatGPT');

// OpenAI client and state
let chatGPT: OpenAI;
let initialized: boolean = false;

// Initialize open ai client
export function initializeOpenAi(): void {
  if (!initialized) {
    logger.info('Initializing OpenAI');
    chatGPT = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    initialized = true;
  }
}


export async function queryListings({
  text,
  image,
}: QuerySell): Promise<any> {
  if (!initialized) {
    throw new Error('OpenAi not initialized');
  }

  try {
    // Log the input text being sent to ChatGPT
    logger.info(`📝 LISTING REQUEST TEXT: ${text}`);
    
    // Build the content array dynamically
    const contentArray: any[] = [
      {
        type: 'text',
        text: text,
      },
    ];

    // Only add image_url if image is provided and valid
    if (image && typeof image === 'string' && image.startsWith('https://')) {
      contentArray.push({
        type: 'image_url',
        image_url: {
          url: image,
        },
      });
      logger.info(`🖼️ LISTING REQUEST IMAGE: ${image}`);
    } else {
      logger.info('📄 Processing text-only listing query');
    }

    const response = await chatGPT.chat.completions.create({
      model: listingsModel,
      messages: [
        {
          role: 'system',
          content: listingsPrompt,
        },
        {
          role: 'user',
          content: contentArray,
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: listingsName,
            description: listingsDesc,
            parameters: listingsSchema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: listingsName } },
      max_tokens: 1500,
    });

    const result = response.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    logger.info(`✅ LISTING RESPONSE RAW: ${result}`);
    const parsed = JSON.parse(result ?? '{}');
    logger.info(`📋 LISTING RESPONSE PARSED: ${JSON.stringify(parsed, null, 2)}`);
    
    return parsed;
  } catch (error) {
    logger.error('OpenAi listing processing error: %s', errorString(error));
    return 'Internal error';
  }
}

// Query listings with existing listing data for modifications
export async function queryListingsWithContext({
  text,
  image,
  existingListing,
}: QuerySell & { existingListing?: any }): Promise<any> {
  if (!initialized) {
    throw new Error('OpenAi not initialized');
  }

  try {
    // Create a context-aware prompt that includes existing listing data
    let contextText = text;
    if (existingListing) {
      contextText = modificationPromptTemplate
        .replace('{text}', text)
        .replace('{title}', existingListing.title || 'N/A')
        .replace('{description}', existingListing.description || 'N/A')
        .replace('{priceValue}', existingListing.priceValue || 'N/A')
        .replace('{priceAsset}', existingListing.priceAsset || 'USDC')
        .replace('{inventory}', (existingListing.inventory || 1).toString())
        .replace('{deliverable}', existingListing.deliverable ? 'Yes' : 'No')
        .replace('{pickupZip}', existingListing.pickupZip || 'Not specified');
    }
    
    logger.info(`📝 MODIFICATION REQUEST TEXT: ${contextText}`);
    
    // Build the content array dynamically
    const contentArray: any[] = [
      {
        type: 'text',
        text: contextText,
      },
    ];

    // Only add image_url if image is provided and valid
    if (image && typeof image === 'string' && image.startsWith('https://')) {
      contentArray.push({
        type: 'image_url',
        image_url: {
          url: image,
        },
      });
      logger.info(`🖼️ MODIFICATION REQUEST IMAGE: ${image}`);
    } else {
      logger.info('📄 Processing text-only modification query');
    }

    const response = await chatGPT.chat.completions.create({
      model: listingsModel,
      messages: [
        {
          role: 'system',
          content: listingsPrompt + modificationSystemPrompt,
        },
        {
          role: 'user',
          content: contentArray,
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: listingsName,
            description: listingsDesc,
            parameters: listingsSchema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: listingsName } },
      max_tokens: 1500,
    });

    const result = response.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    logger.info(`✅ MODIFICATION RESPONSE RAW: ${result}`);
    const parsed = JSON.parse(result ?? '{}');
    logger.info(`📋 MODIFICATION RESPONSE PARSED: ${JSON.stringify(parsed, null, 2)}`);
    
    return parsed;
  } catch (error) {
    logger.error('OpenAi modification processing error: %s', errorString(error));
    return 'Internal error';
  }
}

// Generate product image using DALL-E
export async function generateProductImage(description: string): Promise<string | null> {
  if (!initialized) {
    throw new Error('OpenAi not initialized');
  }

  try {
    logger.info(`🎨 IMAGE GENERATION REQUEST: ${description}`);
    
    // Create a more descriptive prompt for product images
    const prompt = imagePromptTemplate.replace('{description}', description);
    
    logger.info(`🖼️ DALL-E PROMPT: ${prompt.substring(0, 200)}`);

    const imageResponse = await chatGPT.images.generate({
      model: "dall-e-3",
      prompt: prompt.substring(0, 1000), // DALL-E has prompt limits
      size: "1024x1024",
      quality: "standard",
      n: 1,
    });

    // Check if response and data exist
    if (!imageResponse.data || imageResponse.data.length === 0) {
      logger.error('No image data returned from DALL-E');
      return null;
    }

    const imageUrl = imageResponse.data[0]?.url;
    if (!imageUrl) {
      logger.error('No image URL returned from DALL-E');
      return null;
    }

    logger.info(`✅ IMAGE GENERATED: ${imageUrl}`);
    return imageUrl;

  } catch (error) {
    logger.error('DALL-E image generation error: %s', errorString(error));
    return null;
  }
}
