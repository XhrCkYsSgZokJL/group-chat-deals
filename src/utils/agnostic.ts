// Platform-agnostic utilities that can be used with any messaging platform
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getHopscotchEnv } from '@hopscotch-trading/js-commons-core/lang';
import { InSeconds, getLogger } from '@hopscotch-trading/js-commons-core/utils';
import { AppDB } from '@hopscotch-trading/js-commons-data';
import { v4 } from 'uuid';

const logger = getLogger('platform-agnostic');

const s3Client = new S3Client({
  region: process.env.AWS_REGION
});

// Product listing data structure for deal creation
export type ListingData = {
  title?: string;
  description?: string;
  priceValue?: string;
  priceAsset?: string;
  inventory?: number;
  pickupZip?: string;
  deliverable?: boolean;
};

// Global storage for publishable listings (platform-agnostic)
export const publishableListings = new Map<string, ListingData>();

// Validate user has a store on Hopscotch platform
export async function validateUser(address: string) {
  try {
    logger.debug(`[platform-agnostic] Validating user ${address}`);
    
    address = "0xF69c8B1261b38352eAd7B91421dA38F5fd261EC9"; // prod (testing)

    const user = await AppDB.getUserByWallet(address);
    if (!user) {
      logger.debug(`[platform-agnostic] No user found for address ${address}`);
      return null;
    }

    const merchant = await AppDB.getMerchantByUserId(user.did as string);
    if (!merchant) {
      logger.debug(`[platform-agnostic] No merchant found for user ${user.did}`);
      return null;
    }

    logger.debug(`[platform-agnostic] User ${address} validated with merchant ${merchant.merchantId}`);
    return { user, merchant };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[platform-agnostic] Error validating user ${address}: ${errorMsg}`);
    return null;
  }
}

// Upload file to S3 with optional signed URL generation
export async function uploadToS3(
  bucket: string,
  body: Buffer, 
  mimeType: string,
  returnSignedUrl: boolean = false
): Promise<string | null> {
  if (!bucket) {
    logger.error(`[platform-agnostic] S3 bucket not specified`);
    return null;
  }

  if (!process.env.AWS_REGION) {
    logger.error(`[platform-agnostic] AWS_REGION not configured`);
    return null;
  }

  const uploadStartTime = Date.now();
  const extension = mimeType.split('/')[1] || 'bin';
  const key = `usercontent/${getHopscotchEnv()}/${v4()}.${extension}`;

  logger.debug(`[platform-agnostic] S3 upload: bucket=${bucket}, key=${key}, size=${body.length} bytes`);

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        // Pass the Buffer directly to Body
        Body: body, 
        ContentType: mimeType
      },
    });

    await upload.done();
    const uploadTime = Date.now() - uploadStartTime;
    logger.info(`[platform-agnostic] S3 upload completed in ${uploadTime}ms`);

    if (returnSignedUrl) {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: InSeconds.FifteenMinutes });
      
      if (!signedUrl?.startsWith('https://')) {
        throw new Error('Invalid signed URL generated');
      }
      
      logger.debug(`[platform-agnostic] Generated signed URL`);
      return signedUrl;
    }

    return `https://s3.${process.env.AWS_REGION}.amazonaws.com/${bucket}/${key}`;
    
  } catch (err) {
    const uploadTime = Date.now() - uploadStartTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[platform-agnostic] S3 upload failed after ${uploadTime}ms: ${errorMsg}`);
    logger.error(`[platform-agnostic] S3 config: region=${process.env.AWS_REGION}, bucket=${bucket}`);
    return null;
  }
}

// Generate product URL for different environments
export function getProductUrl(subjectId: number): string {
  const env = process.env.HS_ENV;
  const subdomain = env === 'test' ? 'test.' : env === 'dev' ? 'dev.' : '';
  const url = `https://${subdomain}hopscotch.trade/store/products/${subjectId}`;
  logger.debug(`[platform-agnostic] Generated product URL: ${url}`);
  return url;
}

// Check if text message is tagged with any of the bot tags
export function isTaggedMessage(text: string, tags: string | string[]): boolean {
  const tagsArray = Array.isArray(tags) ? tags : [tags];
  return tagsArray.some(tag => text.includes(`@${tag}`));
}

// Extract description by removing any bot tag
export function extractDescription(text: string, tags: string | string[]): string {
  const tagsArray = Array.isArray(tags) ? tags : [tags];
  let cleanedText = text.trim();
  
  // Find and remove the first matching tag
  for (const tag of tagsArray) {
    const tagWithAt = `@${tag}`;
    if (cleanedText.includes(tagWithAt)) {
      const tagIndex = cleanedText.indexOf(tagWithAt);
      cleanedText = cleanedText.substring(tagIndex + tagWithAt.length).trim();
      break;
    }
  }
  
  return cleanedText;
}

// Text processing utilities (platform-agnostic)
export function cleanTagFromText(text: string, tags: string | string[]): string {
  const tagsArray = Array.isArray(tags) ? tags : [tags];
  let cleanedText = text;
  
  // Remove all matching tags (with @ prefix)
  for (const tag of tagsArray) {
    const tagWithAt = `@${tag}`;
    cleanedText = cleanedText.replace(tagWithAt, '');
  }
  
  return cleanedText.trim();
}

export function combineTextParts(textParts: string[], separator: string = ' '): string {
  return textParts.join(separator);
}

// Validation utilities
export function isValidDescription(description: string, minLength: number = 3): boolean {
  return description.trim().length >= minLength;
}

export function validateListingData(data: Partial<ListingData>): boolean {
  // Basic validation - can be extended
  return !!(data.title || data.description);
}

// Image processing utilities
/**
 * Attempts to downsample image data to keep it under a specified size limit
 * Currently returns original data with a warning if oversized since proper image
 * processing requires additional dependencies (Sharp, Jimp, etc.)
 * 
 * @param imageData - Original image data as Uint8Array
 * @param mimeType - MIME type of the image (e.g., 'image/jpeg', 'image/png')
 * @param maxSizeBytes - Maximum allowed size in bytes (default: 1MB)
 * @returns Promise resolving to image data (currently unchanged) and size info
 */
export async function downsampleImage(
  imageData: Uint8Array,
  mimeType: string,
  maxSizeBytes: number = 1024 * 1024 // 1MB default
): Promise<{ data: Uint8Array; wasDownsampled: boolean; originalSize: number; finalSize: number }> {
  const originalSize = imageData.length;
  logger.debug(`[platform-agnostic] Image size check: ${originalSize} bytes (${mimeType}), max allowed: ${maxSizeBytes} bytes`);

  // If already under the size limit, return as-is
  if (originalSize <= maxSizeBytes) {
    logger.debug(`[platform-agnostic] Image already under size limit`);
    return {
      data: imageData,
      wasDownsampled: false,
      originalSize,
      finalSize: originalSize
    };
  }

  // Log info about oversized image - will attempt compression
  const oversizeMB = (originalSize / (1024 * 1024)).toFixed(2);
  const targetMB = (maxSizeBytes / (1024 * 1024)).toFixed(2);
  logger.info(`[platform-agnostic] Image is ${oversizeMB}MB (${mimeType}), exceeds ${targetMB}MB limit. Attempting automatic compression...`);

  // Use Sharp for high-quality image compression
  try {
    const sharp = await import('sharp');
    logger.debug(`[platform-agnostic] Using Sharp for image downsampling`);
    
    let quality = 80;
    let compressedBuffer: Buffer | undefined;
    
    // Start with the original image
    let sharpInstance = sharp.default(Buffer.from(imageData));
    
    // Get original image metadata for better compression decisions
    const metadata = await sharpInstance.metadata();
    logger.debug(`[platform-agnostic] Original image: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);
    
    // Iteratively reduce quality and/or size until under limit
    while (quality > 10) {
      try {
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
          // For JPEG, adjust quality
          compressedBuffer = await sharp.default(Buffer.from(imageData))
            .jpeg({ quality, progressive: true })
            .toBuffer();
        } else if (mimeType.includes('png')) {
          // For PNG, use compression level and reduce to palette if possible
          compressedBuffer = await sharp.default(Buffer.from(imageData))
            .png({ 
              compressionLevel: 9,
              palette: true,
              quality
            })
            .toBuffer();
        } else {
          // Convert other formats to JPEG
          compressedBuffer = await sharp.default(Buffer.from(imageData))
            .jpeg({ quality, progressive: true })
            .toBuffer();
        }
        
        // Check if we're under the size limit
        if (compressedBuffer.length <= maxSizeBytes) {
          const compressedData = new Uint8Array(compressedBuffer);
          logger.info(`[platform-agnostic] Sharp compression successful: ${originalSize} → ${compressedData.length} bytes (quality: ${quality}%)`);
          
          return {
            data: compressedData,
            wasDownsampled: true,
            originalSize,
            finalSize: compressedData.length
          };
        }
        
        // If still too big, reduce quality further
        quality -= 10;
        
      } catch (sharpIterationErr) {
        logger.debug(`[platform-agnostic] Sharp quality ${quality} failed, trying lower quality`);
        quality -= 10;
      }
    }
    
    // If quality reduction wasn't enough, try resizing the image
    if (compressedBuffer && compressedBuffer.length > maxSizeBytes) {
      logger.debug(`[platform-agnostic] Quality reduction insufficient, attempting resize`);
      
      const compressionRatio = Math.sqrt(maxSizeBytes / originalSize);
      const newWidth = Math.floor((metadata.width || 800) * compressionRatio);
      const newHeight = Math.floor((metadata.height || 600) * compressionRatio);
      
      try {
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
          compressedBuffer = await sharp.default(Buffer.from(imageData))
            .resize(newWidth, newHeight, { fit: 'inside' })
            .jpeg({ quality: 75, progressive: true })
            .toBuffer();
        } else {
          compressedBuffer = await sharp.default(Buffer.from(imageData))
            .resize(newWidth, newHeight, { fit: 'inside' })
            .jpeg({ quality: 75, progressive: true }) // Convert to JPEG for better compression
            .toBuffer();
        }
        
        const compressedData = new Uint8Array(compressedBuffer);
        logger.info(`[platform-agnostic] Sharp resize compression successful: ${originalSize} → ${compressedData.length} bytes (${newWidth}x${newHeight})`);
        
        return {
          data: compressedData,
          wasDownsampled: true,
          originalSize,
          finalSize: compressedData.length
        };
        
      } catch (resizeErr) {
        const resizeErrorMsg = resizeErr instanceof Error ? resizeErr.message : String(resizeErr);
        logger.warn(`[platform-agnostic] Sharp resize failed: ${resizeErrorMsg}`);
      }
    }
    
  } catch (sharpErr) {
    const sharpErrorMsg = sharpErr instanceof Error ? sharpErr.message : String(sharpErr);
    logger.warn(`[platform-agnostic] Sharp compression failed: ${sharpErrorMsg}`);
  }

  // Final fallback: Basic size limit enforcement
  if (originalSize > maxSizeBytes * 2) {
    // If image is more than 2x the limit, refuse to send it
    logger.error(`[platform-agnostic] Image too large (${oversizeMB}MB) for group chat. Install image processing library for compression.`);
    throw new Error(`Image size ${oversizeMB}MB exceeds reasonable limit for group chat. Maximum recommended: ${targetMB}MB`);
  }

  // Return original with strong warning - Sharp compression failed or insufficient
  logger.error(`[platform-agnostic] Unable to compress image below ${targetMB}MB limit. Current size: ${oversizeMB}MB. Image may fail in group chat.`);
  return {
    data: imageData,
    wasDownsampled: false,
    originalSize,
    finalSize: originalSize
  };
}