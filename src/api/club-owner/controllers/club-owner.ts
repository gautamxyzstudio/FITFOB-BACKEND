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
const HOLDIDAY_UID = "api::holdiday.holdiday" as any;

/* ---------- HELPER: GET TODAY DATE (YYYY-MM-DD) ---------- */
function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

/* ---------- HAVERSINE DISTANCE HELPER ---------- */
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's radius in kilometers
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ---------- MEDIA URL FORMATTER ---------- */
function formatMediaUrl(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith("http")
    ? url
    : `${strapi.config.server.url || ""}${url}`;
}

/* ---------- EXTRACT FLAT STRING LIST (SERVICES / FACILITIES) ---------- */
function extractStringList(jsonField: any, relationItems: any[]): string[] {
  const result: string[] = [];

  // From relation entities (e.g. { name: "Gym" })
  if (Array.isArray(relationItems)) {
    for (const item of relationItems) {
      if (typeof item === "string" && item.trim()) {
        result.push(item.trim());
      } else if (
        item?.name &&
        typeof item.name === "string" &&
        item.name.trim()
      ) {
        result.push(item.name.trim());
      }
    }
  }

  // From JSON array or string
  if (jsonField) {
    let parsed = jsonField;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = parsed.split(",").map((s: string) => s.trim());
      }
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          result.push(item.trim());
        } else if (typeof item === "object" && item !== null) {
          const name =
            item.name || item.serviceName || item.facilityName || item.title;
          if (name && typeof name === "string" && name.trim()) {
            result.push(name.trim());
          }
        }
      }
    }
  }

  return Array.from(new Set(result));
}

/* ---------- RESOLVE CLIENT FAVORITES HELPER ---------- */
async function resolveClientFavorites(ctx: Context): Promise<any[]> {
  try {
    let user = ctx.state?.user;

    // 1. Fallback: If ctx.state.user is not yet populated but Bearer token is provided
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
                select: ["id"],
              });
          }
        }
      } catch (_) {}
    }

    const {
      clientId,
      client_id,
      clientDetailId,
      client_detail_id,
      userId,
      user_id,
    } = (ctx.query || {}) as any;

    const targetClientId = clientId || client_id || ctx.get?.("x-client-id");
    const targetClientDetailId =
      clientDetailId || client_detail_id || ctx.get?.("x-client-detail-id");
    const targetUserId = userId || user_id || ctx.get?.("x-user-id");

    let clientDetail: any = null;

    // A. Find by logged-in user
    if (user?.id) {
      clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          select: ["id", "documentId"],
          populate: {
            favorites: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });
    }

    // B. Find by clientDetailId / documentId
    if (!clientDetail && targetClientDetailId) {
      const detailStr = String(targetClientDetailId).trim();
      const isNum = !isNaN(Number(detailStr)) && /^\d+$/.test(detailStr);
      clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: isNum
            ? {
                $or: [
                  { id: Number(detailStr) },
                  { documentId: detailStr },
                ],
              }
            : { documentId: detailStr },
          select: ["id", "documentId"],
          populate: {
            favorites: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });
    }

    // C. Find by clientId (e.g., "CL-00123" or id)
    if (!clientDetail && targetClientId) {
      const rawCId = String(targetClientId).trim();
      const isNum = !isNaN(Number(rawCId)) && /^\d+$/.test(rawCId);
      const orConditions: any[] = [
        { clientId: rawCId },
        { clientId: rawCId.toUpperCase() },
        { clientId: rawCId.toLowerCase() },
        { documentId: rawCId },
      ];
      if (isNum) {
        orConditions.push({ id: Number(rawCId) });
      }

      clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { $or: orConditions },
          select: ["id", "documentId"],
          populate: {
            favorites: {
              select: ["id", "documentId", "clubId"],
            },
          },
        });
    }

    // D. Find by userId param
    if (!clientDetail && targetUserId) {
      const rawUId = String(targetUserId).trim();
      if (!isNaN(Number(rawUId)) && /^\d+$/.test(rawUId)) {
        clientDetail = await strapi.db
          .query("api::client-detail.client-detail")
          .findOne({
            where: { user: Number(rawUId) },
            select: ["id", "documentId"],
            populate: {
              favorites: {
                select: ["id", "documentId", "clubId"],
              },
            },
          });
      }
    }

    if (clientDetail && Array.isArray(clientDetail.favorites)) {
      return clientDetail.favorites;
    }

    return [];
  } catch (err) {
    strapi.log.warn("[resolveClientFavorites] Error resolving favorites:", err);
    return [];
  }
}

