import { factories } from "@strapi/strapi";

const LOCAL_PLAN_UID =
  "api::local-membership-plan.local-membership-plan" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

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

/* ---------- HELPER: EXTRACT LOGO URL ---------- */
function extractLogoUrl(logo: any): string | null {
  if (!logo) return null;
  if (typeof logo === "string") return logo;
  return (
    logo.url ||
    logo.formats?.thumbnail?.url ||
    logo.formats?.small?.url ||
    null
  );
}

/* ---------- HELPER: FORMAT CLUB OWNER ---------- */
function formatClubOwner(owner: any): any {
  if (!owner) return null;
  return {
    id: owner.id,
    documentId: owner.documentId,
    clubId: owner.clubId,
    ownerName: owner.ownerName,
    clubName: owner.clubName,
    phoneNumber: owner.phoneNumber,
    email: owner.email,
    clubAddress: owner.clubAddress,
    city: owner.city,
    state: owner.state,
    pincode: owner.pincode,
    logo: extractLogoUrl(owner.logo),
  };
}

/* ---------- VALIDATE VALID UPTO HELPER ---------- */
function validateAndNormalizeValidUpto(validUpto: any): {
  isValid: boolean;
  value?: string;
  error?: string;
} {
  if (
    validUpto === undefined ||
    validUpto === null ||
    String(validUpto).trim() === ""
  ) {
    return { isValid: true, value: "unlimited" };
  }

  const str = String(validUpto).trim();
  if (str.toLowerCase() === "unlimited") {
    return { isValid: true, value: "unlimited" };
  }

  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    return {
      isValid: false,
      error:
        "validUpto must be 'unlimited' or a valid date string (e.g. YYYY-MM-DD or ISO 8601)",
    };
  }

  return { isValid: true, value: str };
}

/* ---------- CLUB OWNER LOOKUP ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation (single clean join, avoids 4-join $or overhead)
  let owner: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { user: userId },
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
    ],
    populate: {
      logo: {
        select: ["url", "formats"],
      },
    },
  });

  // 2. Fallback via user table if direct query returned null
  if (!owner) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
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
              "clubAddress",
              "city",
              "state",
              "pincode",
            ],
            populate: {
              logo: {
                select: ["url", "formats"],
              },
            },
          },
        },
      });

    owner = userWithDetail?.club_owner || null;
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- HELPER: MATCH PLAN'S OWNER WITH USER'S OWNER RECORD ---------- */
function isMatchingOwner(existingClubOwner: any, userClubOwner: any): boolean {
  if (!existingClubOwner || !userClubOwner) return false;

  // Compare documentId
  const existingDocId =
    typeof existingClubOwner === "string"
      ? existingClubOwner
      : existingClubOwner.documentId;
  if (
    existingDocId &&
    userClubOwner.documentId &&
    String(existingDocId) === String(userClubOwner.documentId)
  ) {
    return true;
  }

  // Compare numeric / string id
  const existingId =
    typeof existingClubOwner === "number" || typeof existingClubOwner === "string"
      ? existingClubOwner
      : existingClubOwner.id;
  if (
    existingId &&
    userClubOwner.id &&
    String(existingId) === String(userClubOwner.id)
  ) {
    return true;
  }

  // Compare clubId if present
  if (
    existingClubOwner.clubId &&
    userClubOwner.clubId &&
    String(existingClubOwner.clubId) === String(userClubOwner.clubId)
  ) {
    return true;
  }

  return false;
}

