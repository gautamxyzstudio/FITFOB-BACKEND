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
  gym_membership: {
    select: [
      "id",
      "documentId",
      "membershipId",
      "duration",
      "durationMonths",
      "membershipStatus",
      "startDate",
      "endDate",
    ],
    populate: {
      gym_contract: {
        select: ["id", "documentId", "contractId"],
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
  const checkinType = item.checkinType || item.subscriptionType || "membership";

  return {
    id: item.id,
    documentId: item.documentId,
    checkinType,
    subscriptionType: checkinType,
    checkinTime: item.checkinTime,
    checkoutTime: item.checkoutTime,
    status: isCheckedOut ? "checked-out" : "checked-in",
    durationMinutes,
    client: item.client_detail
      ? {
          id: item.client_detail.id,
          documentId: item.client_detail.documentId,
          clientId: item.client_detail.clientId,
          name: item.client_detail.name,
          email: item.client_detail.email,
          gender: item.client_detail.gender,
          selfieUrl:
            item.client_detail.selfieUpload?.formats?.small?.url ||
            item.client_detail.selfieUpload?.formats?.thumbnail?.url ||
            item.client_detail.selfieUpload?.url ||
            null,
        }
      : null,
    clubOwner: item.club_owner
      ? {
          id: item.club_owner.id,
          documentId: item.club_owner.documentId,
          clubId: item.club_owner.clubId,
          clubName: item.club_owner.clubName,
          email: item.club_owner.email,
          logoUrl:
            item.club_owner.logo?.formats?.small?.url ||
            item.club_owner.logo?.formats?.thumbnail?.url ||
            item.club_owner.logo?.url ||
            null,
        }
      : null,
    gymMembership: item.gym_membership
      ? {
          id: item.gym_membership.id,
          documentId: item.gym_membership.documentId,
          membershipId: item.gym_membership.membershipId,
          duration: item.gym_membership.duration,
          durationMonths: item.gym_membership.durationMonths,
          membershipStatus: item.gym_membership.membershipStatus,
          startDate: item.gym_membership.startDate,
          endDate: item.gym_membership.endDate,
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
                membershipCount: 0,
                trialCount: 0,
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
                membershipCount: 0,
                trialCount: 0,
                activeCount: 0,
              },
            });
          }

          where.client_detail = {
            $in: clientDetailIds,
          };
        }
        // ============================================================
        // CHECKIN TYPE (MEMBERSHIP / TRIAL)
        // ============================================================

        const typeFilter =
          (ctx.query as any).checkinType ||
          (ctx.query as any).subscriptionType;
        if (typeFilter) {
          const normType = String(typeFilter).toLowerCase().trim();
          if (["membership", "trial"].includes(normType)) {
            where.checkinType = normType;
          }
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

        const [rawCheckins, total, membershipCount, trialCount, activeCount] =
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
                checkinType: "membership",
              },
            }),

            strapi.db.query(CHECKIN_UID).count({
              where: {
                ...where,
                checkinType: "trial",
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
          meta: {
            total,
            membershipCount,
            trialCount,
            activeCount,
          },
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
          checkinType,
          subscriptionType,
        } = ctx.query as any;

        const where: any = {
          client_detail: client.id,
        };

        // Date Range Filter
        if (startDate || endDate) {
          where.checkinTime = {};
          if (startDate) {
            const s = new Date(startDate);
            if (!isNaN(s.getTime())) {
              if (
                typeof startDate === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())
              ) {
                s.setHours(0, 0, 0, 0);
              }
              where.checkinTime.$gte = s;
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
              where.checkinTime.$lte = e;
            }
          }
        }

        // Check-in Type Filter (membership, trial)
        const rawType = checkinType || subscriptionType;
        if (rawType) {
          const types = (
            Array.isArray(rawType)
              ? rawType
              : String(rawType).split(",")
          )
            .map((t: any) => String(t).toLowerCase().trim())
            .filter((t: string) => Boolean(t) && t !== "all");

          if (types.length === 1) {
            where.checkinType = types[0];
          } else if (types.length > 1) {
            where.checkinType = { $in: types };
          }
        }

        const checkins = await strapi.db.query(CHECKIN_UID).findMany({
          where,
          populate: POPULATE_CONFIG,
          orderBy: {
            checkinTime: "desc",
            id: "desc",
          },
        });

        const serverUrl = (strapi.config.get("server.url") as string) || "";

        const formattedList = (Array.isArray(checkins) ? checkins : []).map(
          (item: any) => {
            const formatted = formatCheckin(item);
            const rawLogoUrl =
              item.club_owner?.logo?.formats?.small?.url ||
              item.club_owner?.logo?.formats?.thumbnail?.url ||
              item.club_owner?.logo?.url ||
              null;
            const logoUrl = rawLogoUrl
              ? String(rawLogoUrl).startsWith("http")
                ? String(rawLogoUrl)
                : `${serverUrl}${rawLogoUrl}`
              : null;

            return {
              ...formatted,
              club_name: item.club_owner?.clubName || null,
              club_logo: logoUrl,
            };
          },
        );

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

  
    async adminClientCheckin(ctx: Context) {
      try {
        let user = ctx.state?.user;

        // Fallback: Check Bearer token from header
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
                if (user) {
                  ctx.state.user = user;
                }
              }
            }
          } catch (_) {}
        }

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        // 1. Role verification: Only Admin and SuperAdmin
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

        // 2. Extract clientdocumentId
        const params = (ctx.params || {}) as any;
        const query = (ctx.query || {}) as any;

        const targetId =
          params.id ||
          params.clientdocumentId ||
          params.clientdocumentid ||
          query.clientdocumentId ||
          query.clientdocumentid ||
          query.id;

        if (!targetId || !String(targetId).trim()) {
          return ctx.badRequest("Please provide clientdocumentId in params");
        }

        const cleanDocId = String(targetId).trim();
        const isNum = !isNaN(Number(cleanDocId)) && /^\d+$/.test(cleanDocId);

        // 3. Resolve client profile
        let clientDetail: any = null;

        if ((strapi as any).documents && !isNum) {
          try {
            clientDetail = await (strapi as any)
              .documents(CLIENT_UID)
              .findOne({
                documentId: cleanDocId,
                select: ["id", "documentId", "clientId", "name"],
              });
          } catch (_) {}
        }

        if (!clientDetail) {
          clientDetail = await strapi.db.query(CLIENT_UID).findOne({
            where: isNum
              ? { $or: [{ id: Number(cleanDocId) }, { documentId: cleanDocId }] }
              : { $or: [{ documentId: cleanDocId }, { clientId: cleanDocId }] },
            select: ["id", "documentId", "clientId", "name"],
          });
        }

        if (!clientDetail) {
          return ctx.notFound(`Client with documentId '${cleanDocId}' not found`);
        }

        // 4. Fetch check-ins for this client
        const checkins: any[] = await strapi.db.query(CHECKIN_UID).findMany({
          where: {
            client_detail: clientDetail.id,
          },
          populate: {
            club_owner: {
              select: ["id", "clubName", "clubId", "ownerName"],
            },
          },
          orderBy: { checkinTime: "desc", createdAt: "desc", id: "desc" },
        });

        // 5. Format response with requested fields
        const responseData = checkins.map((item: any) => {
          const clubName =
            item.club_owner?.clubName ||
            item.club_owner?.name ||
            item.club_owner?.ownerName ||
            null;

          return {
            clubName,
            checkinType: item.checkinType || null,
            checkinTime: item.checkinTime || null,
            createdAt: item.createdAt || null,
          };
        });

        return ctx.send(responseData);
      } catch (error) {
        strapi.log.error("ADMIN CLIENT CHECKIN ERROR:", error);
        return ctx.internalServerError("Failed to fetch client check-ins");
      }
    },

    
  }),
);
