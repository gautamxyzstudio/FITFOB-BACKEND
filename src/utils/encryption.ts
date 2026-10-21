import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12-byte IV standard for AES-GCM (fully compatible with browser Web Crypto API)
const TAG_LENGTH = 16; // 16-byte auth tag

/**
 * Derives a 32-byte (256-bit) encryption key from the environment secret
 */
export function getEncryptionKey(): Buffer {
  const secret = process.env.GEMINI_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("GEMINI_ENCRYPTION_KEY is not defined in the environment variables");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Checks if a string is already in encrypted format: <12-byte hex IV>:<combined ciphertext and tag hex>
 */
export function isEncrypted(value?: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  const [ivHex, dataHex] = parts;
  // 12 bytes IV = 24 hex characters, data must include at least 16 bytes tag = 32 hex characters
  return /^[0-9a-fA-F]{24}$/.test(ivHex) && /^[0-9a-fA-F]{32,}$/.test(dataHex);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Compatible with both Node.js and Browser Web Crypto API (crypto.subtle).
 * Format: <iv_hex>:<ciphertext_and_tag_hex>
 */
export function encrypt(text?: string | null): string {
  if (!text || typeof text !== "string") {
    return (text as any) ?? "";
  }

  // Prevent double encryption
  if (isEncrypted(text)) {
    return text;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Combine ciphertext and auth tag at the end (standard Web Crypto layout)
  const combined = Buffer.concat([ciphertext, tag]);

  return `${iv.toString("hex")}:${combined.toString("hex")}`;
}

/**
 * Decrypts an encrypted string created by encrypt().
 * If not in encrypted format, returns the string as-is.
 */
export function decrypt(encryptedText?: string | null): string {
  if (!encryptedText || typeof encryptedText !== "string") {
    return (encryptedText as any) ?? "";
  }

  if (!isEncrypted(encryptedText)) {
    return encryptedText;
  }

  const [ivHex, combinedHex] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const combined = Buffer.from(combinedHex, "hex");

  if (combined.length < TAG_LENGTH) {
    throw new Error("Invalid encrypted data length");
  }

  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