/* ---------- DIRECT POSTGRES FAVORITE CHECK HELPER ---------- */
async function checkIsClubFavoritedDirect(
  ctx: Context,
  clubOwnerId: number,
): Promise<boolean> {
  try {
    let userId: any = ctx.state?.user?.id;

    if (!userId && ctx.request?.header?.authorization?.startsWith("Bearer ")) {
      const token = ctx.request.header.authorization.slice(7).trim();
      try {
        const jwtService = strapi.plugin("users-permissions")?.service("jwt");
        if (jwtService?.verify) {
          const payload = await jwtService.verify(token);
          if (payload?.id) {
            userId = payload.id;
          }
        }
      } catch (_) {}
    }

    const {
      clientId,
      client_id,
      clientDetailId,
      client_detail_id,
      userId: qUserId,
      user_id,
    } = (ctx.query || {}) as any;

    const targetClientId = clientId || client_id || ctx.get?.("x-client-id");
    const targetClientDetailId =
      clientDetailId || client_detail_id || ctx.get?.("x-client-detail-id");
    const targetUserId = qUserId || user_id || ctx.get?.("x-user-id") || userId;

    let clientDetailIdNum: number | null = null;

    if (targetClientDetailId) {
      const detailStr = String(targetClientDetailId).trim();
      const isNum = !isNaN(Number(detailStr)) && /^\d+$/.test(detailStr);
      const res = await strapi.db.connection.raw(
        isNum
          ? `SELECT id FROM client_details WHERE id = ? OR document_id = ? LIMIT 1`
          : `SELECT id FROM client_details WHERE document_id = ? LIMIT 1`,
        isNum ? [Number(detailStr), detailStr] : [detailStr],
      );
      if (res?.rows?.[0]?.id) {
        clientDetailIdNum = res.rows[0].id;
      }
    }

    if (!clientDetailIdNum && targetUserId) {
      const uStr = String(targetUserId).trim();
      if (!isNaN(Number(uStr)) && /^\d+$/.test(uStr)) {
        const res = await strapi.db.connection.raw(
          `SELECT client_detail_id FROM up_users_client_detail_lnk WHERE user_id = ? LIMIT 1`,
          [Number(uStr)],
        );
        if (res?.rows?.[0]?.client_detail_id) {
          clientDetailIdNum = res.rows[0].client_detail_id;
        }
      }
    }

    if (!clientDetailIdNum && targetClientId) {
      const cStr = String(targetClientId).trim();
      const isNum = !isNaN(Number(cStr)) && /^\d+$/.test(cStr);
      const res = await strapi.db.connection.raw(
        isNum
          ? `SELECT id FROM client_details WHERE LOWER(client_id) = LOWER(?) OR document_id = ? OR id = ? LIMIT 1`
          : `SELECT id FROM client_details WHERE LOWER(client_id) = LOWER(?) OR document_id = ? LIMIT 1`,
        isNum ? [cStr, cStr, Number(cStr)] : [cStr, cStr],
      );
      if (res?.rows?.[0]?.id) {
        clientDetailIdNum = res.rows[0].id;
      }
    }

    if (clientDetailIdNum) {
      const favRes = await strapi.db.connection.raw(
        `SELECT 1 FROM client_details_favorites_lnk WHERE client_detail_id = ? AND club_owner_id = ? LIMIT 1`,
        [clientDetailIdNum, clubOwnerId],
      );
      return Boolean(favRes?.rows?.length && favRes.rows.length > 0);
    }

    return false;
  } catch (err) {
    strapi.log.warn("[checkIsClubFavoritedDirect] Error:", err);
    return false;
  }
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
            logo: item.logo?.formats?.thumbnail?.url || item.logo?.url || null,
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
       GET CLUB OWNER DETAIL ON USER / CLIENT SIDE
       (GET /api/club-owners/client/:documentId)
    ======================================================= */
    async clientDetail(ctx: Context) {
      try {
        const { documentId, id } = ctx.params;
        const docId = String(documentId || id || "").trim();

        if (!docId) {
          return ctx.badRequest("documentId is required");
        }

        const { latitude, longitude, lat, lon, lng } = ctx.query as any;

        // 1. Fetch club owner & logo directly from postgres
        const ownerQueryRes = await strapi.db.connection.raw(
          `SELECT 
            co.id,
            co.document_id,
            co.phone_number,
            co.email,
            co.club_name,
            co.facilities,
            co.services,
            co.latitude,
            co.longitude,
            co.club_address,
            co.pincode,
            co.city,
            co.state,
            co.created_at,
            co.updated_at,
            co.published_at,
            co.locale,
            co.weekday_scheduling,
            co.club_category,
            f.url AS logo_url,
            f.formats AS logo_formats
          FROM club_owners co
          LEFT JOIN files_related_mph frm ON frm.related_id = co.id 
            AND frm.related_type = 'api::club-owner.club-owner' 
            AND frm.field = 'logo'
          LEFT JOIN files f ON f.id = frm.file_id
          WHERE co.document_id = ? OR co.id::text = ?
          LIMIT 1`,
          [docId, docId],
        );

        const owner = ownerQueryRes?.rows?.[0];
        if (!owner) {
          return ctx.notFound("Club owner not found");
        }

        const ownerId = owner.id;
        const today = getTodayDateString();

        // 2. Fetch club photos, holidays, services, facilities & client favorite status concurrently
        const [
          photosRes,
          holidaysRes,
          servicesRes,
          facilitiesRes,
          isFav,
        ] = await Promise.all([
          // Club photos with image urls
          strapi.db.connection.raw(
            `SELECT 
              cp.id,
              cp.image_info,
              f.url,
              f.formats
            FROM club_photos cp
            JOIN club_photos_club_owner_lnk lnk ON lnk.club_photo_id = cp.id
            LEFT JOIN files_related_mph frm ON frm.related_id = cp.id 
              AND frm.related_type = 'api::club-photo.club-photo' 
              AND frm.field = 'images'
            LEFT JOIN files f ON f.id = frm.file_id
            WHERE lnk.club_owner_id = ?
            ORDER BY cp.id DESC`,
            [ownerId],
          ),

          // Upcoming & today's holidays
          strapi.db.connection.raw(
            `SELECT 
              h.id,
              h.document_id,
              h.title,
              h.closure_type,
              to_char(h.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(h.end_date, 'YYYY-MM-DD') AS end_date,
              h.start_time,
              h.endtime
            FROM holdidays h
            JOIN holdidays_club_owner_lnk lnk ON lnk.holdiday_id = h.id
            WHERE lnk.club_owner_id = ?
              AND (h.end_date >= ? OR (h.end_date IS NULL AND h.start_date >= ?))
            ORDER BY h.start_date ASC`,
            [ownerId, today, today],
          ),

          // Club services relations
          strapi.db.connection.raw(
            `SELECT cs.name
            FROM club_services cs
            JOIN club_services_club_owners_lnk lnk ON lnk.club_service_id = cs.id
            WHERE lnk.club_owner_id = ?`,
            [ownerId],
          ),

          // Club facilities relations
          strapi.db.connection.raw(
            `SELECT cf.name
            FROM club_facilities cf
            JOIN club_owners_club_facilities_lnk lnk ON lnk.club_facility_id = cf.id
            WHERE lnk.club_owner_id = ?`,
            [ownerId],
          ),

          // Favorite check
          checkIsClubFavoritedDirect(ctx, ownerId),
        ]);

        // 3. Format club_photos: return only url and imageInfo
        const club_photos: { url: string; imageInfo: string }[] = [];
        for (const photo of photosRes?.rows || []) {
          if (photo?.url) {
            const url = formatMediaUrl(photo.url);
            if (url) {
              club_photos.push({
                url,
                imageInfo: photo.image_info || "",
              });
            }
          }
        }

        // 4. Format flat arrays of string names for facilities & services
        const facilities = extractStringList(
          owner.facilities,
          facilitiesRes?.rows || [],
        );
        const services = extractStringList(
          owner.services,
          servicesRes?.rows || [],
        );

        // 5. Format upcoming and today holidays (skipping previous days)
        const holidays = (holidaysRes?.rows || []).map((h: any) => ({
          id: h.id,
          documentId: h.document_id,
          title: h.title,
          closureType: h.closure_type,
          startDate: h.start_date,
          endDate: h.end_date || h.start_date,
          startTime: h.start_time || null,
          endtime: h.endtime || null,
        }));

        // 6. Optional distance calculation if user coordinates are provided
        const rawLat = latitude ?? lat;
        const rawLon = longitude ?? lon ?? lng;
        let distance: number | null = null;

        if (
          rawLat !== undefined &&
          rawLon !== undefined &&
          !isNaN(Number(rawLat)) &&
          !isNaN(Number(rawLon)) &&
          owner.latitude &&
          owner.longitude &&
          !isNaN(Number(owner.latitude)) &&
          !isNaN(Number(owner.longitude))
        ) {
          const dist = calculateHaversineDistance(
            Number(rawLat),
            Number(rawLon),
            Number(owner.latitude),
            Number(owner.longitude),
          );
          distance = Number(dist.toFixed(2));
        }

        // 7. Format logo
        let logoFormats = owner.logo_formats;
        if (typeof logoFormats === "string") {
          try {
            logoFormats = JSON.parse(logoFormats);
          } catch (_) {}
        }
        const logo = formatMediaUrl(
          logoFormats?.thumbnail?.url || owner.logo_url || null,
        );

        // 8. Order weekdayScheduling
        let weekdaySchedulingData = owner.weekday_scheduling;
        if (typeof weekdaySchedulingData === "string") {
          try {
            weekdaySchedulingData = JSON.parse(weekdaySchedulingData);
          } catch (_) {}
        }
        const weekdayScheduling = weekdaySchedulingData
          ? orderWeekdayScheduling(weekdaySchedulingData)
          : null;

        // 9. Exact payload format requested by client (membership plans completely removed)
        const responseData = {
          id: owner.id,
          documentId: owner.document_id,
          phoneNumber: owner.phone_number,
          email: owner.email,
          clubName: owner.club_name,
          logo,
          facilities,
          services,
          latitude: owner.latitude,
          longitude: owner.longitude,
          distance,
          distanceUnit: distance !== null ? "km" : undefined,
          clubAddress: owner.club_address,
          pincode: owner.pincode,
          city: owner.city,
          state: owner.state,
          createdAt: owner.created_at,
          updatedAt: owner.updated_at,
          publishedAt: owner.published_at,
          locale: owner.locale ?? null,
          weekdayScheduling,
          clubCategory: owner.club_category || null,
          isFav,
          club_photos,
          holidays,
        };

        return ctx.send(responseData);
      } catch (err) {
        strapi.log.error("GET CLIENT DETAIL ERROR:", err);
        return ctx.internalServerError("Failed to fetch client detail");
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
          where: isNumeric
            ? { id: Number(id) }
            : { documentId: String(id).trim() },
          populate: {
            user: {
              select: ["id", "email"],
            },
          },
        });

        if (!existing) {
          existing = await strapi.entityService.findOne(CLUB_OWNER_UID, id, {
            populate: ["user"],
          });
        }

        if (!existing) {
          return ctx.notFound("Club owner not found");
        }

        // Ownership check: Club owner can only update their own profile, Admin/SuperAdmin can update all
        let userClubOwner: any = null;

        if (roleName === "clubowner") {
          userClubOwner = await getClubOwnerForUser(user);

          if (!userClubOwner) {
            return ctx.forbidden(
              "Club owner profile not found for this account",
            );
          }

          const isOwnerMatch =
            (existing.documentId &&
              userClubOwner.documentId &&
              String(existing.documentId) ===
                String(userClubOwner.documentId)) ||
            (existing.id &&
              userClubOwner.id &&
              String(existing.id) === String(userClubOwner.id)) ||
            (existing.user?.id &&
              user.id &&
              String(existing.user.id) === String(user.id));

          if (!isOwnerMatch) {
            return ctx.forbidden(
              "Access denied. You can only update your own club profile.",
            );
          }
        } else if (isAdmin) {
          // Admin / SuperAdmin can update all club profiles without restriction
        } else {
          // Fallback: check if authenticated user is the owner of this club profile
          userClubOwner = await getClubOwnerForUser(user);

          const isOwnerMatch =
            (userClubOwner &&
              ((existing.documentId &&
                userClubOwner.documentId &&
                String(existing.documentId) ===
                  String(userClubOwner.documentId)) ||
                (existing.id &&
                  userClubOwner.id &&
                  String(existing.id) === String(userClubOwner.id)))) ||
            (existing.user?.id &&
              user.id &&
              String(existing.user.id) === String(user.id));

          if (!isOwnerMatch) {
            return ctx.forbidden(
              "Access denied. Only ClubOwner, Admin, or SuperAdmin can update club profiles.",
            );
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
            strapi.log.warn(
              "documents.update fallback in club-owner update:",
              docErr,
            );
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            CLUB_OWNER_UID,
            existing.id || id,
            {
              data: updateData,
            },
          );
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
          const ownerForLog =
            userClubOwner || (await getClubOwnerForUser(user));
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
                    String(data[field.key]) !==
                      String(existing[field.key] ?? "")
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
                    String(data.latitude) !==
                      String(existing.latitude ?? "")) ||
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
              strapi.log.warn(
                "[ActivityLog] Failed to log club update:",
                logErr,
              );
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
          where.subscriptionType = String(subscriptionType)
            .toLowerCase()
            .trim();
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

    /* =======================================================
       SEARCH NEARBY (WITH OPTIONAL CLUB NAME FILTER)
    ======================================================= */
    async searchNearbyOrCity(ctx: Context) {
      try {
        const {
          latitude,
          longitude,
          lat,
          lon,
          lng,
          radius,
          clubName,
          club_name,
          name,
          search,
          q,
        } = ctx.query as any;

        const rawLat = latitude ?? lat;
        const rawLon = longitude ?? lon ?? lng;

        const hasCoordinates =
          rawLat !== undefined &&
          rawLat !== null &&
          rawLon !== undefined &&
          rawLon !== null &&
          String(rawLat).trim() !== "" &&
          String(rawLon).trim() !== "" &&
          !isNaN(Number(rawLat)) &&
          !isNaN(Number(rawLon));

        if (!hasCoordinates) {
          return ctx.badRequest(
            "Please provide coordinates (latitude & longitude) for nearby search.",
          );
        }

        const maxRadiusKm =
          radius && !isNaN(Number(radius)) ? Number(radius) : 10;

        const rawClubName = clubName || club_name || name || search || q;
        const targetClubName = rawClubName ? String(rawClubName).trim() : "";

        // ----------------------------------------------------
        // Phase 1: Query candidate approved club owners directly via PostgreSQL
        // ----------------------------------------------------
        let candidateSql = `
          SELECT 
            co.id,
            co.document_id,
            co.club_name,
            co.club_id,
            co.latitude,
            co.longitude,
            co.club_address,
            co.city,
            co.services,
            co.facilities
          FROM club_owners co
          JOIN up_users_club_owner_lnk lnk ON lnk.club_owner_id = co.id
          JOIN up_users u ON u.id = lnk.user_id
          WHERE u.verification_status = 'approved'
        `;
        const candidateBindings: any[] = [];

        if (targetClubName) {
          candidateSql += ` AND (LOWER(co.club_name) LIKE LOWER(?) OR REPLACE(LOWER(co.club_name), ' ', '') LIKE LOWER(?))`;
          candidateBindings.push(
            `%${targetClubName}%`,
            `%${targetClubName.replace(/\s+/g, "")}%`,
          );
        }

        const candidateRes = await strapi.db.connection.raw(
          candidateSql,
          candidateBindings,
        );

        const candidateOwners = candidateRes?.rows || [];
        if (candidateOwners.length === 0) {
          return ctx.send({ data: [] });
        }

        const filteredClubs: any[] = [];
        const userLat = Number(rawLat);
        const userLon = Number(rawLon);

        for (const owner of candidateOwners) {
          if (owner.latitude && owner.longitude) {
            const ownerLat = Number(owner.latitude);
            const ownerLon = Number(owner.longitude);

            if (!isNaN(ownerLat) && !isNaN(ownerLon)) {
              const dist = calculateHaversineDistance(
                userLat,
                userLon,
                ownerLat,
                ownerLon,
              );

              if (dist <= maxRadiusKm) {
                filteredClubs.push({
                  ...owner,
                  distance: Number(dist.toFixed(2)),
                  distanceUnit: "km",
                });
              }
            }
          }
        }

        // Sort closest to farthest
        filteredClubs.sort((a, b) => a.distance - b.distance);

        if (filteredClubs.length === 0) {
          return ctx.send({ data: [] });
        }

        const clubOwnerIds = filteredClubs.map((c) => c.id);

        // ----------------------------------------------------
        // Phase 2: Concurrent direct PostgreSQL queries for lean relations
        // ----------------------------------------------------
        const today = getTodayDateString();
        const [
          photosRes,
          servicesRes,
          facilitiesRes,
          holidaysRes,
        ] = await Promise.all([
          // 1. Club Photos with images (latest first)
          strapi.db.connection.raw(
            `SELECT 
              cp.id,
              lnk.club_owner_id,
              f.url
            FROM club_photos cp
            JOIN club_photos_club_owner_lnk lnk ON lnk.club_photo_id = cp.id
            LEFT JOIN files_related_mph frm ON frm.related_id = cp.id 
              AND frm.related_type = 'api::club-photo.club-photo' 
              AND frm.field = 'images'
            LEFT JOIN files f ON f.id = frm.file_id
            WHERE lnk.club_owner_id = ANY(?)
            ORDER BY cp.id DESC`,
            [clubOwnerIds],
          ),

          // 2. Club Services relations
          strapi.db.connection.raw(
            `SELECT 
              lnk.club_owner_id,
              cs.name
            FROM club_services cs
            JOIN club_services_club_owners_lnk lnk ON lnk.club_service_id = cs.id
            WHERE lnk.club_owner_id = ANY(?)`,
            [clubOwnerIds],
          ),

          // 3. Club Facilities relations
          strapi.db.connection.raw(
            `SELECT 
              lnk.club_owner_id,
              cf.name
            FROM club_facilities cf
            JOIN club_owners_club_facilities_lnk lnk ON lnk.club_facility_id = cf.id
            WHERE lnk.club_owner_id = ANY(?)`,
            [clubOwnerIds],
          ),

          // 4. Upcoming & Today Holidays (skipping past days)
          strapi.db.connection.raw(
            `SELECT 
              h.id,
              h.document_id,
              h.title,
              h.closure_type,
              to_char(h.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(h.end_date, 'YYYY-MM-DD') AS end_date,
              h.start_time,
              h.endtime,
              lnk.club_owner_id
            FROM holdidays h
            JOIN holdidays_club_owner_lnk lnk ON lnk.holdiday_id = h.id
            WHERE lnk.club_owner_id = ANY(?)
              AND (h.end_date >= ? OR (h.end_date IS NULL AND h.start_date >= ?))
            ORDER BY h.start_date ASC`,
            [clubOwnerIds, today, today],
          ),
        ]);

        // Map photos by owner ID (latest 5 photos max)
        const photosByOwnerId = new Map<number, { url: string }[]>();
        for (const photo of photosRes?.rows || []) {
          const ownerId = photo.club_owner_id;
          if (!ownerId) continue;

          if (!photosByOwnerId.has(ownerId)) {
            photosByOwnerId.set(ownerId, []);
          }

          const existingPhotos = photosByOwnerId.get(ownerId)!;
          if (existingPhotos.length >= 5) continue;

          if (photo.url) {
            const formattedUrl = formatMediaUrl(photo.url);
            if (formattedUrl) {
              existingPhotos.push({ url: formattedUrl });
            }
          }
        }

        // Map services and facilities by owner ID
        const relationServicesMap = new Map<number, string[]>();
        for (const s of servicesRes?.rows || []) {
          if (!s.club_owner_id || !s.name) continue;
          if (!relationServicesMap.has(s.club_owner_id)) {
            relationServicesMap.set(s.club_owner_id, []);
          }
          relationServicesMap.get(s.club_owner_id)!.push(s.name);
        }

        const relationFacilitiesMap = new Map<number, string[]>();
        for (const f of facilitiesRes?.rows || []) {
          if (!f.club_owner_id || !f.name) continue;
          if (!relationFacilitiesMap.has(f.club_owner_id)) {
            relationFacilitiesMap.set(f.club_owner_id, []);
          }
          relationFacilitiesMap.get(f.club_owner_id)!.push(f.name);
        }

        const servicesByOwnerId = new Map<number, string[]>();
        const facilitiesByOwnerId = new Map<number, string[]>();

        for (const club of filteredClubs) {
          const services = extractStringList(
            club.services,
            relationServicesMap.get(club.id) || [],
          );
          const facilities = extractStringList(
            club.facilities,
            relationFacilitiesMap.get(club.id) || [],
          );
          servicesByOwnerId.set(club.id, services);
          facilitiesByOwnerId.set(club.id, facilities);
        }

        // Map upcoming & today holidays by owner ID
        const holidaysByOwnerId = new Map<number, any[]>();
        for (const holiday of holidaysRes?.rows || []) {
          const ownerId = holiday.club_owner_id;
          if (!ownerId) continue;

          if (!holidaysByOwnerId.has(ownerId)) {
            holidaysByOwnerId.set(ownerId, []);
          }

          holidaysByOwnerId.get(ownerId)!.push({
            id: holiday.id,
            documentId: holiday.document_id,
            title: holiday.title,
            closureType: holiday.closure_type,
            startDate: holiday.start_date,
            endDate: holiday.end_date || holiday.start_date,
            startTime: holiday.start_time || null,
            endtime: holiday.endtime || null,
          });
        }

        // Assemble clean, customized & lean response payload
        const data = filteredClubs.map((club: any) => ({
          id: club.id,
          documentId: club.document_id,
          clubName: club.club_name,
          clubId: club.club_id,
          city: club.city,
          address: club.club_address,
          latitude: club.latitude,
          longitude: club.longitude,
          distance: club.distance !== undefined ? club.distance : null,
          distanceUnit: "km",
          club_photos: (photosByOwnerId.get(club.id) || []).slice(0, 5),
          services: servicesByOwnerId.get(club.id) || [],
          facilities: facilitiesByOwnerId.get(club.id) || [],
          holidays: holidaysByOwnerId.get(club.id) || [],
        }));

        return ctx.send({
          data,
        });
      } catch (error) {
        strapi.log.error("SEARCH CLUB OWNERS ERROR:", error);
        return ctx.internalServerError("Failed to search club owners");
      }
    },
    
  }),
);
