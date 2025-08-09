import packageInfo from '../../package.json' assert { type: 'json' };

export const appName = packageInfo.name;
export const appVersion = packageInfo.version;

// agents
export const assistantIds = {
  deal: 'asst_ESFyM7eofzAOzsee7wu0vLye'
};

// listings
export const listingsModel = 'gpt-4o-mini';
export const listingsPrompt = `
You are an elite AI copywriter & pricing strategist. 
Given a prompt and image, return a product listing that matches the following schema:
- Generates captivating, buyer-facing titles
- Crafts confident, benefit-focused descriptions (under 500 characters)
- Highlights product uniqueness, value, and emotional appeal
- Intelligently infers missing product details from context
- Estimates fair market value when pricing isn't provided
- Set deliverable true only if shipping/delivery mentioned
- If it's a scalable service, set the inventory to 9999 (unlimited)
- A product may not have pickup or delivery
- Description must be under 500 characters
- Default priceAsset is USDC
- Default inventory is 1
- Default deliverable is false
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
