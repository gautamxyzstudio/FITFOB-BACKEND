import { factories } from "@strapi/strapi";

const OUTDOOR_PLAN_UID =
  "api::outdoor-membership-plan.outdoor-membership-plan" as any;

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

        // Check duplicate plan name
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
        let createdPlan: any = null;

        if ((strapi as any).documents) {
          try {
            createdPlan = await (strapi as any)
              .documents(OUTDOOR_PLAN_UID)
              .create({
                data: {
                  planName: planName.trim(),
                  price: Number(price),
                  visitAllowed: parseInt(visitAllowed, 10),
                  description: description?.trim() || null,
                  isActive: Boolean(isActive),
                  validUpto: normalizedValidUpto,
                },
              });
          } catch (docErr) {
            strapi.log.warn("documents.create fallback in create:", docErr);
          }
        }

        if (!createdPlan) {
          createdPlan = await strapi.entityService.create(OUTDOOR_PLAN_UID, {
            data: {
              planName: planName.trim(),
              price: Number(price),
              visitAllowed: parseInt(visitAllowed, 10),
              description: description?.trim() || null,
              isActive: Boolean(isActive),
              validUpto: normalizedValidUpto,
            },
          });
        }

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
       FIND ALL / FILTER OUTDOOR MEMBERSHIP PLANS
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

        const data: any[] = await strapi.db.query(OUTDOOR_PLAN_UID).findMany({
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

        const documentId = String(id).trim();

        const entity: any = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: { documentId },
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

        const documentId = String(id).trim();

        const existing = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
        });

        if (!existing) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { planName, price, visitAllowed, description, isActive, validUpto } =
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

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(OUTDOOR_PLAN_UID).update({
              documentId: existing.documentId,
              data: updateData,
            });
          } catch (docErr) {
            strapi.log.warn("documents.update fallback in update:", docErr);
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            OUTDOOR_PLAN_UID,
            existing.id,
            {
              data: updateData,
            },
          );
        }

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

        const documentId = String(id).trim();

        const existing = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
        });

        if (!existing) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(OUTDOOR_PLAN_UID).delete({
            documentId: existing.documentId,
          });
        } else {
          await strapi.entityService.delete(OUTDOOR_PLAN_UID, existing.id);
        }

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

        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
          where: { documentId },
          select: ["id", "documentId", "isActive"],
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

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(OUTDOOR_PLAN_UID).update({
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
            OUTDOOR_PLAN_UID,
            existing.id,
            {
              data: {
                isActive: newActiveStatus,
              },
            },
          );
        }

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
