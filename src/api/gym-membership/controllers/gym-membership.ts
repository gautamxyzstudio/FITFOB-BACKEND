/**
 * gym-membership controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

const GYM_MEMBERSHIP_UID = "api::gym-membership.gym-membership" as any;
const CLIENT_DETAIL_UID = "api::client-detail.client-detail" as any;

/* ---------- AUTH USER HELPER ---------- */
async function getAuthUser(ctx: Context) {
  let user = ctx.state?.user;
  if (user?.id) return user;

  const authHeader = ctx.request?.header?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
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
          if (user) {
            ctx.state.user = user;
            return user;
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";
  if (user._cachedRole) return user._cachedRole;

  if (user.role && typeof user.role === "object") {
    const role =
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      "";
    if (role) {
      user._cachedRole = role;
      return role;
    }
  }

  const userId = typeof user === "object" ? user.id : user;
  if (!userId) return "";

  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: userId },
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

  if (user && typeof user === "object") {
    user._cachedRole = role;
  }
  return role;
}

/* ---------- MAIN HANDLER FOR CLIENT GYM MEMBERSHIPS ---------- */
async function handleGetClientGymMemberships(ctx: Context) {
  const user = await getAuthUser(ctx);
  if (!user) {
    return ctx.unauthorized("Authentication required");
  }

  // 1. Role verification: Only Admin and SuperAdmin can access
  const roleName = await getUserRole(user);
  const isAdmin =
    roleName === "admin" ||
    roleName === "superadmin" ||
    roleName.includes("admin");

  if (!isAdmin) {
    return ctx.forbidden(
      "Access denied. Only Admin and SuperAdmin can access this endpoint."
    );
  }

  // 2. Extract clientdocumentid from params or query
  const query = (ctx.query || {}) as any;
  const params = (ctx.params || {}) as any;

  const targetClientDocId =
    params.clientdocumentid ||
    params.clientDocumentId ||
    query.clientdocumentid ||
    query.clientDocumentId ||
    query.client_document_id ||
    query.clientId ||
    query.documentId ||
    params.documentId ||
    params.id;

  if (!targetClientDocId || !String(targetClientDocId).trim()) {
    return ctx.badRequest("Please provide clientdocumentid in params or query");
  }

  const cleanDocId = String(targetClientDocId).trim();
  const isNum = !isNaN(Number(cleanDocId)) && /^\d+$/.test(cleanDocId);

  // 3. Resolve client profile
  let clientDetail: any = null;

  if ((strapi as any).documents && !isNum) {
    try {
      clientDetail = await (strapi as any)
        .documents(CLIENT_DETAIL_UID)
        .findOne({
          documentId: cleanDocId,
          select: ["id", "documentId", "clientId", "name"],
        });
    } catch (_) {}
  }

  if (!clientDetail) {
    clientDetail = await strapi.db.query(CLIENT_DETAIL_UID).findOne({
      where: isNum
        ? { $or: [{ id: Number(cleanDocId) }, { documentId: cleanDocId }] }
        : { $or: [{ documentId: cleanDocId }, { clientId: cleanDocId }] },
      select: ["id", "documentId", "clientId", "name"],
    });
  }

  if (!clientDetail) {
    return ctx.notFound(`Client with documentId '${cleanDocId}' not found`);
  }

  // 4. Fetch all gym memberships for this client
  const memberships: any[] = await strapi.db
    .query(GYM_MEMBERSHIP_UID)
    .findMany({
      where: {
        client_detail: clientDetail.id,
      },
      populate: {
        gym_contract: {
          populate: {
            club_owner: {
              select: ["id", "clubName", "clubId", "ownerName"],
            },
          },
        },
        membership_plan_price: true,
      },
      orderBy: { createdAt: "desc", id: "desc" },
    });

  // 5. Format response with requested fields
  const responseData = memberships.map((m: any) => {
    const clubName =
      m.gym_contract?.club_owner?.clubName ||
      m.gym_contract?.club_owner?.ownerName ||
      null;

    const startDate =
      m.startDate ||
      (m.paidAt ? String(m.paidAt).slice(0, 10) : null) ||
      (m.createdAt ? String(m.createdAt).slice(0, 10) : null);

    const endDate = m.endDate || null;

    const amount =
      m.customerPriceSnapshot != null
        ? Number(m.customerPriceSnapshot)
        : m.membership_plan_price?.customerPrice != null
        ? Number(m.membership_plan_price.customerPrice)
        : 0;

    return {
      membershipId: m.membershipId || m.documentId || String(m.id),
      clubName,
      plan:
        m.duration ||
        (m.durationMonths ? `${m.durationMonths} months` : null),
      amount,
      membershipStatus: m.membershipStatus || null,
      startDate,
      endDate,
    };
  });

  return ctx.send(responseData);
}

export default factories.createCoreController(
  "api::gym-membership.gym-membership",
  ({ strapi }) => ({

    async findOne(ctx: Context) {
      try {
        return await handleGetClientGymMemberships(ctx);
      } catch (error) {
        strapi.log.error("FIND ONE GYM MEMBERSHIP ERROR:", error);
        return ctx.internalServerError("Failed to fetch gym membership");
      }
    },
    
  })
);
