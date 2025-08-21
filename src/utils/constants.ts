import packageInfo from '../../package.json' assert { type: 'json' };

export const appName = packageInfo.name;
export const appVersion = packageInfo.version;

// Bot configuration
export const botTags = ['hopscotch', 'xmtp.hopscotch.eth'];
export const botName = 'hopscotch';

// listings
export const listingsModel = 'gpt-4o-mini';
export const listingsPrompt = `
You are a master AI storyteller and value architect.

Schema:
- Create magnetic, curiosity-sparking titles
- Write benefit-rich, emotional descriptions (<250 chars)
- Highlight uniqueness/rarity, luxury when fitting
- Infer missing details to make listings feel complete
- Suggest aspirational yet fair whole-number pricing

Rules:
- Inventory = 9999 for digital/services; else default 1
- PriceAsset = USDC by default
- Deliverable defaults to false
- Deliverable = true if shipping/delivery/mail/send is mentioned OR if physical item with no pickup mentioned
- Deliverable = false if pickup is mentioned (keywords: "pickup", "from", "meet", "available in", "located in", "local", city names, ZIPs)
- When pickup mentioned, set pickupZip
- Digital/services always deliverable = false, no pickupZip
`.trim();

export const listingsName = 'generate_listing';
export const listingsDesc = 'Generate a high-converting product listing JSON.';
export const listingsSchema = {
  type: "object",
  properties: {
    title: {
      type: "string"
    },
    description: {
      type: "string"
    },
    priceValue: {
      type: "string"
    },
    priceAsset: {
      type: "string",
      default: "USDC"
    },
    inventory: {
      type: "number",
      default: 1
    },
    deliverable: {
      type: "boolean",
      default: false
    },
    pickupZip: {
      type: "string"
    }
  },
  required: [
    "title",
    "description",
    "priceValue",
    "priceAsset",
    "inventory",
    "deliverable"
  ],
  additionalProperties: false
};

// modification prompts
export const modificationPromptTemplate = `
MODIFICATION REQUEST: {text}

EXISTING LISTING:
Title: {title}
Description: {description}
Price: {priceValue} {priceAsset}
Inventory: {inventory}
Deliverable: {deliverable}
Pickup ZIP: {pickupZip}

Instructions:
- If request changes product type/details, rewrite title, description, price, etc.
- For minor edits (e.g. "make it $500 cheaper", "add blue"), only adjust relevant fields
- Prioritize accurate product info over preserving old text
- Delivery logic:
  * Pickup mentioned → deliverable = false, set pickupZip
  * Shipping/delivery mentioned → deliverable = true, clear pickupZip
  * "Remove pickup" / "no pickup" → deliverable = true, clear pickupZip
  * "Remove delivery" / "no shipping" / "pickup only" → deliverable = false, keep pickupZip if present
  * If no delivery/pickup changes mentioned, keep current values
`.trim();

export const modificationSystemPrompt = '\n\nWhen modifying listings, prioritize accuracy over preservation. If the user corrects the product type or provides new product details, update all relevant fields to match their actual product.';

// image generation
export const imagePromptTemplate = `Create a clean, professional product image for: {description}. 
Style: Product photography, white or clean background, well-lit, high quality, commercial style. 
Focus on making the product look appealing and professional for an e-commerce listing.
IMPORTANT: Do not include any price, cost, or monetary information in the image.`;
