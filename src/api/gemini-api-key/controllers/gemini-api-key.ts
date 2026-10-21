/**
 * gemini-api-key controller
 */

import { factories } from "@strapi/strapi";
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12-byte IV standard for AES-GCM (fully compatible with browser Web Crypto API)

/**
 * Derives a 32-byte key from the environment secret
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.GEMINI_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("GEMINI_ENCRYPTION_KEY is not defined in the environment variables");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Checks if a string is already in encrypted format: <12-byte hex IV>:<combined ciphertext and tag hex>
 */
function isEncrypted(value?: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  const [ivHex, dataHex] = parts;
  return /^[0-9a-fA-F]{24}$/.test(ivHex) && /^[0-9a-fA-F]{32,}$/.test(dataHex);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Compatible with browser Web Crypto API (crypto.subtle).
 * Format: <iv_hex>:<ciphertext_and_tag_hex>
 */
function encrypt(text?: string | null): string {
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
  const combined = Buffer.concat([ciphertext, tag]);

  return `${iv.toString("hex")}:${combined.toString("hex")}`;
}

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";
  if (user._cachedRole) return user._cachedRole;

  if (user.role?.name || user.role?.type) {
    const role =
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      "";
    user._cachedRole = role;
    return role;
  }

  if (Array.isArray(user.roles) && user.roles.length > 0) {
    for (const r of user.roles) {
      const roleStr = (r.code || r.name || "").toLowerCase().replace(/[\s_-]+/g, "");
      if (roleStr.includes("admin") || roleStr === "superadmin") {
        user._cachedRole = roleStr;
        return roleStr;
      }
    }
  }

  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: user.id },
      select: ["id"],
      populate: {
        role: {
          select: ["id", "name", "type"],
        },
      },
    });

  const role =
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    "";
  user._cachedRole = role;
  return role;
}

/**
 * Helper to authenticate and verify that the user has Admin or Super Admin role.
 * Sets the appropriate unauthorized or forbidden response on ctx and returns false if check fails.
 */
async function ensureAdmin(ctx: any): Promise<boolean> {
  let user = ctx.state.user;

  if (!user && ctx.request?.header?.authorization?.startsWith("Bearer ")) {
    const token = ctx.request.header.authorization.slice(7).trim();
    try {
      const jwtService = strapi.plugin("users-permissions")?.service("jwt");
      if (jwtService?.verify) {
        const payload = await jwtService.verify(token);
        if (payload?.id) {
          user = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: payload.id },
              populate: { role: true },
            });
        }
      }
    } catch (_) {}

    // Fallback: Check Strapi Admin token
    if (!user) {
      try {
        const adminTokenService = (strapi as any).service("admin::token");
        if (adminTokenService?.decode) {
          const decoded = adminTokenService.decode(token);
          if (decoded?.payload?.id) {
            const adminUser = await strapi.db.query("admin::user").findOne({
              where: { id: decoded.payload.id },
              populate: { roles: true },
            });
            if (adminUser) {
              user = {
                ...adminUser,
                _cachedRole: "admin",
              };
            }
          }
        }
      } catch (_) {}
    }
  }

  if (!user) {
    ctx.unauthorized("Authentication required. Please log in.");
    return false;
  }

  const roleName = await getUserRole(user);
  const isAllowed =
    roleName === "admin" ||
    roleName === "superadmin" ||
    roleName.includes("admin");

  if (!isAllowed) {
    ctx.forbidden(
      "Access denied. Only users with Admin or Super Admin role can perform this action."
    );
    return false;
  }

  ctx.state.user = user;
  return true;
}

export default factories.createCoreController(
  "api::gemini-api-key.gemini-api-key",
  ({ strapi }) => ({
    
    async update(ctx) {
      if (!(await ensureAdmin(ctx))) return;

      const body = ctx.request.body || {};
      const rawKey = body?.data?.key ?? body?.key;
      const rawIsActive = body?.data?.isActive ?? body?.isActive;

      // Ensure at least one field to update is provided
      if (rawKey === undefined && rawIsActive === undefined) {
        return ctx.badRequest(
          'At least one field ("key" or "isActive") must be provided in the request body.'
        );
      }

      let encryptedKey: string | undefined;
      if (rawKey !== undefined) {
        if (typeof rawKey !== "string" || !rawKey.trim()) {
          return ctx.badRequest(
            'Invalid "key" provided. Please provide a valid non-empty string for the API key.'
          );
        }
        encryptedKey = encrypt(rawKey.trim());
      }

      let parsedIsActive: boolean | undefined;
      if (rawIsActive !== undefined) {
        if (typeof rawIsActive === "boolean") {
          parsedIsActive = rawIsActive;
        } else if (typeof rawIsActive === "string") {
          const lower = rawIsActive.trim().toLowerCase();
          if (lower === "true" || lower === "1") {
            parsedIsActive = true;
          } else if (lower === "false" || lower === "0") {
            parsedIsActive = false;
          } else {
            return ctx.badRequest(
              'Invalid value for "isActive". It must be a boolean (true or false).'
            );
          }
        } else if (typeof rawIsActive === "number") {
          if (rawIsActive === 1) parsedIsActive = true;
          else if (rawIsActive === 0) parsedIsActive = false;
          else {
            return ctx.badRequest(
              'Invalid value for "isActive". It must be a boolean (true or false).'
            );
          }
        } else {
          return ctx.badRequest(
            'Invalid value for "isActive". It must be a boolean (true or false).'
          );
        }
      }

      // Update ctx.request.body so Strapi core controller persists the changes
      const existingData =
        typeof body?.data === "object" && body.data !== null ? body.data : {};

      const updateData: Record<string, any> = {
        ...existingData,
      };

      if (encryptedKey !== undefined) {
        updateData.key = encryptedKey;
      }

      if (parsedIsActive !== undefined) {
        updateData.isActive = parsedIsActive;
      }

      ctx.request.body = {
        ...(typeof body === "object" && body !== null ? body : {}),
        data: updateData,
      };

      return await super.update(ctx);
    },

    async delete(ctx) {
      if (!(await ensureAdmin(ctx))) return;
      return await super.delete(ctx);
    },
    
  })
);
