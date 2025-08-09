import { errorString, getLogger } from '@hopscotch-trading/js-commons-core/utils';
import OpenAI from 'openai';
import { assistantIds, listingsDesc, listingsModel, listingsName, listingsPrompt, listingsSchema } from './constants';
import { QuerySell } from '../../types';

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

export async function queryListings({
  text,
  image,
}: QuerySell): Promise<any> {
  if (!initialized) {
    throw new Error('OpenAi not initialized');
  }

  try {
    // Build the content array dynamically
    const contentArray: any[] = [
      {
        type: 'text',
        text: text,
      },
    ];

    // Only add image_url if image is provided and valid
    if (image && image.startsWith('https://')) {
      contentArray.push({
        type: 'image_url',
        image_url: {
          url: image,
        },
      });
      logger.debug('Including image in listings query:', image.substring(0, 50));
    } else {
      logger.debug('Processing text-only listing query');
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
    logger.debug('OpenAi listing result: %s', result);
    const parsed = JSON.parse(result ?? '{}');
    
    return parsed;
  } catch (error) {
    logger.error('OpenAi listing processing error: %s', errorString(error));
    return 'Internal error';
  }
}

// Generate product image using DALL-E
export async function generateProductImage(description: string): Promise<string | null> {
  if (!initialized) {
    throw new Error('OpenAi not initialized');
  }

  try {
    logger.debug('Generating product image with DALL-E for description:', description.substring(0, 100));
    
    // Create a more descriptive prompt for product images
    const prompt = `Create a clean, professional product image for: ${description}. 
    Style: Product photography, white or clean background, well-lit, high quality, commercial style. 
    Focus on making the product look appealing and professional for an e-commerce listing.`;

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

    logger.info(`Product image generated successfully: ${imageUrl.substring(0, 50)}...`);
    return imageUrl;

  } catch (error) {
    logger.error('DALL-E image generation error: %s', errorString(error));
    return null;
  }
}
