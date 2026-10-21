/**
 * gemini-api-key controller
 */

import { factories } from "@strapi/strapi";
import { encrypt } from "../../../utils/encryption";

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

export default factories.createCoreController(
  "api::gemini-api-key.gemini-api-key",
  ({ strapi }) => ({
    /**
     * PUT /api/gemini-api-key
     * Overwrites update to encrypt the Gemini API key before storing in the database
     */
    async update(ctx) {
      // 1. Role verification: If an authenticated user is making the request, ensure admin access
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
      }

      if (user) {
        const roleName = await getUserRole(user);
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          roleName.includes("admin");

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only users with Admin role can configure the Gemini API key."
          );
        }
      }

      // 2. Validate request body
      // Supports both { data: { key: "..." } } and direct { key: "..." }
      const body = ctx.request.body || {};
      const rawKey = body?.data?.key ?? body?.key;

      if (!rawKey || typeof rawKey !== "string" || !rawKey.trim()) {
        return ctx.badRequest(
          'API key is required. Please provide a valid non-empty "key" string in the request body.'
        );
      }

      const trimmedKey = rawKey.trim();

      // 3. Encrypt the key with AES-256-GCM
      const encryptedKey = encrypt(trimmedKey);

      // 4. Update ctx.request.body so Strapi core controller persists the encrypted string
      ctx.request.body = {
        ...(typeof body === "object" && body !== null ? body : {}),
        data: {
          ...(body?.data || {}),
          key: encryptedKey,
        },
      };

      // 5. Delegate persistence to Strapi's core controller update handler
      const response = await super.update(ctx);

      // 6. Return response containing the saved record with the encrypted key
      return response;
    },

    /**
     * GET /api/gemini-api-key
     * Returns the single type record with the encrypted key exactly as stored in the database
     */
    async find(ctx) {
      return super.find(ctx);
    },
  })
);
