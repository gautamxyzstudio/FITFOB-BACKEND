import { factories } from "@strapi/strapi";
import { Context } from "koa";
import {
  normalizeWeekdayScheduling,
  orderWeekdayScheduling,
} from "../../../utils/weekdayScheduling";
import {
  resolveClubServiceIds,
  resolveClubFacilityIds,
} from "../../../utils/resolveClubRelations";

const POPULATE: any = {
  user: true,
  logo: true,
  club_photos: {
    populate: ["images"],
  },
  club_owner_documents: {
    populate: ["File"],
  },
  club_services: {
    populate: ["logo"],
  },
  club_facilities: {
    populate: ["logo"],
  },
};

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

/* ---------- CLUB OWNER LOOKUP ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

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
    ],
  });

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
            ],
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

export default factories.createCoreController(
  "api::club-owner.club-owner",
  ({ strapi }) => ({
    /* =======================================================
       VERIFIED CLUB OWNERS
    ======================================================= */
    async find(ctx: Context) {
      try {
        const { search } = ctx.query as any;

        const filters: any = {
          user: { verification_status: "approved" },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: {
              user: true,
              logo: true,
            },
            filters,
            sort: { id: "desc" },
          },
        );

        const dataWithCurrentStep = data.map((item: any) => {
          return {
            id: item.id,
            documentId: item.documentId,
            ownerName: item.ownerName,
            clubName: item.clubName,
            clubId: item.clubId,
            phoneNumber: item.phoneNumber,
            logo:
              item.logo?.formats?.thumbnail?.url || item.logo?.url || null,
            createdAt: item.createdAt,
            clubAddress: item.clubAddress,
            city: item.city,
            state: item.state,
            user: {
              email: item.user?.email || null,
              verification_status: item.user?.verification_status || null,
            },
            pincode: item.pincode,
          };
        });

        let finalData = dataWithCurrentStep;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = dataWithCurrentStep.filter((item: any) => {
            const owner = item.ownerName?.replace(/\s+/g, "").toLowerCase();
            const club = item.clubName?.replace(/\s+/g, "").toLowerCase();

            return owner?.includes(searchValue) || club?.includes(searchValue);
          });
        }

        // finalData = finalData.map((item) => {
        //   const obj = JSON.parse(JSON.stringify(item));

        //   return {
        //     ...obj,
        //     isRead: (obj.read_by_admins || []).length > 0,
        //   };
        // });

        ctx.body = finalData;
      } catch (err) {
        strapi.log.error("FETCH VERIFIED CLUB OWNERS ERROR:", err);
        return ctx.internalServerError("Failed to fetch verified club owners");
      }
    },

    /* =======================================================
       UNVERIFIED CLUB OWNERS
    ======================================================= */
    async unverified(ctx: Context) {
      try {
        const { search } = ctx.query as any;

        const filters: any = {
          user: { verification_status: "pending" },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters,
            sort: { id: "desc" },
          },
        );

        let finalData = data;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = data.filter((item: any) => {
            const owner = item.ownerName?.replace(/\s+/g, "").toLowerCase();
            const club = item.clubName?.replace(/\s+/g, "").toLowerCase();

            return owner?.includes(searchValue) || club?.includes(searchValue);
          });
        }

        finalData = finalData.map((item) => {
          const obj = JSON.parse(JSON.stringify(item));

          return {
            ...obj,
            isRead: (obj.read_by_admins || []).length > 0,
          };
        });

        ctx.body = finalData;
      } catch (err) {
        strapi.log.error("FETCH UNVERIFIED CLUB OWNERS ERROR:", err);
        return ctx.internalServerError(
          "Failed to fetch unverified club owners",
        );
      }
    },

    /* =======================================================
       GET SINGLE CLUB OWNER 
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        const entity: any = await strapi.entityService.findOne(
          "api::club-owner.club-owner",
          id,
          { populate: POPULATE },
        );

        if (!entity || !entity.user) {
          return ctx.notFound("Club owner not found");
        }

        if (entity.weekdayScheduling) {
          entity.weekdayScheduling = orderWeekdayScheduling(
            entity.weekdayScheduling,
          );
        }

        ctx.body = entity;
      } catch (err) {
        strapi.log.error("GET CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to fetch club owner");
      }
    },

    /* =======================================================
       UPDATE CLUB OWNER
    ======================================================= */
    async update(ctx: Context) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        if (!data || Object.keys(data).length === 0) {
          return ctx.badRequest("Update data is required");
        }

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id));
        let existing: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
          where: isNumeric ? { id: Number(id) } : { documentId: String(id).trim() },
          populate: {
            user: {
              select: ["id", "email"],
            },
          },
        });

        if (!existing) {
          existing = await strapi.entityService.findOne(
            CLUB_OWNER_UID,
            id,
            { populate: ["user"] },
          );
        }

        if (!existing) {
          return ctx.notFound("Club owner not found");
        }

        // Ownership check: Club owner can only update their own profile, Admin/SuperAdmin can update all
        let userClubOwner: any = null;

        if (roleName === "clubowner") {
          userClubOwner = await getClubOwnerForUser(user);

          if (!userClubOwner) {
            return ctx.forbidden("Club owner profile not found for this account");
          }

          const isOwnerMatch =
            (existing.documentId && userClubOwner.documentId && String(existing.documentId) === String(userClubOwner.documentId)) ||
            (existing.id && userClubOwner.id && String(existing.id) === String(userClubOwner.id)) ||
            (existing.user?.id && user.id && String(existing.user.id) === String(user.id));

          if (!isOwnerMatch) {
            return ctx.forbidden("Access denied. You can only update your own club profile.");
          }
        } else if (isAdmin) {
          // Admin / SuperAdmin can update all club profiles without restriction
        } else {
          // Fallback: check if authenticated user is the owner of this club profile
          userClubOwner = await getClubOwnerForUser(user);

          const isOwnerMatch =
            (userClubOwner && (
              (existing.documentId && userClubOwner.documentId && String(existing.documentId) === String(userClubOwner.documentId)) ||
              (existing.id && userClubOwner.id && String(existing.id) === String(userClubOwner.id))
            )) ||
            (existing.user?.id && user.id && String(existing.user.id) === String(user.id));

          if (!isOwnerMatch) {
            return ctx.forbidden("Access denied. Only ClubOwner, Admin, or SuperAdmin can update club profiles.");
          }
        }

        const updateData = { ...data };

        if (updateData.weekdayScheduling !== undefined) {
          updateData.weekdayScheduling = orderWeekdayScheduling(
            normalizeWeekdayScheduling(updateData.weekdayScheduling),
          );
        }

        if (
          updateData.services !== undefined ||
          updateData.club_services !== undefined
        ) {
          const serviceIds = await resolveClubServiceIds(
            updateData.club_services !== undefined
              ? updateData.club_services
              : updateData.services,
          );
          updateData.club_services = serviceIds;
        }

        if (
          updateData.facilities !== undefined ||
          updateData.club_facilities !== undefined
        ) {
          const facilityIds = await resolveClubFacilityIds(
            updateData.club_facilities !== undefined
              ? updateData.club_facilities
              : updateData.facilities,
          );
          updateData.club_facilities = facilityIds;
        }

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(CLUB_OWNER_UID).update({
              documentId: existing.documentId,
              data: updateData,
            });
          } catch (docErr) {
            strapi.log.warn("documents.update fallback in club-owner update:", docErr);
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(CLUB_OWNER_UID, existing.id || id, {
            data: updateData,
          });
        }

        const entity: any = await strapi.entityService.findOne(
          CLUB_OWNER_UID,
          existing.id || id,
          { populate: POPULATE },
        );

        if (entity && entity.weekdayScheduling) {
          entity.weekdayScheduling = orderWeekdayScheduling(
            entity.weekdayScheduling,
          );
        }

        const updatedFields: any = {};
        for (const key of Object.keys(data)) {
          if (entity && key in entity) {
            updatedFields[key] = entity[key];
          } else if (key in updateData) {
            updatedFields[key] = updateData[key];
          }
        }

        // 📝 Log Activity (only for club owners, NOT admin or superadmin)
        if (!isAdmin && (userClubOwner || roleName === "clubowner")) {
          const ownerForLog = userClubOwner || (await getClubOwnerForUser(user));
          const targetOwnerId =
            ownerForLog?.documentId ||
            ownerForLog?.id ||
            existing?.documentId ||
            existing?.id ||
            id;

          if (targetOwnerId) {
            try {
              const activityLogService: any = strapi.service(
                "api::club-owner-activity-log.club-owner-activity-log",
              );
              if (activityLogService?.logActivity) {
                const changedDetails: string[] = [];

                const simpleFields = [
                  { key: "clubName", label: "clubName" },
                  { key: "ownerName", label: "ownerName" },
                  { key: "phoneNumber", label: "phoneNumber" },
                  { key: "email", label: "email" },
                  { key: "clubAddress", label: "clubAddress" },
                  { key: "city", label: "city" },
                  { key: "state", label: "state" },
                  { key: "pincode", label: "pincode" },
                  { key: "clubCategory", label: "clubCategory" },
                ];

                for (const field of simpleFields) {
                  if (
                    data[field.key] !== undefined &&
                    String(data[field.key]) !== String(existing[field.key] ?? "")
                  ) {
                    changedDetails.push(
                      `${field.label}: '${existing[field.key] ?? ""}' -> '${
                        data[field.key]
                      }'`,
                    );
                  }
                }

                if (data.weekdayScheduling !== undefined) {
                  changedDetails.push("weekdayScheduling");
                }
                if (
                  data.facilities !== undefined ||
                  data.club_facilities !== undefined
                ) {
                  changedDetails.push("facilities");
                }
                if (
                  data.services !== undefined ||
                  data.club_services !== undefined
                ) {
                  changedDetails.push("services");
                }
                if (data.logo !== undefined) {
                  changedDetails.push("logo");
                }
                if (
                  (data.latitude !== undefined &&
                    String(data.latitude) !== String(existing.latitude ?? "")) ||
                  (data.longitude !== undefined &&
                    String(data.longitude) !== String(existing.longitude ?? ""))
                ) {
                  changedDetails.push("location (lat/long)");
                }

                const handledKeys = new Set([
                  "clubName",
                  "ownerName",
                  "phoneNumber",
                  "email",
                  "clubAddress",
                  "city",
                  "state",
                  "pincode",
                  "weekdayScheduling",
                  "facilities",
                  "services",
                  "logo",
                  "latitude",
                  "longitude",
                ]);

                for (const key of Object.keys(data)) {
                  if (!handledKeys.has(key) && data[key] !== undefined) {
                    changedDetails.push(key);
                  }
                }

                const changeSummary =
                  changedDetails.length > 0
                    ? ` (Changed: ${changedDetails.join(", ")})`
                    : "";

                await activityLogService.logActivity({
                  clubOwnerId: targetOwnerId,
                  category: "profile",
                  actionType: "UPDATE",
                  entityName: "Club Profile",
                  entityId: targetOwnerId,
                  description: `Updated club profile details for ${
                    entity?.clubName || existing?.clubName || "club"
                  }${changeSummary}`,
                });
              }
            } catch (logErr) {
              strapi.log.warn("[ActivityLog] Failed to log club update:", logErr);
            }
          }
        }

        ctx.body = updatedFields;
      } catch (err) {
        strapi.log.error("UPDATE CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to update club owner");
      }
    },

    /* =======================================================
       DELETE CLUB OWNER
    ======================================================= */
    async delete(ctx: Context) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can delete club owners.",
          );
        }

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        const entity: any = await strapi.entityService.findOne(
          CLUB_OWNER_UID,
          id,
          { populate: POPULATE },
        );

        if (!entity) return ctx.notFound("Club owner not found");

        if ((strapi as any).documents && entity.documentId) {
          await (strapi as any).documents(CLUB_OWNER_UID).delete({
            documentId: entity.documentId,
          });
        } else {
          await strapi.entityService.delete(CLUB_OWNER_UID, entity.id || id);
        }

        ctx.body = {
          success: true,
          deleted: entity,
        };
      } catch (err) {
        strapi.log.error("DELETE CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to delete club owner");
      }
    },

    /* =======================================================
       GET LOGGED-IN CLUB OWNER
    ======================================================= */
    async getMyClubOwner(ctx: Context) {
      try {
        /* GET USER FROM JWT TOKEN */
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        /* FIND CLUB OWNER OF THIS USER */
        const clubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: { user: user.id },
            populate: {
              user: true,
              logo: true,
              club_photos: {
                populate: ["images"],
              },
              club_owner_documents: true,
            },
          });

        if (!clubOwner) {
          return ctx.notFound("Club owner not found");
        }

        if (clubOwner.weekdayScheduling) {
          clubOwner.weekdayScheduling = orderWeekdayScheduling(
            clubOwner.weekdayScheduling,
          );
        }

        ctx.body = clubOwner;
      } catch (error) {
        strapi.log.error("GET MY CLUB OWNER ERROR:", error);
        return ctx.internalServerError("Something went wrong");
      }
    },

    /* =======================================================
       MARK CLUB OWNER REQUEST AS READ BY ADMIN
    ======================================================= */
    async markClubRead(ctx: Context) {
      try {
        const admin = ctx.state.user;
        const { id } = ctx.params;

        if (!admin) {
          return ctx.unauthorized("Admin authentication required");
        }

        if (!id) {
          return ctx.badRequest("Club ID is required");
        }

        const club = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: { id },
            select: ["id", "read_by_admins"],
          });

        if (!club) {
          return ctx.notFound("Club request not found");
        }

        let readers = Array.isArray(club.read_by_admins)
          ? [...club.read_by_admins]
          : [];

        if (!readers.includes(admin.id)) {
          readers.push(admin.id);

          await strapi.db.query("api::club-owner.club-owner").update({
            where: { id },
            data: {
              read_by_admins: readers,
            },
          });
        }

        return ctx.send({
          success: true,
          message: "Club request marked as read",
        });
      } catch (error) {
        strapi.log.error("CLUB READ ERROR:", error);
        return ctx.internalServerError("Something went wrong");
      }
    },

    /* =======================================================
       TODAY'S / FILTERED CHECK INS (FOR CLUB OWNER)
       Route: GET /api/club-owners/today-checkins
    ======================================================= */
    async todayCheckins(ctx) {
      try {
        const user = ctx.state.user;

        // 1. Make sure the user is logged in
        if (!user) {
          return ctx.unauthorized("You must be logged in");
        }

        // 2. Find the club owner associated with the logged-in user
        const clubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: {
              user: user.id,
            },
          });

        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found for this user");
        }

        const {
          startDate,
          endDate,
          from,
          to,
          start_date,
          end_date,
          date,
          clientId,
          client_id,
          client,
          clientName,
          client_name,
          name,
          search,
          q,
          subscriptionType,
        } = ctx.query as any;

        const where: any = {
          club_owner: clubOwner.id,
        };

        // 3. Date range: custom range if passed, otherwise defaults to Today
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
            }
          }
        } else {
          // Default to today's date range
          const now = new Date();
          const startOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0,
            0,
          );
          const endOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            23,
            59,
            59,
            999,
          );
          where.checkinTime = {
            $gte: startOfDay,
            $lte: endOfDay,
          };
        }

        // 4. Client filter by clientId or clientName / name / search (handles uppercase, lowercase, and partials)
        const targetClientId = clientId || client_id || client;
        const targetClientName =
          clientName || client_name || name || search || q;

        if (targetClientId || targetClientName) {
          const clientWhere: any = {};

          if (targetClientId && !targetClientName) {
            const rawId = String(targetClientId).trim();
            const isNum = !isNaN(Number(rawId)) && /^\d+$/.test(rawId);
            const idConditions: any[] = [
              { clientId: { $containsi: rawId } },
              { clientId: rawId.toUpperCase() },
              { clientId: rawId.toLowerCase() },
              { documentId: rawId },
            ];
            if (isNum) {
              idConditions.push({ id: Number(rawId) });
            }
            clientWhere.$or = idConditions;
          } else if (targetClientName && !targetClientId) {
            const trimmedName = String(targetClientName).trim();
            const words = trimmedName.split(/\s+/).filter(Boolean);

            if (words.length > 1) {
              clientWhere.$and = words.map((w: string) => ({
                $or: [
                  { name: { $containsi: w } },
                  { name: { $containsi: w.toLowerCase() } },
                  { name: { $containsi: w.toUpperCase() } },
                ],
              }));
            } else {
              clientWhere.$or = [
                { name: { $containsi: trimmedName } },
                { name: { $containsi: trimmedName.toLowerCase() } },
                { name: { $containsi: trimmedName.toUpperCase() } },
              ];
            }
          } else if (targetClientId && targetClientName) {
            const rawId = String(targetClientId).trim();
            const isNum = !isNaN(Number(rawId)) && /^\d+$/.test(rawId);
            const idConditions: any[] = [
              { clientId: { $containsi: rawId } },
              { clientId: rawId.toUpperCase() },
              { clientId: rawId.toLowerCase() },
              { documentId: rawId },
            ];
            if (isNum) {
              idConditions.push({ id: Number(rawId) });
            }

            const trimmedName = String(targetClientName).trim();
            const words = trimmedName.split(/\s+/).filter(Boolean);
            const nameCondition =
              words.length > 1
                ? {
                    $and: words.map((w: string) => ({
                      $or: [
                        { name: { $containsi: w } },
                        { name: { $containsi: w.toLowerCase() } },
                        { name: { $containsi: w.toUpperCase() } },
                      ],
                    })),
                  }
                : {
                    $or: [
                      { name: { $containsi: trimmedName } },
                      { name: { $containsi: trimmedName.toLowerCase() } },
                      { name: { $containsi: trimmedName.toUpperCase() } },
                    ],
                  };

            clientWhere.$and = [{ $or: idConditions }, nameCondition];
          }

          const matchedClients = await strapi.db
            .query("api::client-detail.client-detail")
            .findMany({
              where: clientWhere,
              select: ["id"],
            });

          if (!matchedClients || matchedClients.length === 0) {
            return ctx.send({ data: [] });
          }

          const clientIds = matchedClients.map((c: any) => c.id);
          where.client_detail =
            clientIds.length === 1 ? clientIds[0] : { $in: clientIds };
        }

        // 5. Subscription type filter (optional)
        if (
          subscriptionType &&
          ["local", "outdoor"].includes(
            String(subscriptionType).toLowerCase().trim(),
          )
        ) {
          where.subscriptionType = String(subscriptionType).toLowerCase().trim();
        }

        // 6. Fetch check-ins
        const checkins = await strapi.db
          .query("api::client-checkin.client-checkin")
          .findMany({
            where,
            populate: {
              client_detail: {
                select: [
                  "id",
                  "documentId",
                  "clientId",
                  "name",
                  "phoneNumber",
                  "email",
                  "gender",
                ],
                populate: {
                  selfieUpload: {
                    select: ["id", "url", "name", "formats"],
                  },
                },
              },
            },
            orderBy: {
              checkinTime: "desc",
            },
          });

        // 7. Format response
        const data = (Array.isArray(checkins) ? checkins : []).map(
          (checkin: any) => ({
            id: checkin.id,
            documentId: checkin.documentId,
            clientId: checkin.client_detail?.clientId || null,
            clientName: checkin.client_detail?.name || null,
            selfieUploadUrl: checkin.client_detail?.selfieUpload?.url || null,
            checkinTime: checkin.checkinTime,
            subscriptionType: checkin.subscriptionType,
          }),
        );

        return ctx.send({
          data,
        });
      } catch (error) {
        strapi.log.error("Error fetching today's check-ins:", error);

        return ctx.internalServerError("Unable to fetch check-ins");
      }
    },

  }),
);
