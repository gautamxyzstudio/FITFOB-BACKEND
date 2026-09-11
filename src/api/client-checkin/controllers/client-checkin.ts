import { factories } from "@strapi/strapi";
import { Context } from "koa";

const CHECKIN_UID = "api::client-checkin.client-checkin" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;
const CLIENT_UID = "api::client-detail.client-detail" as any;

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

/* ---------- CLUB OWNER LOOKUP FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation
  let owner: any = null;
  if (userId) {
    owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { user: userId },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
      ],
    });
  }

  // 2. Fallback via user table populate
  if (!owner && userId) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id", "email", "phoneNumber"],
        populate: {
          club_owner: {
            select: [
              "id",
              "documentId",
              "clubId",
              "clubName",
              "ownerName",
              "phoneNumber",
              "email",
            ],
          },
        },
      });

    owner = userWithDetail?.club_owner || null;
  }

  // 3. Fallback by email
  const userEmail = userObj?.email;
  if (!owner && userEmail) {
    owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { email: userEmail },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
      ],
    });
  }

  // 4. Fallback by phoneNumber
  const userPhone = userObj?.phoneNumber;
  if (!owner && userPhone) {
    owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { phoneNumber: userPhone },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
      ],
    });
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- CLIENT DETAIL LOOKUP FOR AUTH USER ---------- */
async function getClientDetailForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClientDetail) {
    return userObj._cachedClientDetail;
  }

  // 1. Direct query to client-detail by user relation
  let client: any = null;
  if (userId) {
    client = await strapi.db.query(CLIENT_UID).findOne({
      where: { user: userId },
      select: ["id", "documentId", "clientId", "name", "phoneNumber", "email"],
    });
  }

  // 2. Fallback via user table populate
  if (!client && userId) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id", "email", "phoneNumber"],
        populate: {
          client_detail: {
            select: [
              "id",
              "documentId",
              "clientId",
              "name",
              "phoneNumber",
              "email",
            ],
          },
        },
      });

    client = userWithDetail?.client_detail || null;
  }

  // 3. Fallback by email
  const userEmail = userObj?.email;
  if (!client && userEmail) {
    client = await strapi.db.query(CLIENT_UID).findOne({
      where: { email: userEmail },
      select: ["id", "documentId", "clientId", "name", "phoneNumber", "email"],
    });
  }

  // 4. Fallback by phoneNumber
  const userPhone = userObj?.phoneNumber;
  if (!client && userPhone) {
    client = await strapi.db.query(CLIENT_UID).findOne({
      where: { phoneNumber: userPhone },
      select: ["id", "documentId", "clientId", "name", "phoneNumber", "email"],
    });
  }

  if (userObj && client) {
    userObj._cachedClientDetail = client;
  }

  return client || null;
}

/* ---------- FIND TARGET CLUB OWNER BY IDENTIFIER ---------- */
async function findClubOwnerByIdentifier(identifier: string | number) {
  if (!identifier || !String(identifier).trim()) return null;
  const val = String(identifier).trim();
  const isNumeric = !isNaN(Number(val)) && /^\d+$/.test(val);

  // 1. Check numeric ID
  if (isNumeric) {
    const byId = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { id: Number(val) },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
        "city",
        "state",
        "clubAddress",
      ],
    });
    if (byId) return byId;
  }

  // 2. Check documentId (Strapi 5 alphanumeric)
  const byDocId = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { documentId: val },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
      "city",
      "state",
      "clubAddress",
    ],
  });
  if (byDocId) return byDocId;

  // 3. Check custom clubId (e.g. CLUB-101)
  const byClubId = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { clubId: val },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
      "city",
      "state",
      "clubAddress",
    ],
  });
  if (byClubId) return byClubId;

  // 4. Check user ID if numeric
  if (isNumeric) {
    const byUserId = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { user: Number(val) },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
        "city",
        "state",
        "clubAddress",
      ],
    });
    if (byUserId) return byUserId;
  }

  // 5. Check email or phoneNumber or clubName
  const byContact = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: {
      $or: [{ email: val }, { phoneNumber: val }, { clubName: val }],
    },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
      "city",
      "state",
      "clubAddress",
    ],
  });
  if (byContact) return byContact;

  return null;
}

