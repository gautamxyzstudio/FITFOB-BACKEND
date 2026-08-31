import { factories } from "@strapi/strapi";

const LOCAL_PLAN_UID =
  "api::local-membership-plan.local-membership-plan" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

/* ---------- FAST ROLE HELPER (AVOIDS REDUNDANT DB QUERIES) ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";

  if (user.role?.name || user.role?.type) {
    return (
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      ""
    );
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

  return (
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    ""
  );
}

/* ---------- HELPER: GET CLUB OWNER FOR A USER ---------- */
async function getClubOwnerForUser(userId: number) {
  // Method 1: Check user's populated club_owner relation
  const userWithDetail: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: userId },
      populate: {
        club_owner: {
          populate: {
            logo: true,
          },
        },
      },
    });

  if (userWithDetail?.club_owner?.id || userWithDetail?.club_owner?.documentId) {
    return userWithDetail.club_owner;
  }

  // Method 2: Query club-owner collection directly
  const directClubOwner: any = await strapi.db
    .query(CLUB_OWNER_UID)
    .findOne({
      where: {
        $or: [{ user: userId }, { user: { id: userId } }],
      },
      populate: {
        logo: true,
      },
    });

  return directClubOwner || null;
}

/* ---------- HELPER: MATCH PLAN'S OWNER WITH USER'S OWNER RECORD ---------- */
function isMatchingOwner(existingClubOwner: any, userClubOwner: any): boolean {
  if (!existingClubOwner || !userClubOwner) return false;

  // If existingClubOwner is an ID primitive (number or string)
  if (
    typeof existingClubOwner === "number" ||
    typeof existingClubOwner === "string"
  ) {
    if (
      String(existingClubOwner) === String(userClubOwner.id) ||
      String(existingClubOwner) === String(userClubOwner.documentId) ||
      (userClubOwner.clubId &&
        String(existingClubOwner) === String(userClubOwner.clubId))
    ) {
      return true;
    }
  }

  // Compare numeric id
  if (
    existingClubOwner.id &&
    userClubOwner.id &&
    Number(existingClubOwner.id) === Number(userClubOwner.id)
  ) {
    return true;
  }

  // Compare documentId
  if (
    existingClubOwner.documentId &&
    userClubOwner.documentId &&
    String(existingClubOwner.documentId) === String(userClubOwner.documentId)
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

        /* ---------- GET OWNER ID / DOCUMENT ID VIA TOKEN ONLY ---------- */
        let ownerRecord = await getClubOwnerForUser(user.id);

        if (!ownerRecord || (!ownerRecord.id && !ownerRecord.documentId)) {
          return ctx.badRequest(
            "Club owner profile not found for this account. Please complete club owner registration first.",
          );
        }

        if (!ownerRecord.id && ownerRecord.documentId) {
          const direct = await strapi.db.query(CLUB_OWNER_UID).findOne({
            where: { documentId: ownerRecord.documentId },
            populate: { logo: true },
          });
          if (direct) ownerRecord = direct;
        } else if (!ownerRecord.documentId && ownerRecord.id) {
          const direct = await strapi.db.query(CLUB_OWNER_UID).findOne({
            where: { id: ownerRecord.id },
            populate: { logo: true },
          });
          if (direct) ownerRecord = direct;
        }

        const ownerId = ownerRecord.id;
        const ownerDocId = ownerRecord.documentId;
        const targetClubOwnerId = ownerDocId || ownerId;

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const {
          planName,
          price,
          monthDuration,
          description,
          isActive = true,
        } = payload;

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

        // Check if plan with the exact same name already exists for this club
        const existingPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: {
            club_owner: ownerId || targetClubOwnerId,
            planName: planName.trim(),
          },
          select: ["id"],
        });

        if (existingPlan) {
          return ctx.badRequest(
            `A local membership plan named '${planName.trim()}' already exists for your club`,
          );
        }

        /* ---------- CREATE PLAN ---------- */
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
                  club_owner: ownerDocId || ownerId,
                },
                populate: {
                  club_owner: {
                    populate: ["logo"],
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
              club_owner: ownerId || ownerDocId,
            },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
          });
        }

        // Ensure database relation is firmly linked and populated
        if (!createdPlan?.club_owner && ownerId) {
          await strapi.db.query(LOCAL_PLAN_UID).update({
            where: { id: createdPlan.id },
            data: {
              club_owner: ownerId,
            },
          });

          createdPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
            where: { id: createdPlan.id },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
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

        const ownerDocId = club_owner.trim();

        const ownerRecord = await strapi.db.query(CLUB_OWNER_UID).findOne({
          where: { documentId: ownerDocId },
          populate: { logo: true },
        });

        if (!ownerRecord) {
          return ctx.notFound(
            `Club owner with documentId '${ownerDocId}' not found`,
          );
        }

        const finalOwnerId = ownerRecord.id;

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

        // Check if plan with the exact same name already exists for this club
        const existingPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: {
            club_owner: finalOwnerId,
            planName: planName.trim(),
          },
          select: ["id"],
        });

        if (existingPlan) {
          return ctx.badRequest(
            `A local membership plan named '${planName.trim()}' already exists for this club`,
          );
        }

        /* ---------- CREATE PLAN ---------- */
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
                  club_owner: ownerDocId,
                },
                populate: {
                  club_owner: {
                    populate: ["logo"],
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
              club_owner: finalOwnerId,
            },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
          });
        }

        if (!createdPlan?.club_owner && finalOwnerId) {
          await strapi.db.query(LOCAL_PLAN_UID).update({
            where: { id: createdPlan.id },
            data: {
              club_owner: finalOwnerId,
            },
          });

          createdPlan = await strapi.db.query(LOCAL_PLAN_UID).findOne({
            where: { id: createdPlan.id },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
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
       FIND ALL / FILTER LOCAL MEMBERSHIP PLANS (OPTIMIZED DB QUERY)
    ======================================================= */
    async find(ctx) {
      try {
        const { search, club_owner, isActive } = ctx.query as any;

        const filters: any = {};

        if (club_owner) {
          filters.club_owner = {
            documentId: String(club_owner).trim(),
          };
        }

        if (isActive !== undefined) {
          filters.isActive = isActive === "true" || isActive === true;
        }

        if (search?.trim()) {
          const s = search.trim();
          filters.$or = [
            { planName: { $containsi: s } },
            { description: { $containsi: s } },
          ];
        }

        const data: any = await strapi.entityService.findMany(
          LOCAL_PLAN_UID,
          {
            filters,
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
            sort: { id: "desc" },
          },
        );

        const list = Array.isArray(data) ? data : data ? [data] : [];

        return ctx.send({
          total: list.length,
          data: list,
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

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const entity: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: {
            club_owner: {
              populate: ["logo", "clubPhotos"],
            },
          },
        });

        if (!entity) {
          return ctx.notFound("Local membership plan not found");
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

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: { club_owner: true },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        // Ownership check for authenticated club owners
        if (roleName === "clubowner") {
          const userClubOwner = await getClubOwnerForUser(user.id);

          if (!userClubOwner || !isMatchingOwner(existing.club_owner, userClubOwner)) {
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

        const { planName, price, monthDuration, description, isActive } =
          payload;
        const updateData: any = {};

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

        const updated = await strapi.entityService.update(
          LOCAL_PLAN_UID,
          existing.id,
          {
            data: updateData,
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
          },
        );

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

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: { club_owner: true },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        if (roleName === "clubowner") {
          const userClubOwner = await getClubOwnerForUser(user.id);

          if (!userClubOwner || !isMatchingOwner(existing.club_owner, userClubOwner)) {
            return ctx.forbidden(
              "You are not authorized to delete plans belonging to another club",
            );
          }
        } else if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can delete plans.",
          );
        }

        await strapi.entityService.delete(LOCAL_PLAN_UID, existing.id);

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
       GET MY CLUB'S MEMBERSHIP PLANS (LOGGED-IN OWNER)
    ======================================================= */
    async getMyPlans(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clubOwner = await getClubOwnerForUser(user.id);

        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found for this account");
        }

        const rawPlans: any = await strapi.entityService.findMany(
          LOCAL_PLAN_UID,
          {
            filters: {
              club_owner: { id: clubOwner.id },
            },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
            sort: { id: "desc" },
          },
        );

        const plans: any[] = Array.isArray(rawPlans)
          ? rawPlans
          : rawPlans
          ? [rawPlans]
          : [];

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

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: { club_owner: true },
        });

        if (!existing) {
          return ctx.notFound("Local membership plan not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user.id);

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

        const updated = await strapi.entityService.update(
          LOCAL_PLAN_UID,
          existing.id,
          {
            data: {
              isActive: newActiveStatus,
            },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
            },
          },
        );

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
