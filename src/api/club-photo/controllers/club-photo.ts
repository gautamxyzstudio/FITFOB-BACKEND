import { factories } from "@strapi/strapi";
import { Context } from "koa";

const CLUB_PHOTO_UID = "api::club-photo.club-photo" as any;
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
  if (!user) {
    console.log("❌ [getClubOwnerForUser] No user object passed");
    return null;
  }
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  console.log(
    "🔍 [getClubOwnerForUser] Finding club owner for userId:",
    userId,
  );

  if (userObj?._cachedClubOwner) {
    console.log("⚡ [getClubOwnerForUser] Returning cached club owner");
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
    console.log(
      "⚠️ [getClubOwnerForUser] Direct query returned null, checking user relation table...",
    );
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

  console.log(
    "✅ [getClubOwnerForUser] Found owner:",
    owner
      ? { id: owner.id, documentId: owner.documentId, clubName: owner.clubName }
      : "NULL",
  );

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- BODY PARSER ---------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try {
      body = JSON.parse(body.data);
    } catch {}
  }
  return body;
}

/* ---------- MULTI FILE UPLOAD HELPER ---------- */
async function uploadToFolder(file: any) {
  const uploadService = strapi.plugin("upload").service("upload");
  const filesArray = Array.isArray(file) ? file : [file];
  const uploadedFiles: any[] = [];

  for (const f of filesArray) {
    try {
      const res = await uploadService.upload({
        data: { fileInfo: { folder: 2 } },
        files: f,
      });
      uploadedFiles.push(...res);
    } catch (_) {
      const res = await uploadService.upload({
        data: {},
        files: f,
      });
      uploadedFiles.push(...res);
    }
  }
  return uploadedFiles;
}