/* ---------- FIND TARGET CLIENT BY IDENTIFIER ---------- */
async function findClientByIdentifier(identifier: string | number) {
  if (!identifier || !String(identifier).trim()) return null;
  const val = String(identifier).trim();
  const isNumeric = !isNaN(Number(val)) && /^\d+$/.test(val);

  // 1. Check numeric ID
  if (isNumeric) {
    const byId = await strapi.db.query(CLIENT_UID).findOne({
      where: { id: Number(val) },
      select: [
        "id",
        "documentId",
        "clientId",
        "name",
        "phoneNumber",
        "email",
        "gender",
      ],
    });
    if (byId) return byId;
  }

  // 2. Check documentId (Strapi 5 alphanumeric)
  const byDocId = await strapi.db.query(CLIENT_UID).findOne({
    where: { documentId: val },
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
      "gender",
    ],
  });
  if (byDocId) return byDocId;

  // 3. Check custom clientId (e.g. CL-101)
  const byClientId = await strapi.db.query(CLIENT_UID).findOne({
    where: { clientId: val },
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
      "gender",
    ],
  });
  if (byClientId) return byClientId;

  // 4. Check user ID if numeric
  if (isNumeric) {
    const byUserId = await strapi.db.query(CLIENT_UID).findOne({
      where: { user: Number(val) },
      select: [
        "id",
        "documentId",
        "clientId",
        "name",
        "phoneNumber",
        "email",
        "gender",
      ],
    });
    if (byUserId) return byUserId;
  }

  // 5. Check email or phoneNumber or name (supports partial name)
  const byContact = await strapi.db.query(CLIENT_UID).findOne({
    where: {
      $or: [
        { email: val },
        { phoneNumber: val },
        { name: { $containsi: val } },
      ],
    },
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
      "gender",
    ],
  });
  if (byContact) return byContact;

  return null;
}

/* ---------- POPULATE CONFIGURATION ---------- */
const POPULATE_CONFIG = {
  client_detail: {
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
      "gender",
      "date_of_birth",
    ],
    populate: {
      selfieUpload: {
        select: ["id", "url", "name", "formats"],
      },
    },
  },
  club_owner: {
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
      "clubAddress",
      "city",
      "state",
      "pincode",
      "clubCategory",
    ],
    populate: {
      logo: {
        select: ["id", "url", "name", "formats"],
      },
    },
  },
  local_subscription: {
    select: [
      "id",
      "documentId",
      "membershipType",
      "startDate",
      "endDate",
      "subscriptionStatus",
    ],
    populate: {
      local_membership_plan: {
        select: ["id", "documentId", "planName", "price", "monthDuration"],
      },
    },
  },
  outdoor_subscription: {
    select: [
      "id",
      "documentId",
      "membershipType",
      "totalVisitsAllowed",
      "usedVisits",
      "remainingVisits",
      "subscriptionStatus",
    ],
    populate: {
      outdoor_membership_plan: {
        select: ["id", "documentId", "planName", "price", "visitAllowed"],
      },
    },
  },
};

