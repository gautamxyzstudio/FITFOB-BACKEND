import { factories } from "@strapi/strapi";

const OUTDOOR_PLAN_UID =
  "api::outdoor-membership-plan.outdoor-membership-plan" as any;

/* ---------- FAST ROLE HELPER (AVOIDS REDUNDANT DB QUERIES) ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";

  // 1. Fast memory check if role is already on ctx.state.user
  if (user.role?.name || user.role?.type) {
    return (
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      ""
    );
  }

  // 2. Lean DB query with minimal selects
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

export default factories.createCoreController(
  "api::outdoor-membership-plan.outdoor-membership-plan",
  ({ strapi }) => ({
    /* =======================================================
       CREATE OUTDOOR MEMBERSHIP PLAN (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async create(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can create outdoor membership plans.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const {
          planName,
          price,
          visitAllowed,
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
          visitAllowed === undefined ||
          visitAllowed === null ||
          isNaN(Number(visitAllowed)) ||
          Number(visitAllowed) <= 0 ||
          !Number.isInteger(Number(visitAllowed))
        ) {
          return ctx.badRequest(
            "visitAllowed is required and must be a positive integer (e.g. 5, 10, 20)",
          );
        }

        // Check if plan with the exact same name already exists
        const existingPlan = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: {
            planName: planName.trim(),
          },
          select: ["id"],
        });

        if (existingPlan) {
          return ctx.badRequest(
            `An outdoor membership plan named '${planName.trim()}' already exists`,
          );
        }

        /* ---------- CREATE PLAN ---------- */
        const createdPlan = await strapi.entityService.create(
          OUTDOOR_PLAN_UID,
          {
            data: {
              planName: planName.trim(),
              price: Number(price),
              visitAllowed: parseInt(visitAllowed, 10),
              description: description?.trim() || null,
              isActive: Boolean(isActive),
            },
          },
        );

        return ctx.send(
          {
            message: "Outdoor membership plan created successfully",
            data: createdPlan,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("CREATE OUTDOOR MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to create outdoor membership plan",
        );
      }
    },

    /* =======================================================
       FIND ALL / FILTER OUTDOOR MEMBERSHIP PLANS (OPTIMIZED DB QUERY)
    ======================================================= */
    async find(ctx) {
      try {
        const { search, isActive } = ctx.query as any;

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

        const data = await strapi.db.query(OUTDOOR_PLAN_UID).findMany({
          where,
          orderBy: { id: "desc" },
        });

        return ctx.send({
          total: data.length,
          data,
        });
      } catch (error) {
        strapi.log.error("FIND OUTDOOR MEMBERSHIP PLANS ERROR:", error);
        return ctx.internalServerError(
          "Failed to fetch outdoor membership plans",
        );
      }
    },

    /* =======================================================
       GET SINGLE OUTDOOR MEMBERSHIP PLAN
    ======================================================= */
    async findOne(ctx) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Plan ID is required");
        }

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const entity: any = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
        });

        if (!entity) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        return ctx.send({
          data: entity,
        });
      } catch (error) {
        strapi.log.error("FIND ONE OUTDOOR MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to fetch outdoor membership plan",
        );
      }
    },

    /* =======================================================
       UPDATE OUTDOOR MEMBERSHIP PLAN (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async update(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can update outdoor membership plans.",
          );
        }

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          select: ["id"],
        });

        if (!existing) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { planName, price, visitAllowed, description, isActive } =
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

        if (visitAllowed !== undefined) {
          if (
            isNaN(Number(visitAllowed)) ||
            Number(visitAllowed) <= 0 ||
            !Number.isInteger(Number(visitAllowed))
          ) {
            return ctx.badRequest("visitAllowed must be a positive integer");
          }
          updateData.visitAllowed = parseInt(visitAllowed, 10);
        }

        if (description !== undefined) {
          updateData.description = description?.trim() || null;
        }

        if (isActive !== undefined) {
          updateData.isActive = Boolean(isActive);
        }

        const updated = await strapi.entityService.update(
          OUTDOOR_PLAN_UID,
          existing.id,
          {
            data: updateData,
          },
        );

        return ctx.send({
          message: "Outdoor membership plan updated successfully",
          data: updated,
        });
      } catch (error) {
        strapi.log.error("UPDATE OUTDOOR MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to update outdoor membership plan",
        );
      }
    },

    /* =======================================================
       DELETE OUTDOOR MEMBERSHIP PLAN (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async delete(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can delete outdoor membership plans.",
          );
        }

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          select: ["id"],
        });

        if (!existing) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        await strapi.entityService.delete(OUTDOOR_PLAN_UID, existing.id);

        return ctx.send({
          message: "Outdoor membership plan deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE OUTDOOR MEMBERSHIP PLAN ERROR:", error);
        return ctx.internalServerError(
          "Failed to delete outdoor membership plan",
        );
      }
    },

    /* =======================================================
       TOGGLE PLAN ACTIVE STATUS (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async toggleStatus(ctx) {
      try {
        const { id } = ctx.params;

        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can toggle outdoor plan status.",
          );
        }

        const isNumeric =
          !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          select: ["id", "isActive"],
        });

        if (!existing) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const newActiveStatus =
          payload.isActive !== undefined
            ? Boolean(payload.isActive)
            : !existing.isActive;

        const updated = await strapi.entityService.update(
          OUTDOOR_PLAN_UID,
          existing.id,
          {
            data: {
              isActive: newActiveStatus,
            },
          },
        );

        return ctx.send({
          message: `Outdoor membership plan ${
            updated.isActive ? "activated" : "deactivated"
          } successfully`,
          data: updated,
        });
      } catch (error) {
        strapi.log.error("TOGGLE OUTDOOR PLAN STATUS ERROR:", error);
        return ctx.internalServerError("Failed to toggle plan status");
      }
    },
  })
);
