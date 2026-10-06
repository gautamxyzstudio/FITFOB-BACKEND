import s3Provider from "@strapi/provider-upload-aws-s3";
import sharp from "sharp";
import { Readable } from "stream";
import fs from "fs";

// Disable sharp file cache to prevent Windows EPERM file locking
sharp.cache(false);

interface CompressionConfig {
  maxWidth?: number;
  maxHeight?: number;
  jpegQuality?: number;
  pngQuality?: number;
  webpQuality?: number;
  avifQuality?: number;
  tiffQuality?: number;
}

interface ProviderInitOptions {
  baseUrl?: string;
  rootPath?: string;
  s3Options?: any;
  providerConfig?: any;
  compression?: CompressionConfig;
  [key: string]: any;
}

const RASTER_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
  "image/tif",
]);

const RASTER_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
]);

function isRasterImage(file: any): boolean {
  if (!file) return false;
  const mime = (file.mime || file.mimetype || "").toLowerCase();
  const ext = (file.ext || "").toLowerCase();

  // Explicitly ignore SVGs (vector XML)
  if (mime === "image/svg+xml" || ext === ".svg") {
    return false;
  }

  // Explicitly ignore PDFs
  if (mime === "application/pdf" || ext === ".pdf") {
    return false;
  }

  if (RASTER_MIME_TYPES.has(mime) || RASTER_EXTENSIONS.has(ext)) {
    return true;
  }

  if (mime.startsWith("image/") && !mime.includes("svg") && !mime.includes("xml")) {
    return true;
  }

  return false;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function getFileBuffer(file: any): Promise<Buffer | null> {
  if (file.buffer) {
    return Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
  }
  if (typeof file.getStream === "function") {
    return streamToBuffer(file.getStream());
  }
  if (file.stream) {
    return streamToBuffer(file.stream);
  }
  if (file.filepath && fs.existsSync(file.filepath)) {
    return fs.promises.readFile(file.filepath);
  }
  return null;
}

export async function compressFile(
  file: any,
  compressionConfig: CompressionConfig = {},
): Promise<void> {
  const fileName = file.name || file.originalFilename || file.hash || "image";

  if (!isRasterImage(file)) {
    const fileMime = file.mime || file.mimetype || file.ext || "unknown";
    const fileSizeKb = file.size ? `${file.size} KB` : "unknown size";
    console.log(
      `📄 [AWS S3 Provider] Non-image or vector file detected (${fileMime}): "${fileName}" (${fileSizeKb}) -> Storing in AWS S3 directly`,
    );
    return;
  }

  try {
    const inputBuffer = await getFileBuffer(file);
    if (!inputBuffer || inputBuffer.length === 0) {
      console.log(
        `⚠️ [AWS S3 Provider] File buffer empty for "${fileName}", skipping compression`,
      );
      return;
    }

    // Double check that it's not a PDF disguised by mime
    if (inputBuffer.subarray(0, 4).toString() === "%PDF") {
      console.log(
        `📄 [AWS S3 Provider] PDF binary detected: "${fileName}" -> Storing in AWS S3 without compression`,
      );
      return;
    }

    const originalBytes = inputBuffer.length;
    const originalKb = (originalBytes / 1024).toFixed(2);

    const maxWidth = compressionConfig.maxWidth || 2048;
    const maxHeight = compressionConfig.maxHeight || 2048;
    const jpegQuality = compressionConfig.jpegQuality || 80;
    const pngQuality = compressionConfig.pngQuality || 80;
    const webpQuality = compressionConfig.webpQuality || 80;
    const avifQuality = compressionConfig.avifQuality || 75;
    const tiffQuality = compressionConfig.tiffQuality || 80;

    let pipeline = sharp(inputBuffer);
    const metadata = await pipeline.metadata();

    if (!metadata.format) {
      console.log(
        `⚠️ [AWS S3 Provider] Unrecognized image format for "${fileName}", uploading original`,
      );
      return;
    }

    const origDimensions = `${metadata.width || "?"}x${metadata.height || "?"}`;

    // Auto-rotate based on EXIF orientation
    pipeline = pipeline.rotate();

    // Resize if dimensions exceed maxWidth or maxHeight (maintaining aspect ratio without enlarging)
    if (
      (metadata.width && metadata.width > maxWidth) ||
      (metadata.height && metadata.height > maxHeight)
    ) {
      pipeline = pipeline.resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    const format = metadata.format.toLowerCase();
    const mime = (file.mime || file.mimetype || "").toLowerCase();

    if (
      format === "jpeg" ||
      format === "jpg" ||
      mime.includes("jpeg") ||
      mime.includes("jpg")
    ) {
      pipeline = pipeline.jpeg({
        quality: jpegQuality,
        mozjpeg: true,
        progressive: true,
      });
    } else if (format === "png" || mime.includes("png")) {
      pipeline = pipeline.png({
        quality: pngQuality,
        compressionLevel: 8,
        effort: 7,
      });
    } else if (format === "webp" || mime.includes("webp")) {
      pipeline = pipeline.webp({
        quality: webpQuality,
        effort: 5,
      });
    } else if (format === "avif" || mime.includes("avif")) {
      pipeline = pipeline.avif({
        quality: avifQuality,
        effort: 4,
      });
    } else if (format === "tiff" || mime.includes("tiff")) {
      pipeline = pipeline.tiff({
        quality: tiffQuality,
      });
    } else if (format === "gif" || mime.includes("gif")) {
      pipeline = sharp(inputBuffer, { animated: true }).gif();
    }

    const compressedBuffer = await pipeline.toBuffer();

    if (compressedBuffer && compressedBuffer.length > 0) {
      const isSmaller = compressedBuffer.length < inputBuffer.length;
      const wasResized =
        (metadata.width && metadata.width > maxWidth) ||
        (metadata.height && metadata.height > maxHeight);

      // Apply compressed buffer if it reduced size or resized dimensions
      if (isSmaller || wasResized) {
        const compressedMeta = await sharp(compressedBuffer).metadata();
        const compressedBytes = compressedBuffer.length;
        const compressedKb = (compressedBytes / 1024).toFixed(2);
        const newDimensions = `${compressedMeta.width || "?"}x${compressedMeta.height || "?"}`;
        const savingsPercent = (
          ((originalBytes - compressedBytes) / originalBytes) *
          100
        ).toFixed(1);

        file.buffer = compressedBuffer;
        file.size = parseFloat(compressedKb);
        if (compressedMeta.width) file.width = compressedMeta.width;
        if (compressedMeta.height) file.height = compressedMeta.height;

        // Ensure stream is updated to read from compressed buffer
        delete file.stream;
        file.getStream = () => Readable.from(compressedBuffer);

        if (file.filepath && fs.existsSync(file.filepath)) {
          try {
            await fs.promises.writeFile(file.filepath, compressedBuffer);
          } catch (_) {}
        }

        console.log(
          `✨ [AWS S3 Provider] Compressed image "${fileName}": ${originalKb} KB (${origDimensions}) -> ${compressedKb} KB (${newDimensions}) [Saved ${savingsPercent}%]`,
        );
      } else {
        console.log(
          `ℹ️ [AWS S3 Provider] Image "${fileName}" is already optimal: ${originalKb} KB (${origDimensions})`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `⚠️ [AWS S3 Provider] Image compression skipped due to error for "${fileName}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

const provider = {
  init(providerOptions: ProviderInitOptions) {
    const { compression, ...s3ProviderOptions } = providerOptions || {};
    const baseInstance = (s3Provider as any).init(s3ProviderOptions);

    return {
      ...baseInstance,

      async upload(file: any, customParams: any = {}) {
        const fileName = file.name || file.originalFilename || file.hash || "file";
        await compressFile(file, compression);
        console.log(`🚀 [AWS S3 Provider] Uploading "${fileName}" (${file.size} KB) to AWS S3...`);
        const result = await baseInstance.upload(file, customParams);
        console.log(`✅ [AWS S3 Provider] Successfully uploaded to AWS S3: "${fileName}" -> ${file.url || "Done"}`);
        return result;
      },

      async uploadStream(file: any, customParams: any = {}) {
        const fileName = file.name || file.originalFilename || file.hash || "file";
        await compressFile(file, compression);
        console.log(`🚀 [AWS S3 Provider] Uploading stream for "${fileName}" (${file.size} KB) to AWS S3...`);
        const result = await baseInstance.upload(file, customParams);
        console.log(`✅ [AWS S3 Provider] Successfully uploaded stream to AWS S3: "${fileName}" -> ${file.url || "Done"}`);
        return result;
      },

      async replace(newFile: any, oldFile: any, customParams: any = {}) {
        const fileName = newFile.name || newFile.originalFilename || newFile.hash || "file";
        await compressFile(newFile, compression);
        console.log(`🔄 [AWS S3 Provider] Replacing "${oldFile?.name || 'old file'}" with "${fileName}" (${newFile.size} KB) on AWS S3...`);
        const result = await baseInstance.replace(newFile, oldFile, customParams);
        console.log(`✅ [AWS S3 Provider] Successfully replaced file on AWS S3: "${fileName}" -> ${newFile.url || "Done"}`);
        return result;
      },

      async replaceStream(newFile: any, oldFile: any, customParams: any = {}) {
        const fileName = newFile.name || newFile.originalFilename || newFile.hash || "file";
        await compressFile(newFile, compression);
        console.log(`🔄 [AWS S3 Provider] Replacing stream for "${oldFile?.name || 'old file'}" with "${fileName}" (${newFile.size} KB) on AWS S3...`);
        const result = await baseInstance.replace(newFile, oldFile, customParams);
        console.log(`✅ [AWS S3 Provider] Successfully replaced stream on AWS S3: "${fileName}" -> ${newFile.url || "Done"}`);
        return result;
      },

      async uploadIfMatch(
        file: any,
        expectedETag: string,
        customParams: any = {},
      ) {
        const fileName = file.name || file.originalFilename || file.hash || "file";
        await compressFile(file, compression);
        console.log(`🚀 [AWS S3 Provider] Uploading with match check for "${fileName}" (${file.size} KB) to AWS S3...`);
        const result = await baseInstance.uploadIfMatch(file, expectedETag, customParams);
        console.log(`✅ [AWS S3 Provider] Successfully uploaded match file to AWS S3: "${fileName}" -> ${file.url || "Done"}`);
        return result;
      },
    };
  },
};

export default provider;
module.exports = provider;