/* ---------- FORMAT CHECKIN ITEM ---------- */
function formatCheckin(item: any) {
  if (!item) return null;

  let durationMinutes: number | null = null;
  if (item.checkinTime && item.checkoutTime) {
    const start = new Date(item.checkinTime).getTime();
    const end = new Date(item.checkoutTime).getTime();
    durationMinutes = Math.max(0, Math.round((end - start) / (1000 * 60)));
  } else if (item.checkinTime && !item.checkoutTime) {
    const start = new Date(item.checkinTime).getTime();
    const now = Date.now();
    durationMinutes = Math.max(0, Math.round((now - start) / (1000 * 60)));
  }

  const isCheckedOut = Boolean(item.checkoutTime);

  return {
    id: item.id,
    documentId: item.documentId,
    subscriptionType: item.subscriptionType,
    checkinTime: item.checkinTime,
    checkoutTime: item.checkoutTime,
    status: isCheckedOut ? "checked-out" : "checked-in",
    client: item.client_detail
      ? {
          id: item.client_detail.id,
          documentId: item.client_detail.documentId,
          clientId: item.client_detail.clientId,
          name: item.client_detail.name,
          email: item.client_detail.email,
          gender: item.client_detail.gender,
          selfieUrl: item.client_detail.selfieUpload?.url || null,
        }
      : null,
    clubOwner: item.club_owner
      ? {
          id: item.club_owner.id,
          documentId: item.club_owner.documentId,
          clubId: item.club_owner.clubId,
          clubName: item.club_owner.clubName,
          email: item.club_owner.email,
          logoUrl: item.club_owner.logo?.url || null,
        }
      : null,
    localSubscription: item.local_subscription
      ? {
          id: item.local_subscription.id,
          documentId: item.local_subscription.documentId,
          membershipType: item.local_subscription.membershipType,
          startDate: item.local_subscription.startDate,
          endDate: item.local_subscription.endDate,
          subscriptionStatus: item.local_subscription.subscriptionStatus,
          plan: item.local_subscription.local_membership_plan
            ? {
                id: item.local_subscription.local_membership_plan.id,
                documentId:
                  item.local_subscription.local_membership_plan.documentId,
                planName:
                  item.local_subscription.local_membership_plan.planName,
                price: item.local_subscription.local_membership_plan.price,
                monthDuration:
                  item.local_subscription.local_membership_plan.monthDuration,
              }
            : null,
        }
      : null,
    outdoorSubscription: item.outdoor_subscription
      ? {
          id: item.outdoor_subscription.id,
          documentId: item.outdoor_subscription.documentId,
          membershipType: item.outdoor_subscription.membershipType,
          totalVisitsAllowed: item.outdoor_subscription.totalVisitsAllowed,
          usedVisits: item.outdoor_subscription.usedVisits,
          remainingVisits: item.outdoor_subscription.remainingVisits,
          subscriptionStatus: item.outdoor_subscription.subscriptionStatus,
          plan: item.outdoor_subscription.outdoor_membership_plan
            ? {
                id: item.outdoor_subscription.outdoor_membership_plan.id,
                documentId:
                  item.outdoor_subscription.outdoor_membership_plan.documentId,
                planName:
                  item.outdoor_subscription.outdoor_membership_plan.planName,
                price: item.outdoor_subscription.outdoor_membership_plan.price,
                visitAllowed:
                  item.outdoor_subscription.outdoor_membership_plan
                    .visitAllowed,
              }
            : null,
        }
      : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export default factories.createCoreController(
  "api::client-checkin.client-checkin",
  ({ strapi }) => ({
    /* =======================================================
       1. FIND ALL / FILTER CHECK-INS (ADMIN & SUPERADMIN ONLY)
       Route: GET /api/client-checkins
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const {
          startDate,
          endDate,
          from,
          to,
          start_date,
          end_date,
          date,
          clubOwnerId,
          club_owner,
          clubOwner,
          clubId,
          ownerDocumentId,
          ownerId,
          clientId,
          client_detail,
          clientDetail,
          client_id,
          clientDocumentId,
          clientName,
          name,
          subscriptionType,
          status,
          search,
          q,
          sort,
        } = ctx.query as any;

        const where: any = {};
        const appliedFilters: any = {};

        // 1. Target Club Owner Filter
        const targetOwnerIdentifier =
          clubOwnerId ||
          club_owner ||
          clubOwner ||
          clubId ||
          ownerDocumentId ||
          ownerId;

        if (targetOwnerIdentifier) {
          const owner = await findClubOwnerByIdentifier(targetOwnerIdentifier);
          if (!owner) {
            return ctx.notFound(
              `Club owner with identifier '${targetOwnerIdentifier}' not found`,
            );
          }
          where.club_owner = owner.id;
          appliedFilters.clubOwner = {
            id: owner.id,
            documentId: owner.documentId,
            clubId: owner.clubId,
            clubName: owner.clubName,
          };
        }

        // 2. Target Client Filter (supports ID, clientId, documentId, email, phone, or partial name)
        const targetClientIdentifier =
          clientId ||
          client_detail ||
          clientDetail ||
          client_id ||
          clientDocumentId ||
          clientName ||
          name;

        if (targetClientIdentifier) {
          const client = await findClientByIdentifier(targetClientIdentifier);
          if (!client) {
            return ctx.notFound(
              `Client with identifier '${targetClientIdentifier}' not found`,
            );
          }
          where.client_detail = client.id;
          appliedFilters.client = {
            id: client.id,
            documentId: client.documentId,
            clientId: client.clientId,
            name: client.name,
          };
        }

        // 2. Date Range Filter
        const rawStartDate = startDate || from || start_date;
        const rawEndDate = endDate || to || end_date;

        if (date) {
          const targetDate = new Date(date);
          if (!isNaN(targetDate.getTime())) {
            const dayStart = new Date(targetDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(targetDate);
            dayEnd.setHours(23, 59, 59, 999);
            where.checkinTime = {
              $gte: dayStart,
              $lte: dayEnd,
            };
            appliedFilters.date = date;
          }
        } else if (rawStartDate || rawEndDate) {
          where.checkinTime = {};
          if (rawStartDate) {
            const s = new Date(rawStartDate);
            if (!isNaN(s.getTime())) {
              if (
                typeof rawStartDate === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate.trim())
              ) {
                s.setHours(0, 0, 0, 0);
              }
              where.checkinTime.$gte = s;
              appliedFilters.startDate = s.toISOString();
            }
          }
          if (rawEndDate) {
            const e = new Date(rawEndDate);
            if (!isNaN(e.getTime())) {
              if (
                typeof rawEndDate === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate.trim())
              ) {
                e.setHours(23, 59, 59, 999);
              }
              where.checkinTime.$lte = e;
              appliedFilters.endDate = e.toISOString();
            }
          }
        }

        // 3. Subscription Type Filter
        if (
          subscriptionType &&
          ["local", "outdoor"].includes(
            String(subscriptionType).toLowerCase().trim(),
          )
        ) {
          const subType = String(subscriptionType).toLowerCase().trim();
          where.subscriptionType = subType;
          appliedFilters.subscriptionType = subType;
        }

        // 4. Status Filter
        if (status) {
          const s = String(status).toLowerCase().trim();
          if (s === "active" || s === "checked-in" || s === "checkedin") {
            where.checkoutTime = { $null: true };
            appliedFilters.status = "checked-in";
          } else if (
            s === "completed" ||
            s === "checked-out" ||
            s === "checkedout"
          ) {
            where.checkoutTime = { $notNull: true };
            appliedFilters.status = "checked-out";
          }
        }

        // 5. Keyword Search
        const searchTerm = search || q;
        if (searchTerm && String(searchTerm).trim()) {
          const s = String(searchTerm).trim();
          appliedFilters.search = s;

          const [matchingClients, matchingClubs] = await Promise.all([
            strapi.db.query(CLIENT_UID).findMany({
              where: {
                $or: [
                  { name: { $containsi: s } },
                  { clientId: { $containsi: s } },
                  { email: { $containsi: s } },
                  { phoneNumber: { $containsi: s } },
                ],
              },
              select: ["id"],
            }),
            strapi.db.query(CLUB_OWNER_UID).findMany({
              where: {
                $or: [
                  { clubName: { $containsi: s } },
                  { ownerName: { $containsi: s } },
                  { clubId: { $containsi: s } },
                  { email: { $containsi: s } },
                  { phoneNumber: { $containsi: s } },
                  { city: { $containsi: s } },
                ],
              },
              select: ["id"],
            }),
          ]);

          const clientIds = (matchingClients || []).map((c: any) => c.id);
          const clubIds = (matchingClubs || []).map((c: any) => c.id);

          if (clientIds.length > 0 || clubIds.length > 0) {
            const orConditions: any[] = [];
            if (clientIds.length > 0) {
              orConditions.push({ client_detail: { $in: clientIds } });
            }
            if (clubIds.length > 0) {
              orConditions.push({ club_owner: { $in: clubIds } });
            }
            where.$or = orConditions;
          } else {
            where.id = -1; // No matches found
          }
        }

        // 6. Ordering
        let orderBy: any = { checkinTime: "desc", id: "desc" };
        if (sort) {
          const parts = String(sort).split(":");
          if (parts.length === 2) {
            orderBy = { [parts[0]]: parts[1].toLowerCase() };
          } else if (parts.length === 1) {
            orderBy = { [parts[0]]: "desc" };
          }
        }

        // 7. Execute Queries (All Check-ins without pagination)
        const [rawCheckins, total, localCount, outdoorCount, activeCount] =
          await Promise.all([
            strapi.db.query(CHECKIN_UID).findMany({
              where,
              populate: POPULATE_CONFIG,
              orderBy,
            }),
            strapi.db.query(CHECKIN_UID).count({ where }),
            strapi.db.query(CHECKIN_UID).count({
              where: { ...where, subscriptionType: "local" },
            }),
            strapi.db.query(CHECKIN_UID).count({
              where: { ...where, subscriptionType: "outdoor" },
            }),
            strapi.db.query(CHECKIN_UID).count({
              where: { ...where, checkoutTime: { $null: true } },
            }),
          ]);

        const formattedList = (
          Array.isArray(rawCheckins) ? rawCheckins : []
        ).map(formatCheckin);

        return ctx.send({
          data: formattedList,
        });
      } catch (error) {
        strapi.log.error("FIND CLIENT CHECKINS ERROR:", error);
        return ctx.internalServerError("Failed to fetch check-ins");
      }
    },

    /* =======================================================
       2. GET CLIENT'S OWN CHECK-INS (CLIENT ONLY)
       Route: GET /api/client-checkins/my-checkins
              GET /api/client-checkin/my-checkins
              GET /api/client/my-checkins
    ======================================================= */
    async myCheckins(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const client = await getClientDetailForUser(user);
        if (!client) {
          return ctx.notFound("Client profile not found for this user");
        }

        const {
          startDate,
          endDate,
          from,
          to,
          start_date,
          end_date,
          date,
          clubOwnerId,
          club_owner,
          clubOwner,
          clubId,
          ownerDocumentId,
          ownerId,
          subscriptionType,
          status,
          search,
          q,
          sort,
        } = ctx.query as any;

        const where: any = {
          client_detail: client.id,
        };
        const appliedFilters: any = {
          client: {
            id: client.id,
            documentId: client.documentId,
            clientId: client.clientId,
            name: client.name,
          },
        };

        // 1. Target Gym / Club Owner Filter (if client visited specific club)
        const targetOwnerIdentifier =
          clubOwnerId ||
          club_owner ||
          clubOwner ||
          clubId ||
          ownerDocumentId ||
          ownerId;

        if (targetOwnerIdentifier) {
          const owner = await findClubOwnerByIdentifier(targetOwnerIdentifier);
          if (!owner) {
            return ctx.notFound(
              `Club owner with identifier '${targetOwnerIdentifier}' not found`,
            );
          }
          where.club_owner = owner.id;
          appliedFilters.clubOwner = {
            id: owner.id,
            documentId: owner.documentId,
            clubId: owner.clubId,
            clubName: owner.clubName,
          };
        }

        // 2. Date Range Filter
        const rawStartDate = startDate || from || start_date;
        const rawEndDate = endDate || to || end_date;

        if (date) {
          const targetDate = new Date(date);
          if (!isNaN(targetDate.getTime())) {
            const dayStart = new Date(targetDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(targetDate);
            dayEnd.setHours(23, 59, 59, 999);
            where.checkinTime = {
              $gte: dayStart,
              $lte: dayEnd,
            };
            appliedFilters.date = date;
          }
        } else if (rawStartDate || rawEndDate) {
          where.checkinTime = {};
          if (rawStartDate) {
            const s = new Date(rawStartDate);
            if (!isNaN(s.getTime())) {
              if (
                typeof rawStartDate === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate.trim())
              ) {
                s.setHours(0, 0, 0, 0);
              }
              where.checkinTime.$gte = s;
              appliedFilters.startDate = s.toISOString();
            }
          }
          if (rawEndDate) {
            const e = new Date(rawEndDate);
            if (!isNaN(e.getTime())) {
              if (
                typeof rawEndDate === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate.trim())
              ) {
                e.setHours(23, 59, 59, 999);
              }
              where.checkinTime.$lte = e;
              appliedFilters.endDate = e.toISOString();
            }
          }
        }

        // 3. Subscription Type Filter
        if (
          subscriptionType &&
          ["local", "outdoor"].includes(
            String(subscriptionType).toLowerCase().trim(),
          )
        ) {
          const subType = String(subscriptionType).toLowerCase().trim();
          where.subscriptionType = subType;
          appliedFilters.subscriptionType = subType;
        }

        // 4. Status Filter
        if (status) {
          const s = String(status).toLowerCase().trim();
          if (s === "active" || s === "checked-in" || s === "checkedin") {
            where.checkoutTime = { $null: true };
            appliedFilters.status = "checked-in";
          } else if (
            s === "completed" ||
            s === "checked-out" ||
            s === "checkedout"
          ) {
            where.checkoutTime = { $notNull: true };
            appliedFilters.status = "checked-out";
          }
        }

        // 5. Keyword Search (Club name, city, owner name, clubId)
        const searchTerm = search || q;
        if (searchTerm && String(searchTerm).trim()) {
          const s = String(searchTerm).trim();
          appliedFilters.search = s;

          const matchingClubs = await strapi.db.query(CLUB_OWNER_UID).findMany({
            where: {
              $or: [
                { clubName: { $containsi: s } },
                { ownerName: { $containsi: s } },
                { clubId: { $containsi: s } },
                { city: { $containsi: s } },
              ],
            },
            select: ["id"],
          });

          const clubIds = (matchingClubs || []).map((c: any) => c.id);
          if (clubIds.length > 0) {
            where.club_owner = { $in: clubIds };
          } else {
            where.id = -1; // No matches found
          }
        }

        // 6. Ordering
        let orderBy: any = { checkinTime: "desc", id: "desc" };
        if (sort) {
          const parts = String(sort).split(":");
          if (parts.length === 2) {
            orderBy = { [parts[0]]: parts[1].toLowerCase() };
          } else if (parts.length === 1) {
            orderBy = { [parts[0]]: "desc" };
          }
        }

        // 7. Execute Query (All Check-ins without pagination)
        const rawCheckins = await strapi.db.query(CHECKIN_UID).findMany({
          where,
          populate: POPULATE_CONFIG,
          orderBy,
        });

        const formattedList = (
          Array.isArray(rawCheckins) ? rawCheckins : []
        ).map(formatCheckin);

        return ctx.send({
          data: formattedList,
        });
      } catch (error) {
        strapi.log.error("GET MY CHECKINS ERROR:", error);
        return ctx.internalServerError("Failed to fetch client check-ins");
      }
    },

    /* =======================================================
       3. FIND ONE CHECK-IN BY ID OR DOCUMENTID
       Route: GET /api/client-checkins/:id
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id).trim();

        // Delegate to myCheckins if requested via ID parameter
        if (identifier === "my-checkins" || identifier === "me") {
          return (this as any).myCheckins(ctx);
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);

        const checkin = await strapi.db.query(CHECKIN_UID).findOne({
          where: isNumeric
            ? { $or: [{ id: Number(identifier) }, { documentId: identifier }] }
            : { documentId: identifier },
          populate: POPULATE_CONFIG,
        });

        if (!checkin) {
          return ctx.notFound(`Check-in record '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        // If not Admin/SuperAdmin, enforce strict ownership scoping
        if (!isAdmin) {
          if (roleName === "clubowner" || roleName === "club_owner") {
            const owner = await getClubOwnerForUser(user);
            if (!owner) {
              return ctx.notFound("Club owner profile not found for this user");
            }
            const checkinClubOwnerId =
              checkin.club_owner?.id || checkin.club_owner;
            if (
              !checkinClubOwnerId ||
              Number(checkinClubOwnerId) !== Number(owner.id)
            ) {
              return ctx.forbidden(
                "Access denied. You can only view check-ins for your own club.",
              );
            }
          } else if (roleName === "client") {
            const client = await getClientDetailForUser(user);
            if (!client) {
              return ctx.notFound("Client profile not found for this user");
            }
            const checkinClientId =
              checkin.client_detail?.id || checkin.client_detail;
            if (
              !checkinClientId ||
              Number(checkinClientId) !== Number(client.id)
            ) {
              return ctx.forbidden(
                "Access denied. You can only view your own check-ins.",
              );
            }
          } else {
            // Check if user has club owner or client profile as fallback
            const owner = await getClubOwnerForUser(user);
            if (owner) {
              const checkinClubOwnerId =
                checkin.club_owner?.id || checkin.club_owner;
              if (
                !checkinClubOwnerId ||
                Number(checkinClubOwnerId) !== Number(owner.id)
              ) {
                return ctx.forbidden(
                  "Access denied. You can only view check-ins for your own club.",
                );
              }
            } else {
              const client = await getClientDetailForUser(user);
              if (client) {
                const checkinClientId =
                  checkin.client_detail?.id || checkin.client_detail;
                if (
                  !checkinClientId ||
                  Number(checkinClientId) !== Number(client.id)
                ) {
                  return ctx.forbidden(
                    "Access denied. You can only view your own check-ins.",
                  );
                }
              } else {
                return ctx.forbidden(
                  "Access denied. Only Admin, SuperAdmin, Club Owners, and Clients can view check-ins.",
                );
              }
            }
          }
        }

        return ctx.send({
          success: true,
          data: formatCheckin(checkin),
        });
      } catch (error) {
        strapi.log.error("FIND ONE CHECKIN ERROR:", error);
        return ctx.internalServerError("Failed to fetch check-in");
      }
    },
  }),
);