export default factories.createCoreController(
  "api::club-photo.club-photo",
  ({ strapi }) => ({
    /* =======================================================
       1. UPLOAD CLUB PHOTO (WITH DESCRIPTION / IMAGE INFO)
    ======================================================= */
    async create(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";
        const body = getBody(ctx);
        let targetOwner: any = null;

        if (roleName === "clubowner") {
          targetOwner = await getClubOwnerForUser(user);
          if (!targetOwner) {
            return ctx.notFound("Club owner profile not found for this user");
          }
        } else if (isAdmin) {
          const rawOwner = body.club_owner || ctx.query.club_owner;
          if (rawOwner) {
            const isNumeric =
              !isNaN(Number(rawOwner)) && /^\d+$/.test(String(rawOwner));
            targetOwner = await strapi.db.query(CLUB_OWNER_UID).findOne({
              where: isNumeric
                ? { id: Number(rawOwner) }
                : { documentId: String(rawOwner).trim() },
              select: ["id", "documentId", "clubName"],
            });
            if (!targetOwner) {
              return ctx.notFound(`Club owner '${rawOwner}' not found`);
            }
          } else {
            targetOwner = await getClubOwnerForUser(user);
            if (!targetOwner) {
              return ctx.badRequest(
                "club_owner documentId or id is required when uploading photos as Admin",
              );
            }
          }
        } else {
          // Fallback: check if authenticated user has a linked club owner profile
          targetOwner = await getClubOwnerForUser(user);
          if (!targetOwner) {
            return ctx.forbidden(
              "Access denied. Only ClubOwner, Admin, or SuperAdmin can upload club photos.",
            );
          }
        }
        const files: any = ctx.request.files;

        const photoFile =
          files?.image ||
          files?.images ||
          files?.club_photos ||
          files?.clubPhotos ||
          files?.file ||
          files?.photo;

        if (!photoFile) {
          return ctx.badRequest("Please upload a photo file");
        }

        const imageInfo = body.imageInfo || body.description || "";
        const uploadedPhotos = await uploadToFolder(photoFile);
        const photoIds = uploadedPhotos.map((f: any) => f.id);

        let createdPhoto: any = null;

        if ((strapi as any).documents && targetOwner.documentId) {
          try {
            createdPhoto = await (strapi as any)
              .documents(CLUB_PHOTO_UID)
              .create({
                data: {
                  imageInfo: imageInfo.trim(),
                  images: photoIds,
                  club_owner: targetOwner.documentId,
                },
                populate: ["images"],
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create fallback in photo upload:",
              docErr,
            );
          }
        }

        if (!createdPhoto) {
          createdPhoto = await strapi.entityService.create(CLUB_PHOTO_UID, {
            data: {
              imageInfo: imageInfo.trim(),
              images: photoIds,
              club_owner: targetOwner.documentId || targetOwner.id,
            },
            populate: ["images"],
          });
        }

        // 📝 Log Activity (Profile Update - only for club owners, NOT admin)
        if (!isAdmin && targetOwner) {
          try {
            const activityLogService: any = strapi.service(
              "api::club-owner-activity-log.club-owner-activity-log",
            );
            if (activityLogService?.logActivity) {
              const targetOwnerId = targetOwner.documentId || targetOwner.id;
              await activityLogService.logActivity({
                clubOwnerId: targetOwnerId,
                category: "profile",
                actionType: "UPDATE",
                entityName: "Club Profile",
                entityId: targetOwnerId,
                description: `Updated club profile: Added club photo${
                  imageInfo.trim() ? `: '${imageInfo.trim()}'` : ""
                }`,
              });
            }
          } catch (logErr) {
            strapi.log.warn(
              "[ActivityLog] Failed to log photo upload:",
              logErr,
            );
          }
        }

        const firstImage = createdPhoto.images?.[0];
        const fileUrl = firstImage?.url
          ? firstImage.url.startsWith("http")
            ? firstImage.url
            : `${strapi.config.server.url}${firstImage.url}`
          : null;

        return ctx.send(
          {
            message: "Club photo uploaded successfully",
            data: {
              id: createdPhoto.id,
              documentId: createdPhoto.documentId,
              imageInfo: createdPhoto.imageInfo,
              fileUrl,
            },
          },
          201,
        );
      } catch (error) {
        strapi.log.error("UPLOAD CLUB PHOTO ERROR:", error);
        return ctx.internalServerError("Failed to upload club photo");
      }
    },

    /* =======================================================
       2. GET MY CLUB PHOTOS (STRICTLY LOGGED-IN CLUB OWNER)
    ======================================================= */
    async getMyPhotos(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const owner = await getClubOwnerForUser(user);
        if (!owner) {
          return ctx.notFound("Club owner profile not found for this user");
        }

        const photos: any[] = await strapi.db.query(CLUB_PHOTO_UID).findMany({
          where: {
            club_owner: owner.id,
          },
          populate: {
            images: true,
            club_owner: {
              select: ["id", "documentId", "clubName", "clubId"],
            },
          },
          orderBy: { id: "desc" },
        });

        const formatted = (photos || []).map((p: any) => {
          const firstImage = p.images?.[0];
          const fileUrl = firstImage?.url
            ? firstImage.url.startsWith("http")
              ? firstImage.url
              : `${strapi.config.server.url}${firstImage.url}`
            : null;

          return {
            id: p.id,
            documentId: p.documentId,
            imageInfo: p.imageInfo,
            fileUrl,
            createdAt: p.createdAt,
          };
        });

        return ctx.send({
          data: formatted,
        });
      } catch (error) {
        strapi.log.error("GET MY CLUB PHOTOS ERROR:", error);
        return ctx.internalServerError("Failed to fetch club photos");
      }
    },

    /* =======================================================
       FIND PHOTOS (BY OWNER DOCUMENTID OR ALL IF NONE PASSED)
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const rawOwner =
          ctx.query.documentId ||
          ctx.query.club_owner ||
          ctx.query.clubOwner ||
          ctx.query.ownerId ||
          ctx.query.clubId;

        const whereClause: any = {};

        if (rawOwner) {
          const isNumeric =
            !isNaN(Number(rawOwner)) && /^\d+$/.test(String(rawOwner));
          const targetOwner = await strapi.db.query(CLUB_OWNER_UID).findOne({
            where: isNumeric
              ? { id: Number(rawOwner) }
              : {
                  $or: [
                    { documentId: String(rawOwner).trim() },
                    { clubId: String(rawOwner).trim() },
                  ],
                },
            select: ["id", "documentId", "clubName", "clubId"],
          });
          if (!targetOwner) {
            return ctx.notFound(`Club owner '${rawOwner}' not found`);
          }
          whereClause.club_owner = targetOwner.id;
        }

        const photos: any[] = await strapi.db.query(CLUB_PHOTO_UID).findMany({
          where: whereClause,
          populate: {
            images: true,
            club_owner: {
              select: ["id", "documentId", "clubName", "clubId"],
            },
          },
          orderBy: { id: "desc" },
        });

        const formatted = (photos || []).map((p: any) => {
          const firstImage = p.images?.[0];
          const fileUrl = firstImage?.url
            ? firstImage.url.startsWith("http")
              ? firstImage.url
              : `${strapi.config.server.url}${firstImage.url}`
            : null;

          return {
            id: p.id,
            documentId: p.documentId,
            imageInfo: p.imageInfo,
            fileUrl,
            club_owner: p.club_owner
              ? {
                  id: p.club_owner.id,
                  documentId: p.club_owner.documentId,
                  clubName: p.club_owner.clubName,
                  clubId: p.club_owner.clubId,
                }
              : undefined,
            createdAt: p.createdAt,
          };
        });

        return ctx.send({
          total: formatted.length,
          data: formatted,
        });
      } catch (error) {
        strapi.log.error("FIND CLUB PHOTOS ERROR:", error);
        return ctx.internalServerError("Failed to fetch club photos");
      }
    },

    /* =======================================================
       3. UPDATE CLUB PHOTO (DESCRIPTION OR IMAGE)
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
        const documentId = String(id).trim();
        const isNumeric =
          !isNaN(Number(documentId)) && /^\d+$/.test(documentId);

        let existing: any = null;
        if ((strapi as any).documents && !isNumeric) {
          try {
            existing = await (strapi as any).documents(CLUB_PHOTO_UID).findOne({
              documentId,
              populate: ["club_owner"],
            });
          } catch (_) {}
        }

        if (!existing) {
          existing = await strapi.db.query(CLUB_PHOTO_UID).findOne({
            where: isNumeric ? { id: Number(documentId) } : { documentId },
            populate: ["club_owner"],
          });
        }

        if (!existing) {
          return ctx.notFound("Club photo not found");
        }

        let ownerRecord: any = null;
        if (!isAdmin) {
          ownerRecord = await getClubOwnerForUser(user);
          if (!ownerRecord) {
            return ctx.forbidden(
              "Access denied. Only ClubOwner, Admin, or SuperAdmin can update club photos.",
            );
          }

          const existingOwnerDocId =
            existing.club_owner?.documentId ||
            (typeof existing.club_owner === "string"
              ? existing.club_owner
              : null);
          const existingOwnerId =
            existing.club_owner?.id ||
            (typeof existing.club_owner === "number"
              ? existing.club_owner
              : null);

          if (
            (existingOwnerDocId &&
              existingOwnerDocId !== ownerRecord.documentId) ||
            (existingOwnerId && existingOwnerId !== ownerRecord.id)
          ) {
            return ctx.forbidden(
              "You are not authorized to update photos belonging to another club",
            );
          }
        }

        const body = getBody(ctx);
        const files: any = ctx.request.files;
        const updateData: any = {};

        if (body.imageInfo !== undefined || body.description !== undefined) {
          updateData.imageInfo = (
            body.imageInfo !== undefined ? body.imageInfo : body.description
          )?.trim();
        }

        const photoFile =
          files?.image ||
          files?.images ||
          files?.club_photos ||
          files?.clubPhotos ||
          files?.file ||
          files?.photo;

        if (photoFile) {
          const uploadedPhotos = await uploadToFolder(photoFile);
          const photoIds = uploadedPhotos.map((f: any) => f.id);
          if (photoIds.length > 0) {
            updateData.images = photoIds;
          }
        }

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(CLUB_PHOTO_UID).update({
              documentId: existing.documentId,
              data: updateData,
              populate: ["images"],
            });
          } catch (docErr) {
            strapi.log.warn(
              "documents.update fallback in photo update:",
              docErr,
            );
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            CLUB_PHOTO_UID,
            existing.id,
            {
              data: updateData,
              populate: ["images"],
            },
          );
        }

        // 📝 Log Activity (only for club owners, NOT admin)
        if (!isAdmin && (ownerRecord || roleName === "clubowner")) {
          const ownerForLog = ownerRecord || (await getClubOwnerForUser(user));
          const targetOwnerId =
            ownerForLog?.documentId ||
            ownerForLog?.id ||
            existing.club_owner?.documentId ||
            existing.club_owner?.id;

          if (targetOwnerId) {
            try {
              const activityLogService: any = strapi.service(
                "api::club-owner-activity-log.club-owner-activity-log",
              );
              if (activityLogService?.logActivity) {
                const changedParts: string[] = [];
                if (
                  updateData.imageInfo !== undefined &&
                  updateData.imageInfo !== existing.imageInfo
                ) {
                  changedParts.push(
                    `imageInfo: '${existing.imageInfo ?? ""}' -> '${
                      updateData.imageInfo
                    }'`,
                  );
                }
                if (updateData.images) {
                  changedParts.push("replaced image file");
                }

                const changeSummary =
                  changedParts.length > 0
                    ? ` (Changed: ${changedParts.join(", ")})`
                    : "";

                await activityLogService.logActivity({
                  clubOwnerId: targetOwnerId,
                  category: "profile",
                  actionType: "UPDATE",
                  entityName: "Club Profile",
                  entityId: targetOwnerId,
                  description: `Updated club profile: Updated club photo${
                    existing.imageInfo ? `: '${existing.imageInfo}'` : ""
                  }${changeSummary}`,
                });
              }
            } catch (logErr) {
              strapi.log.warn(
                "[ActivityLog] Failed to log photo update:",
                logErr,
              );
            }
          }
        }

        const firstImage = updated.images?.[0];
        const fileUrl = firstImage?.url
          ? firstImage.url.startsWith("http")
            ? firstImage.url
            : `${strapi.config.server.url}${firstImage.url}`
          : null;

        return ctx.send({
          message: "Club photo updated successfully",
          data: {
            id: updated.id,
            documentId: updated.documentId,
            imageInfo: updated.imageInfo,
            fileUrl,
          },
        });
      } catch (error) {
        strapi.log.error("UPDATE CLUB PHOTO ERROR:", error);
        return ctx.internalServerError("Failed to update club photo");
      }
    },

    /* =======================================================
       4. DELETE CLUB PHOTO
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
        const documentId = String(id).trim();
        const isNumeric =
          !isNaN(Number(documentId)) && /^\d+$/.test(documentId);

        let existing: any = null;
        if ((strapi as any).documents && !isNumeric) {
          try {
            existing = await (strapi as any).documents(CLUB_PHOTO_UID).findOne({
              documentId,
              populate: ["club_owner"],
            });
          } catch (_) {}
        }

        if (!existing) {
          existing = await strapi.db.query(CLUB_PHOTO_UID).findOne({
            where: isNumeric ? { id: Number(documentId) } : { documentId },
            populate: ["club_owner"],
          });
        }

        if (!existing) {
          return ctx.notFound("Club photo not found");
        }

        let ownerRecord: any = null;
        if (!isAdmin) {
          ownerRecord = await getClubOwnerForUser(user);
          if (!ownerRecord) {
            return ctx.forbidden(
              "Access denied. Only ClubOwner, Admin, or SuperAdmin can delete club photos.",
            );
          }

          const existingOwnerDocId =
            existing.club_owner?.documentId ||
            (typeof existing.club_owner === "string"
              ? existing.club_owner
              : null);
          const existingOwnerId =
            existing.club_owner?.id ||
            (typeof existing.club_owner === "number"
              ? existing.club_owner
              : null);

          if (
            (existingOwnerDocId &&
              existingOwnerDocId !== ownerRecord.documentId) ||
            (existingOwnerId && existingOwnerId !== ownerRecord.id)
          ) {
            return ctx.forbidden(
              "You are not authorized to delete photos belonging to another club",
            );
          }
        }

        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(CLUB_PHOTO_UID).delete({
            documentId: existing.documentId,
          });
        } else {
          await strapi.entityService.delete(CLUB_PHOTO_UID, existing.id);
        }

        // 📝 Log Activity (only for club owners, NOT admin)
        if (!isAdmin && (ownerRecord || roleName === "clubowner")) {
          const ownerForLog = ownerRecord || (await getClubOwnerForUser(user));
          const targetOwnerId =
            ownerForLog?.documentId ||
            ownerForLog?.id ||
            existing.club_owner?.documentId ||
            existing.club_owner?.id;

          if (targetOwnerId) {
            try {
              const activityLogService: any = strapi.service(
                "api::club-owner-activity-log.club-owner-activity-log",
              );
              if (activityLogService?.logActivity) {
                await activityLogService.logActivity({
                  clubOwnerId: targetOwnerId,
                  category: "profile",
                  actionType: "UPDATE",
                  entityName: "Club Profile",
                  entityId: targetOwnerId,
                  description: `Updated club profile: Deleted club photo${
                    existing.imageInfo ? `: '${existing.imageInfo}'` : ""
                  }`,
                });
              }
            } catch (logErr) {
              strapi.log.warn(
                "[ActivityLog] Failed to log photo delete:",
                logErr,
              );
            }
          }
        }

        return ctx.send({
          message: "Club photo deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE CLUB PHOTO ERROR:", error);
        return ctx.internalServerError("Failed to delete club photo");
      }
    },
  }),
);
