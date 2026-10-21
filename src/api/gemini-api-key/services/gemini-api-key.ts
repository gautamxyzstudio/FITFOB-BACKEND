/**
 * gemini-api-key service
 */

import { factories } from "@strapi/strapi";
import { decrypt, encrypt } from "../../../utils/encryption";

const GEMINI_UID = "api::gemini-api-key.gemini-api-key";

export default factories.createCoreService(
  GEMINI_UID,
  ({ strapi }) => ({
    /**
     * Retrieves the decrypted Gemini API key for internal backend use (e.g., AI calls)
     */
    async getDecryptedApiKey(): Promise<string | null> {
      try {
        let entry: any = null;

        if ((strapi as any).documents) {
          entry = await (strapi as any).documents(GEMINI_UID).findFirst();
        } else {
          entry = await strapi.db.query(GEMINI_UID).findOne();
        }

        if (!entry?.key) {
          return null;
        }

        return decrypt(entry.key);
      } catch (error) {
        strapi.log.error("Failed to retrieve or decrypt Gemini API key", error);
        return null;
      }
    },

    /**
     * Retrieves the raw encrypted key directly as stored in the database
     */
    async getEncryptedApiKey(): Promise<string | null> {
      try {
        let entry: any = null;

        if ((strapi as any).documents) {
          entry = await (strapi as any).documents(GEMINI_UID).findFirst();
        } else {
          entry = await strapi.db.query(GEMINI_UID).findOne();
        }

        return entry?.key ?? null;
      } catch (error) {
        strapi.log.error("Failed to retrieve encrypted Gemini API key", error);
        return null;
      }
    },

    /**
     * Programmatically encrypts and saves the Gemini API key
     */
    async saveApiKey(plainKey: string) {
      if (!plainKey || typeof plainKey !== "string" || !plainKey.trim()) {
        throw new Error("Invalid Gemini API key provided");
      }

      const encryptedKey = encrypt(plainKey.trim());

      return strapi.service(GEMINI_UID).createOrUpdate({
        data: {
          key: encryptedKey,
        },
      });
    },

    /**
     * Returns whether an API key has been configured
     */
    async isConfigured(): Promise<boolean> {
      const key = await this.getDecryptedApiKey();
      return Boolean(key && key.trim().length > 0);
    },
  })
);