export default factories.createCoreController(
  "api::local-membership-plan.local-membership-plan",
  ({ strapi }) => ({
    /* =======================================================
       CREATE LOCAL MEMBERSHIP PLAN (CLUB OWNER ONLY)
    ======================================================= */
    async create(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "clubowner") {
          return ctx.forbidden(
            "Access denied. Only users with the ClubOwner role can create local membership plans.",
          );
        }

        /* ---------- GET OWNER RECORD ---------- */
        const ownerRecord = await getClubOwnerForUser(user);

        if (!ownerRecord || !ownerRecord.documentId) {
          return ctx.badRequest(
            "Club owner profile not found for this account. Please complete club owner registration first.",
          );
        }

        const ownerDocId = ownerRecord.documentId;
        const ownerId = ownerRecord.id;

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const {
          planName,
          price,
          monthDuration,
          description,
          isActive = true,
          validUpto,
        } = payload;

        /* ---------- VALIDATION ---------- */
        if (!planName || typeof planName !== "string" || !planName.trim()) {
          return ctx.badRequest(
            "planName is required and must be a non-empty string",
          );
        }

        const validUptoCheck = validateAndNormalizeValidUpto(validUpto);
        if (!validUptoCheck.isValid) {
          return ctx.badRequest(validUptoCheck.error);
        }
        const normalizedValidUpto = validUptoCheck.value;

        if (
          price === undefined ||
          price === null ||
          isNaN(Number(price)) ||
          Number(price) < 0
        ) {
          return ctx.badRequest(
            "price is required and must be a valid positive number",
          );
        }

        if (
          monthDuration === undefined ||
          monthDuration === null ||
          isNaN(Number(monthDuration)) ||
          Number(monthDuration) <= 0 ||
          !Number.isInteger(Number(monthDuration))
        ) {
          return ctx.badRequest(
            "monthDuration is required and must be a positive integer (e.g. 1, 3, 6, 12)",
          );
        }

        // Check if plan with the exact same name already exists for this club (direct FK lookup)
        const existingPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: {
            club_owner: ownerId,
            planName: planName.trim(),
          },
          select: ["id"],
        });

        if (existingPlan) {
          return ctx.badRequest(
            `A local membership plan named '${planName.trim()}' already exists for your club`,
          );
        }

        /* ---------- CREATE PLAN (NO LOGO POPULATED) ---------- */
        let createdPlan: any = null;

        if ((strapi as any).documents) {
          try {
            createdPlan = await (strapi as any)
              .documents(LOCAL_PLAN_UID)
              .create({
                data: {
                  planName: planName.trim(),
                  price: Number(price),
                  monthDuration: parseInt(monthDuration, 10),
                  description: description?.trim() || null,
                  isActive: Boolean(isActive),
                  validUpto: normalizedValidUpto,
                  club_owner: ownerDocId,
                },
                populate: {
                  club_owner: {
                    fields: [
                      "id",
                      "documentId",
                      "clubId",
                      "clubName",
                      "ownerName",
                    ],
                  },
                },
              });
          } catch (docErr) {
            strapi.log.warn("documents.create fallback in create:", docErr);
          }
        }

        if (!createdPlan) {
          createdPlan = await strapi.entityService.create(LOCAL_PLAN_UID, {
            data: {
              planName: planName.trim(),
              price: Number(price),
              monthDuration: parseInt(monthDuration, 10),
              description: description?.trim() || null,
              isActive: Boolean(isActive),
              validUpto: normalizedValidUpto,
              club_owner: ownerDocId || ownerId,
            },
            populate: {
              club_owner: true,
            },
          });
        }

        return ctx.send(
          {
            message: "Local membership plan created successfully",
            data: createdPlan,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("CREATE LOCAL MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to create local membership plan",
        );
      }
    },

    /* =======================================================
       ADMIN / SUPERADMIN CREATE LOCAL MEMBERSHIP PLAN FOR ANY OWNER
    ======================================================= */
    async adminCreate(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can create membership plans for other owners.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const {
          club_owner,
          planName,
          price,
          monthDuration,
          description,
          isActive = true,
          validUpto,
        } = payload;

        /* ---------- RESOLVE TARGET CLUB OWNER (DOCUMENT ID) ---------- */
        if (
          !club_owner ||
          typeof club_owner !== "string" ||
          !club_owner.trim()
        ) {
          return ctx.badRequest(
            "club_owner documentId is required and must be a non-empty string",
          );
        }

        const validUptoCheck = validateAndNormalizeValidUpto(validUpto);
        if (!validUptoCheck.isValid) {
          return ctx.badRequest(validUptoCheck.error);
        }
        const normalizedValidUpto = validUptoCheck.value;

        const ownerDocId = club_owner.trim();

        const ownerRecord = await strapi.db.query(CLUB_OWNER_UID).findOne({
          where: { documentId: ownerDocId },
          select: [
            "id",
            "documentId",
            "clubId",
            "clubName",
            "ownerName",
          ],
        });

        if (!ownerRecord) {
          return ctx.notFound(
            `Club owner with documentId '${ownerDocId}' not found`,
          );
        }

        /* ---------- VALIDATION ---------- */
        if (!planName || typeof planName !== "string" || !planName.trim()) {
          return ctx.badRequest(
            "planName is required and must be a non-empty string",
          );
        }

        if (
          price === undefined ||
          price === null ||
          isNaN(Number(price)) ||
          Number(price) < 0
        ) {
          return ctx.badRequest(
            "price is required and must be a valid positive number",
          );
        }

        if (
          monthDuration === undefined ||
          monthDuration === null ||
          isNaN(Number(monthDuration)) ||
          Number(monthDuration) <= 0 ||
          !Number.isInteger(Number(monthDuration))
        ) {
          return ctx.badRequest(
            "monthDuration is required and must be a positive integer (e.g. 1, 3, 6, 12)",
          );
        }

        // Check duplicate by foreign key
        const existingPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: {
            club_owner: ownerRecord.id,
            planName: planName.trim(),
          },
          select: ["id"],
        });

        if (existingPlan) {
          return ctx.badRequest(
            `A local membership plan named '${planName.trim()}' already exists for this club`,
          );
        }

        /* ---------- CREATE PLAN (NO LOGO POPULATED) ---------- */
        let createdPlan: any = null;

        if ((strapi as any).documents) {
          try {
            createdPlan = await (strapi as any)
              .documents(LOCAL_PLAN_UID)
              .create({
                data: {
                  planName: planName.trim(),
                  price: Number(price),
                  monthDuration: parseInt(monthDuration, 10),
                  description: description?.trim() || null,
                  isActive: Boolean(isActive),
                  validUpto: normalizedValidUpto,
                  club_owner: ownerDocId,
                },
                populate: {
                  club_owner: {
                    fields: [
                      "id",
                      "documentId",
                      "clubId",
                      "clubName",
                      "ownerName",
                    ],
                  },
                },
              });
          } catch (docErr) {
            strapi.log.warn("adminCreate documents.create fallback:", docErr);
          }
        }

        if (!createdPlan) {
          createdPlan = await strapi.entityService.create(LOCAL_PLAN_UID, {
            data: {
              planName: planName.trim(),
              price: Number(price),
              monthDuration: parseInt(monthDuration, 10),
              description: description?.trim() || null,
              isActive: Boolean(isActive),
              validUpto: normalizedValidUpto,
              club_owner: ownerDocId,
            },
            populate: {
              club_owner: true,
            },
          });
        }

        return ctx.send(
          {
            message:
              "Local membership plan created successfully for club owner",
            data: createdPlan,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("ADMIN CREATE LOCAL MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to create local membership plan",
        );
      }
    },

    /* =======================================================
       FIND ALL / FILTER LOCAL MEMBERSHIP PLANS
    ======================================================= */
    async find(ctx) {
      try {
        const { search, club_owner, isActive } = ctx.query as any;

        const where: any = {};

        if (isActive !== undefined) {
          where.isActive = isActive === "true" || isActive === true;
        }

        if (search?.trim()) {
          const s = search.trim();
          where.$or = [
            { planName: { $containsi: s } },
            { description: { $containsi: s } },
          ];
        }

        // Case 1: Specific club_owner requested (most common)
        if (club_owner) {
          const ownerDocId = String(club_owner).trim();
          where.club_owner = { documentId: ownerDocId };

          // Fetch owner details and plans concurrently via Promise.all
          const [ownerRecord, rawPlans] = await Promise.all([
            strapi.db.query(CLUB_OWNER_UID).findOne({
              where: { documentId: ownerDocId },
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
              ],
              populate: {
                logo: {
                  select: ["url", "formats"],
                },
              },
            }),
            strapi.db.query(LOCAL_PLAN_UID).findMany({
              where,
              orderBy: { id: "desc" },
            }),
          ]);

          const formattedOwner = ownerRecord ? formatClubOwner(ownerRecord) : null;

          const plans = (Array.isArray(rawPlans) ? rawPlans : []).map(
            (plan: any) => ({
              ...plan,
              club_owner: formattedOwner,
            }),
          );

          return ctx.send({
            total: plans.length,
            data: plans,
          });
        }

        // Case 2: Multi-club query (e.g. admin listing all plans)
        const rawPlans: any[] = await strapi.db.query(LOCAL_PLAN_UID).findMany({
          where,
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
                "clubAddress",
                "city",
                "state",
                "pincode",
              ],
              populate: {
                logo: {
                  select: ["url", "formats"],
                },
              },
            },
          },
          orderBy: { id: "desc" },
        });

        const plans = (Array.isArray(rawPlans) ? rawPlans : []).map(
          (plan: any) => ({
            ...plan,
            club_owner: plan.club_owner ? formatClubOwner(plan.club_owner) : null,
          }),
        );

        return ctx.send({
          total: plans.length,
          data: plans,
        });
      } catch (error) {
        strapi.log.error("FIND LOCAL MEMBERSHIP PLANS ERROR:", error);
        return ctx.internalServerError(
          "Failed to fetch local membership plans",
        );
      }
    },

    /* =======================================================
       GET SINGLE LOCAL MEMBERSHIP PLAN
    ======================================================= */
    async findOne(ctx) {
      try {
        const { id } = ctx.params;

        if (id === "my-plan" || id === "my-plans" || id === "me") {
          return await (this as any).getMyPlans(ctx);
        }

        const documentId = String(id).trim();

        const entity: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: { documentId },
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
                "clubAddress",
                "city",
                "state",
                "pincode",
              ],
              populate: {
                logo: {
                  select: ["url", "formats"],
                },
              },
            },
          },
        });

        if (!entity) {
          return ctx.notFound("Local membership plan not found");
        }

        if (entity.club_owner) {
          entity.club_owner = formatClubOwner(entity.club_owner);
        }

        return ctx.send({
          data: entity,
        });
      } catch (error) {
        strapi.log.error("FIND ONE LOCAL MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError("Failed to fetch local membership plan");
      }
    },

    /* =======================================================
       UPDATE LOCAL MEMBERSHIP PLAN
    ======================================================= */
    async update(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
          populate: {
            club_owner: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        // Ownership check for authenticated club owners
        if (roleName === "clubowner") {
          const userClubOwner = await getClubOwnerForUser(user);

          if (
            !userClubOwner ||
            !isMatchingOwner(existing.club_owner, userClubOwner)
          ) {
            return ctx.forbidden(
              "You are not authorized to modify plans belonging to another club",
            );
          }
        } else if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can modify plans.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { planName, price, monthDuration, description, isActive, validUpto } =
          payload;
        const updateData: any = {};

        if (validUpto !== undefined) {
          const validUptoCheck = validateAndNormalizeValidUpto(validUpto);
          if (!validUptoCheck.isValid) {
            return ctx.badRequest(validUptoCheck.error);
          }
          updateData.validUpto = validUptoCheck.value;
        }

        if (planName !== undefined) {
          if (typeof planName !== "string" || !planName.trim()) {
            return ctx.badRequest("planName must be a non-empty string");
          }
          updateData.planName = planName.trim();
        }

        if (price !== undefined) {
          if (isNaN(Number(price)) || Number(price) < 0) {
            return ctx.badRequest("price must be a positive number");
          }
          updateData.price = Number(price);
        }

        if (monthDuration !== undefined) {
          if (
            isNaN(Number(monthDuration)) ||
            Number(monthDuration) <= 0 ||
            !Number.isInteger(Number(monthDuration))
          ) {
            return ctx.badRequest("monthDuration must be a positive integer");
          }
          updateData.monthDuration = parseInt(monthDuration, 10);
        }

        if (description !== undefined) {
          updateData.description = description?.trim() || null;
        }

        if (isActive !== undefined) {
          updateData.isActive = Boolean(isActive);
        }

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(LOCAL_PLAN_UID).update({
              documentId: existing.documentId,
              data: updateData,
            });
          } catch (docErr) {
            strapi.log.warn("documents.update fallback in update:", docErr);
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            LOCAL_PLAN_UID,
            existing.id,
            {
              data: updateData,
            },
          );
        }

        return ctx.send({
          message: "Local membership plan updated successfully",
          data: updated,
        });
      } catch (error) {
        strapi.log.error("UPDATE LOCAL MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to update local membership plan",
        );
      }
    },

    /* =======================================================
       DELETE LOCAL MEMBERSHIP PLAN
    ======================================================= */
    async delete(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
          populate: {
            club_owner: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        if (roleName === "clubowner") {
          const userClubOwner = await getClubOwnerForUser(user);

          if (
            !userClubOwner ||
            !isMatchingOwner(existing.club_owner, userClubOwner)
          ) {
            return ctx.forbidden(
              "You are not authorized to delete plans belonging to another club",
            );
          }
        } else if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can delete plans.",
          );
        }

        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(LOCAL_PLAN_UID).delete({
            documentId: existing.documentId,
          });
        } else {
          await strapi.entityService.delete(LOCAL_PLAN_UID, existing.id);
        }

        return ctx.send({
          message: "Local membership plan deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE LOCAL MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to delete local membership plan",
        );
      }
    },

    /* =======================================================
       GET MY CLUB'S MEMBERSHIP PLANS (LOGGED-IN OWNER - ULTRA FAST)
    ======================================================= */
    async getMyPlans(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clubOwner = await getClubOwnerForUser(user);

        if (!clubOwner || !clubOwner.documentId) {
          return ctx.notFound("Club owner profile not found for this account");
        }

        const formattedOwner = formatClubOwner(clubOwner);

        // Direct SQL query using foreign key
        const rawPlans: any[] = await strapi.db.query(LOCAL_PLAN_UID).findMany({
          where: {
            club_owner: clubOwner.id,
          },
          orderBy: { id: "desc" },
        });

        const plans = (Array.isArray(rawPlans) ? rawPlans : []).map(
          (plan: any) => ({
            ...plan,
            club_owner: formattedOwner,
          }),
        );

        return ctx.send({
          total: plans.length,
          data: plans,
        });
      } catch (error) {
        strapi.log.error("GET MY LOCAL PLANS ERROR:", error);
        return ctx.internalServerError("Failed to fetch membership plans");
      }
    },

    /* =======================================================
       TOGGLE PLAN ACTIVE STATUS (PUT / PATCH)
    ======================================================= */
    async toggleStatus(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId", "isActive"],
          populate: {
            club_owner: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);

          if (!ownerRecord) {
            return ctx.badRequest(
              "Club owner profile not found for this account.",
            );
          }

          if (!isMatchingOwner(existing.club_owner, ownerRecord)) {
            return ctx.forbidden(
              "Access denied. You can only toggle the active status of your own club's membership plans.",
            );
          }
        } else if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can toggle plan status.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const newActiveStatus =
          payload.isActive !== undefined
            ? Boolean(payload.isActive)
            : !existing.isActive;

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(LOCAL_PLAN_UID).update({
              documentId: existing.documentId,
              data: {
                isActive: newActiveStatus,
              },
            });
          } catch (docErr) {
            strapi.log.warn("documents.update fallback in toggleStatus:", docErr);
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            LOCAL_PLAN_UID,
            existing.id,
            {
              data: {
                isActive: newActiveStatus,
              },
            },
          );
        }

        return ctx.send({
          message: `Local membership plan ${
            updated.isActive ? "activated" : "deactivated"
          } successfully`,
          data: updated,
        });
      } catch (error) {
        strapi.log.error("TOGGLE LOCAL PLAN STATUS ERROR:", error);
        return ctx.internalServerError("Failed to toggle plan status");
      }
    },
  })
);
