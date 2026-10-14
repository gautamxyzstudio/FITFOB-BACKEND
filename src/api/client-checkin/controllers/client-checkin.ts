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
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        // Only Admin and SuperAdmin can access this endpoint
        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const {
          startDate,
          endDate,

          clubId,
          clubDocumentId,
          clubName,

          clientId,
          clientDocumentId,
          clientName,

          subscriptionType,
          status,

          sort,
        } = ctx.query as any;

        const where: any = {};

        // ============================================================
        // DATE FILTER
        // Default = TODAY
        // ============================================================

        if (startDate || endDate) {
          where.checkinTime = {};

          if (startDate) {
            const start = new Date(String(startDate));

            if (isNaN(start.getTime())) {
              return ctx.badRequest("Invalid startDate");
            }

            // YYYY-MM-DD => beginning of day
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
              start.setHours(0, 0, 0, 0);
            }

            where.checkinTime.$gte = start;
          }

          if (endDate) {
            const end = new Date(String(endDate));

            if (isNaN(end.getTime())) {
              return ctx.badRequest("Invalid endDate");
            }

            // YYYY-MM-DD => end of day
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) {
              end.setHours(23, 59, 59, 999);
            }

            where.checkinTime.$lte = end;
          }
        } else {
          // No date filters => TODAY

          const today = new Date();

          const dayStart = new Date(today);
          dayStart.setHours(0, 0, 0, 0);

          const dayEnd = new Date(today);
          dayEnd.setHours(23, 59, 59, 999);

          where.checkinTime = {
            $gte: dayStart,
            $lte: dayEnd,
          };
        }

        // ============================================================
        // CLUB FILTERS
        // ============================================================

        const clubFilters: any[] = [];

        if (clubId && String(clubId).trim()) {
          clubFilters.push({
            clubId: String(clubId).trim(),
          });
        }

        if (clubDocumentId && String(clubDocumentId).trim()) {
          clubFilters.push({
            documentId: String(clubDocumentId).trim(),
          });
        }

        // Partial + case-insensitive club name search
        if (clubName && String(clubName).trim()) {
          clubFilters.push({
            clubName: {
              $containsi: String(clubName).trim(),
            },
          });
        }

        if (clubFilters.length > 0) {
          const matchingClubs = await strapi.db.query(CLUB_OWNER_UID).findMany({
            where: {
              $and: clubFilters,
            },
            select: ["id"],
          });

          const clubOwnerIds = matchingClubs.map((club: any) => club.id);

          if (clubOwnerIds.length === 0) {
            return ctx.send({
              data: [],
              meta: {
                total: 0,
                localCount: 0,
                outdoorCount: 0,
                activeCount: 0,
              },
            });
          }

          where.club_owner = {
            $in: clubOwnerIds,
          };
        }

        // ============================================================
        // CLIENT FILTERS
        // ============================================================

        const clientFilters: any[] = [];

        if (clientId && String(clientId).trim()) {
          clientFilters.push({
            clientId: String(clientId).trim(),
          });
        }

        if (clientDocumentId && String(clientDocumentId).trim()) {
          clientFilters.push({
            documentId: String(clientDocumentId).trim(),
          });
        }

        // Partial + case-insensitive client name search
        if (clientName && String(clientName).trim()) {
          clientFilters.push({
            name: {
              $containsi: String(clientName).trim(),
            },
          });
        }

        if (clientFilters.length > 0) {
          const matchingClients = await strapi.db.query(CLIENT_UID).findMany({
            where: {
              $and: clientFilters,
            },
            select: ["id"],
          });

          const clientDetailIds = matchingClients.map(
            (client: any) => client.id,
          );

          if (clientDetailIds.length === 0) {
            return ctx.send({
              data: [],
              meta: {
                total: 0,
                localCount: 0,
                outdoorCount: 0,
                activeCount: 0,
              },
            });
          }

          where.client_detail = {
            $in: clientDetailIds,
          };
        }
        // ============================================================
        // SUBSCRIPTION TYPE
        // ============================================================

        if (
          subscriptionType &&
          ["local", "outdoor"].includes(
            String(subscriptionType).toLowerCase().trim(),
          )
        ) {
          where.subscriptionType = String(subscriptionType)
            .toLowerCase()
            .trim();
        }

        // ============================================================
        // STATUS
        // ============================================================

        if (status) {
          const normalizedStatus = String(status).toLowerCase().trim();

          if (
            normalizedStatus === "active" ||
            normalizedStatus === "checked-in" ||
            normalizedStatus === "checkedin"
          ) {
            where.checkoutTime = {
              $null: true,
            };
          }

          if (
            normalizedStatus === "completed" ||
            normalizedStatus === "checked-out" ||
            normalizedStatus === "checkedout"
          ) {
            where.checkoutTime = {
              $notNull: true,
            };
          }
        }

        // ============================================================
        // SORT
        // ============================================================

        let orderBy: any = {
          checkinTime: "desc",
          id: "desc",
        };

        if (sort) {
          const parts = String(sort).split(":");

          if (parts.length === 2) {
            orderBy = {
              [parts[0]]: parts[1].toLowerCase(),
            };
          } else {
            orderBy = {
              [parts[0]]: "desc",
            };
          }
        }

        // ============================================================
        // FETCH CHECK-INS
        // ============================================================

        const [rawCheckins, total, localCount, outdoorCount, activeCount] =
          await Promise.all([
            strapi.db.query(CHECKIN_UID).findMany({
              where,
              populate: POPULATE_CONFIG,
              orderBy,
            }),

            strapi.db.query(CHECKIN_UID).count({
              where,
            }),

            strapi.db.query(CHECKIN_UID).count({
              where: {
                ...where,
                subscriptionType: "local",
              },
            }),

            strapi.db.query(CHECKIN_UID).count({
              where: {
                ...where,
                subscriptionType: "outdoor",
              },
            }),

            strapi.db.query(CHECKIN_UID).count({
              where: {
                ...where,
                checkoutTime: {
                  $null: true,
                },
              },
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
          subscriptionType,
        } = ctx.query as any;

        let query = `
          SELECT 
            cc.id,
            cc.document_id,
            cc.subscription_type,
            cc.checkin_time,
            cc.checkout_time,
            co.club_name,
            logo.url AS club_logo
          FROM client_checkins cc
          JOIN client_checkins_client_detail_lnk ccdl ON ccdl.client_checkin_id = cc.id
          LEFT JOIN client_checkins_club_owner_lnk ccol ON ccol.client_checkin_id = cc.id
          LEFT JOIN club_owners co ON co.id = ccol.club_owner_id
          LEFT JOIN LATERAL (
            SELECT f.url
            FROM files_related_mph frm
            JOIN files f ON f.id = frm.file_id
            WHERE frm.related_id = co.id 
              AND frm.related_type = 'api::club-owner.club-owner' 
              AND frm.field = 'logo'
            ORDER BY frm.id ASC
            LIMIT 1
          ) logo ON true
          WHERE ccdl.client_detail_id = ?
        `;
        const params: any[] = [client.id];

        // Date Range Filter
        if (startDate) {
          const s = new Date(startDate);
          if (!isNaN(s.getTime())) {
            if (
              typeof startDate === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())
            ) {
              s.setHours(0, 0, 0, 0);
            }
            query += ` AND cc.checkin_time >= ?`;
            params.push(s.toISOString());
          }
        }

        if (endDate) {
          const e = new Date(endDate);
          if (!isNaN(e.getTime())) {
            if (
              typeof endDate === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())
            ) {
              e.setHours(23, 59, 59, 999);
            }
            query += ` AND cc.checkin_time <= ?`;
            params.push(e.toISOString());
          }
        }

        // Subscription Type Filter (local, outdoor, etc.)
        if (subscriptionType) {
          const types = (
            Array.isArray(subscriptionType)
              ? subscriptionType
              : String(subscriptionType).split(",")
          )
            .map((t: any) => String(t).toLowerCase().trim())
            .filter((t: string) => Boolean(t) && t !== "all");

          if (types.length === 1) {
            query += ` AND LOWER(cc.subscription_type) = ?`;
            params.push(types[0]);
          } else if (types.length > 1) {
            const placeholders = types.map(() => "?").join(", ");
            query += ` AND LOWER(cc.subscription_type) IN (${placeholders})`;
            params.push(...types);
          }
        }

        query += ` ORDER BY cc.checkin_time DESC, cc.id DESC`;

        const knex = strapi.db.connection;
        const result = await knex.raw(query, params);
        const rows = result?.rows || [];

        const serverUrl = (strapi.config.get("server.url") as string) || "";

        const formattedList = rows.map((row: any) => {
          let logoUrl: string | null = null;
          if (row.club_logo) {
            logoUrl = String(row.club_logo).startsWith("http")
              ? String(row.club_logo)
              : `${serverUrl}${row.club_logo}`;
          }

          return {
            id: row.id,
            documentId: row.document_id,
            subscriptionType: row.subscription_type,
            checkinTime: row.checkin_time
              ? new Date(row.checkin_time).toISOString()
              : null,
            checkoutTime: row.checkout_time
              ? new Date(row.checkout_time).toISOString()
              : null,
            status: row.checkout_time ? "checked-out" : "checked-in",
            club_name: row.club_name || null,
            club_logo: logoUrl,
          };
        });

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
