/**
 * client-detail controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

/* ---------- POPULATE CONFIGURATION ---------- */
const POPULATE: any = {
  user: {
    populate: ["role", "approved_by", "rejected_by"],
  },
  selfieUpload: true,
  governmentId: true,
  local_subscriptions: {
    populate: ["local_membership_plan", "club_owner"],
  },
  outdoor_subscriptions: {
    populate: ["outdoor_membership_plan"],
  },
  client_checkins: {
    populate: ["club_owner"],
  },
};

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
  "api::client-detail.client-detail",
  ({ strapi }) => ({
    /* =======================================================
       1. FIND CLIENT DETAILS (ADMIN & FILTER SUPPORT)
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        const roleName = user ? await getUserRole(user) : "";
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          !user ||
          Boolean((ctx.state as any)?.auth?.credentials);

        const {
          search,
          status,
          verification_status,
          gender,
          isRead,
        } = ctx.query as any;

        let entries: any[] = [];

        if ((strapi as any).documents) {
          try {
            entries = await (strapi as any)
              .documents("api::client-detail.client-detail")
              .findMany({
                populate: {
                  selfieUpload:{
                  fields:[
                    "url"
                  ]
                },
                },
                filters: {
                  user: {
                    verification_status: "approved",
                  },
                },
                sort: { createdAt: "desc" },
                fields: [
                  "name",
                  "email",
                  "phoneNumber",
                  "gender",
                  "clientId",
                  "read_by_admins",
                  "createdAt",
                ],
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.findMany error in client-detail find:",
              docErr,
            );
          }
        }

        if (!entries || entries.length === 0) {
          entries = await strapi.entityService.findMany(
            "api::client-detail.client-detail",
            {
              populate: {
                selfieUpload:{
                  fields:[
                    "url"
                  ]
                },
              },
              filters: {
                user: {
                  verification_status: "approved",
                },
              },
              fields: [
                "name",
                "email",
                "phoneNumber",
                "gender",
                "clientId",
                "createdAt",
              ],
              sort: { createdAt: "desc" },
            },
          );
        }

        let finalData: any[] = Array.isArray(entries) ? [...entries] : [];

        // If authenticated non-admin client, only allow viewing own client-detail
        if (!isAdmin && roleName === "client") {
          finalData = finalData.filter(
            (item: any) =>
              item.user?.id === user.id || item.user === user.id,
          );
        } else if (!isAdmin) {
          return ctx.forbidden("Access denied. Admin role required.");
        }

        // Filter by user verification status (e.g. approved, pending, rejected, in-review)
        const statusFilter = verification_status || status;
        if (statusFilter?.trim()) {
          const targetStatus = statusFilter.trim().toLowerCase();
          finalData = finalData.filter(
            (item: any) =>
              item.user?.verification_status?.toLowerCase() === targetStatus,
          );
        }

        // Filter by gender
        if (gender?.trim()) {
          const targetGender = gender.trim().toLowerCase();
          finalData = finalData.filter(
            (item: any) => item.gender?.toLowerCase() === targetGender,
          );
        }

        // Global search (name, email, phone, clientId)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = finalData.filter((item: any) => {
            const name = item.name?.replace(/\s+/g, "").toLowerCase() || "";
            const email = (item.email || item.user?.email || "")
              .replace(/\s+/g, "")
              .toLowerCase();
            const phone = (item.phoneNumber || item.user?.phoneNumber || "")
              .replace(/\s+/g, "")
              .toLowerCase();
            const clientId = (item.clientId || "")
              .replace(/\s+/g, "")
              .toLowerCase();

            return (
              name.includes(searchValue) ||
              email.includes(searchValue) ||
              phone.includes(searchValue) ||
              clientId.includes(searchValue)
            );
          });
        }

        // Compute read status
        finalData = finalData.map((item: any) => {
          const itemIsRead = Array.isArray(item.read_by_admins)
            ? user?.id
              ? item.read_by_admins.includes(user.id)
              : item.read_by_admins.length > 0
            : Boolean(item.read_by_admins?.length > 0);

          return {
            ...item,
            isRead: itemIsRead,
          };
        });

        // Filter by isRead query param if provided
        if (isRead !== undefined) {
          const shouldBeRead = isRead === "true" || isRead === true;
          finalData = finalData.filter(
            (item: any) => item.isRead === shouldBeRead,
          );
        }

        ctx.body = finalData;
      } catch (err) {
        strapi.log.error("FETCH CLIENT DETAILS ERROR:", err);
        return ctx.internalServerError("Failed to fetch client details");
      }
    },

    /* =======================================================
       2. FIND ONE CLIENT DETAIL BY DOCUMENT ID
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Document ID is required");
        }

        const user = ctx.state.user;
        const roleName = user ? await getUserRole(user) : "";
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          !user ||
          Boolean((ctx.state as any)?.auth?.credentials);

        const documentId = String(id).trim();
        const isNumeric =
          !isNaN(Number(documentId)) && /^\d+$/.test(documentId);

        let item: any = null;

        // 1. Try finding by documentId via Strapi 5 documents service
        if ((strapi as any).documents && !isNumeric) {
          try {
            item = await (strapi as any)
              .documents("api::client-detail.client-detail")
              .findOne({
                documentId,
                populate: POPULATE,
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.findOne error in client-detail:",
              docErr,
            );
          }
        }

        // 2. Fallback to db query
        if (!item) {
          item = await strapi.db
            .query("api::client-detail.client-detail")
            .findOne({
              where: isNumeric
                ? { $or: [{ documentId }, { id: Number(documentId) }] }
                : { documentId },
              populate: POPULATE,
            });
        }

        if (!item) {
          return ctx.notFound("Client detail not found");
        }

        // Access check for non-admin
        if (!isAdmin && roleName === "client") {
          const linkedUserId =
            item.user?.id ||
            (typeof item.user === "number" ? item.user : null);
          if (linkedUserId !== user.id) {
            return ctx.forbidden(
              "Access denied. You can only view your own client detail.",
            );
          }
        } else if (!isAdmin) {
          return ctx.forbidden("Access denied. Admin role required.");
        }

        // Auto-mark as read if viewed by admin
        if (isAdmin && user?.id) {
          const readers: number[] = Array.isArray(item.read_by_admins)
            ? [...item.read_by_admins]
            : [];

          if (!readers.includes(user.id)) {
            readers.push(user.id);
            item.read_by_admins = readers;

            try {
              await strapi.db
                .query("api::client-detail.client-detail")
                .update({
                  where: { id: item.id },
                  data: { read_by_admins: readers },
                });
            } catch (readErr) {
              strapi.log.warn(
                "Failed to mark client-detail as read:",
                readErr,
              );
            }
          }
        }

        const isRead = Array.isArray(item.read_by_admins)
          ? user?.id
            ? item.read_by_admins.includes(user.id)
            : item.read_by_admins.length > 0
          : Boolean(item.read_by_admins?.length > 0);

        ctx.body = {
          ...item,
          isRead,
        };
      } catch (err) {
        strapi.log.error("GET CLIENT DETAIL ERROR:", err);
        return ctx.internalServerError("Failed to fetch client detail");
      }
    },

    /* =======================================================
       3. UPDATE CLIENT DETAIL (ADMIN ROLE)
    ======================================================= */
    async update(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Document ID is required");
        }

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can update client details.",
          );
        }

        const body = (ctx.request.body as any) ?? {};
        const payload = body.data !== undefined ? body.data : body;

        if (!payload || Object.keys(payload).length === 0) {
          return ctx.badRequest("Update payload is required");
        }

        const targetId = String(id).trim();
        const isNumeric = !isNaN(Number(targetId)) && /^\d+$/.test(targetId);

        // Find existing record
        let existing: any = null;
        if ((strapi as any).documents && !isNumeric) {
          try {
            existing = await (strapi as any)
              .documents("api::client-detail.client-detail")
              .findOne({
                documentId: targetId,
                populate: { user: true },
              });
          } catch (e) { }
        }

        if (!existing) {
          existing = await strapi.db
            .query("api::client-detail.client-detail")
            .findOne({
              where: isNumeric
                ? { $or: [{ documentId: targetId }, { id: Number(targetId) }] }
                : { documentId: targetId },
              populate: { user: true },
            });
        }

        if (!existing) {
          return ctx.notFound("Client detail not found");
        }

        // 1. Handle user-level status & credentials updates
        const status =
          payload.verification_status ||
          payload.status ||
          payload.user?.verification_status;

        const rejectionReason =
          payload.rejection_reason !== undefined
            ? payload.rejection_reason
            : payload.user?.rejection_reason;

        const linkedUserId =
          existing.user?.id ||
          (typeof existing.user === "number" ? existing.user : null);

        if (linkedUserId) {
          const userUpdates: any = {};

          if (status) {
            userUpdates.verification_status = status;
            if (status === "approved") {
              userUpdates.approved_by = user.id;
              userUpdates.rejected_by = null;
              userUpdates.rejection_reason = null;
            } else if (status === "rejected") {
              userUpdates.rejected_by = user.id;
              if (rejectionReason) {
                userUpdates.rejection_reason = rejectionReason;
              }
            }
          }

          if (rejectionReason && status !== "approved") {
            userUpdates.rejection_reason = rejectionReason;
          }

          if (payload.blocked !== undefined) {
            userUpdates.blocked = Boolean(payload.blocked);
          } else if (payload.user?.blocked !== undefined) {
            userUpdates.blocked = Boolean(payload.user.blocked);
          }

          if (payload.confirmed !== undefined) {
            userUpdates.confirmed = Boolean(payload.confirmed);
          } else if (payload.user?.confirmed !== undefined) {
            userUpdates.confirmed = Boolean(payload.user.confirmed);
          }

          if (payload.email && payload.email !== existing.user?.email) {
            userUpdates.email = payload.email;
          }

          if (
            payload.phoneNumber &&
            payload.phoneNumber !== existing.user?.phoneNumber
          ) {
            userUpdates.phoneNumber = payload.phoneNumber;
          }

          if (Object.keys(userUpdates).length > 0) {
            await strapi.db.query("plugin::users-permissions.user").update({
              where: { id: linkedUserId },
              data: userUpdates,
            });
          }
        }

        // 2. Handle client-detail entity updates
        const clientData: any = {};
        const allowedClientFields = [
          "name",
          "gender",
          "email",
          "phoneNumber",
          "weight",
          "height",
          "longitude",
          "latitude",
          "selfieUpload",
          "governmentId",
          "date_of_birth",
          "clientId",
          "faceSimilarity",
          "read_by_admins",
        ];

        for (const key of allowedClientFields) {
          if (payload[key] !== undefined) {
            if (
              (key === "selfieUpload" || key === "governmentId") &&
              typeof payload[key] === "object" &&
              payload[key]?.id
            ) {
              clientData[key] = payload[key].id;
            } else {
              clientData[key] = payload[key];
            }
          }
        }

        let updatedItem: any = null;

        if (Object.keys(clientData).length > 0) {
          if ((strapi as any).documents && existing.documentId) {
            try {
              updatedItem = await (strapi as any)
                .documents("api::client-detail.client-detail")
                .update({
                  documentId: existing.documentId,
                  data: clientData,
                  populate: POPULATE,
                });
            } catch (docErr) {
              strapi.log.warn(
                "documents.update error in client-detail update:",
                docErr,
              );
            }
          }

          if (!updatedItem) {
            await strapi.db
              .query("api::client-detail.client-detail")
              .update({
                where: { id: existing.id },
                data: clientData,
              });
          }
        }

        // 3. Fetch fresh populated entity
        if (!updatedItem) {
          if ((strapi as any).documents && existing.documentId) {
            try {
              updatedItem = await (strapi as any)
                .documents("api::client-detail.client-detail")
                .findOne({
                  documentId: existing.documentId,
                  populate: POPULATE,
                });
            } catch (e) { }
          }

          if (!updatedItem) {
            updatedItem = await strapi.db
              .query("api::client-detail.client-detail")
              .findOne({
                where: { id: existing.id },
                populate: POPULATE,
              });
          }
        }

        const isRead = Array.isArray(updatedItem?.read_by_admins)
          ? updatedItem.read_by_admins.includes(user.id)
          : Boolean(updatedItem?.read_by_admins?.length > 0);

        ctx.body = {
          ...updatedItem,
          isRead,
        };
      } catch (err) {
        strapi.log.error("UPDATE CLIENT DETAIL ERROR:", err);
        return ctx.internalServerError("Failed to update client detail");
      }
    },
  }),
);
