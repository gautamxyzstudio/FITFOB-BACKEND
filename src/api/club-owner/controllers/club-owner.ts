import { factories } from "@strapi/strapi";
import { Context } from "koa";
import bcrypt from "bcryptjs";
import axios from "axios";
import {
  normalizeWeekdayScheduling,
  orderWeekdayScheduling,
  formatWeekdaySchedulingToString,
} from "../../../utils/weekdayScheduling";
import {
  resolveClubServiceIds,
  resolveClubFacilityIds,
} from "../../../utils/resolveClubRelations";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { getOtpEmailTemplate } from "../../../utils/otpEmailTemplate";

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

/* ---------- OTP GENERATOR ---------- */
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* ---------- NORMALIZE PHONE ---------- */
const normalizePhone = (identifier: string) => {
  if (!identifier) return identifier;
  if (identifier.includes("@")) return identifier.trim().toLowerCase();

  let num = identifier.replace(/\D/g, "");

  if (num.length === 10) return `+91${num}`;
  if (num.length === 12 && num.startsWith("91")) return `+${num}`;
  if (identifier.startsWith("+91")) return identifier;

  return identifier;
};

/* ---------- REQUEST BODY PARSER HELPER ---------- */
function getBody(ctx: Context) {
  const rawBody: any = ctx.request.body || {};
  let parsed: any = {};
  if (rawBody.data) {
    if (typeof rawBody.data === "string") {
      const str = rawBody.data.trim();
      try {
        parsed = JSON.parse(str);
      } catch {
        const lastBrace = str.lastIndexOf("}");
        if (lastBrace !== -1) {
          try {
            parsed = JSON.parse(str.substring(0, lastBrace + 1));
          } catch (_) {}
        }
      }
    } else if (typeof rawBody.data === "object") {
      parsed = rawBody.data;
    }
  }
  return { ...rawBody, ...parsed };
}

/* ---------- IDENTIFY USER REGISTRATION TYPE ---------- */
function getUserRegistrationType(user: any): "email" | "phone" {
  if (user?.username) {
    return user.username.includes("@") ? "email" : "phone";
  }
  if (user?.email && !user.email.toLowerCase().endsWith("@phone.user")) {
    return "email";
  }
  return "phone";
}

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

/* ---------- HELPER: GET SMALL OR ORIGINAL IMAGE URL ---------- */
function getSmallOrOriginalImageUrl(media: any): string | null {
  if (!media) return null;
  if (typeof media === "string") return formatMediaUrl(media);

  const target = media.data ? media.data : media;
  const item = target.attributes ? target.attributes : target;

  let formats = item.formats;
  if (typeof formats === "string") {
    try {
      formats = JSON.parse(formats);
    } catch (_) {}
  }

  const rawUrl = formats?.small?.url || item.url || null;
  return formatMediaUrl(rawUrl);
}

/* ---------- HELPER: FORMAT CLUB OWNER MEDIA/IMAGES ---------- */
function formatClubOwnerMedia(entity: any): any {
  if (!entity || typeof entity !== "object") return entity;

  // Sanitize user sensitive fields (password, tokens, secrets)
  if (entity.user && typeof entity.user === "object") {
    const {
      password,
      resetPasswordToken,
      confirmationToken,
      mfa_secret,
      mfa_temp_secret,
      mfa_temp_token,
      ...safeUser
    } = entity.user;
    entity.user = safeUser;
  }

  // 1. Logo
  if (entity.logo) {
    entity.logo = getSmallOrOriginalImageUrl(entity.logo);
  }

  // 2. Club photos
  if (Array.isArray(entity.club_photos)) {
    entity.club_photos = entity.club_photos.map((photo: any) => {
      if (!photo || typeof photo !== "object") return photo;
      let photoUrl: string | null = null;
      if (Array.isArray(photo.images) && photo.images.length > 0) {
        photoUrl = getSmallOrOriginalImageUrl(photo.images[0]);
      } else if (photo.images) {
        photoUrl = getSmallOrOriginalImageUrl(photo.images);
      } else if (photo.url) {
        photoUrl = getSmallOrOriginalImageUrl(photo.url);
      }
      return {
        documentId: photo.documentId,
        imageInfo: photo.imageInfo || "",
        url: photoUrl,
      };
    });
  }

  // 3. Club services
  if (Array.isArray(entity.club_services)) {
    entity.club_services = entity.club_services.map((service: any) => {
      if (!service || typeof service !== "object") return service;
      return {
        ...service,
        logo: getSmallOrOriginalImageUrl(service.logo),
      };
    });
  }

  // 4. Club facilities
  if (Array.isArray(entity.club_facilities)) {
    entity.club_facilities = entity.club_facilities.map((facility: any) => {
      if (!facility || typeof facility !== "object") return facility;
      return {
        ...facility,
        logo: getSmallOrOriginalImageUrl(facility.logo),
      };
    });
  }

  // 5. Club owner documents
  if (Array.isArray(entity.club_owner_documents)) {
    entity.club_owner_documents = entity.club_owner_documents.map((doc: any) => {
      if (!doc || typeof doc !== "object") return doc;
      const fileUrl = getSmallOrOriginalImageUrl(doc.File || doc.file);
      return {
        documentId: doc.documentId,
        documentName: doc.documentName || doc.document_name || "",
        fileUrl,
      };
    });
  }

  return entity;
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

/* ---------- RESOLVE FACILITY NAMES HELPER ---------- */
async function resolveFacilityNames(
  items: any,
  relationItems?: any[],
  ownerId?: number,
): Promise<string[]> {
  const names = extractStringList(items, relationItems || []);

  // If items contains numeric IDs, resolve their names from club_facilities
  let rawList = items;
  if (typeof rawList === "string") {
    try {
      rawList = JSON.parse(rawList);
    } catch {
      rawList = rawList.split(",").map((s: string) => s.trim());
    }
  }
  if (Array.isArray(rawList)) {
    const numericIds = rawList
      .map((x) => (typeof x === "object" && x !== null ? x.id : x))
      .filter(
        (x) =>
          typeof x === "number" || (!isNaN(Number(x)) && typeof x === "string"),
      )
      .map((x) => Number(x));

    if (numericIds.length > 0) {
      try {
        const found = await strapi.db
          .query("api::club-facility.club-facility")
          .findMany({
            where: { id: { $in: numericIds } },
            select: ["id", "name"],
          });
        if (Array.isArray(found)) {
          for (const f of found) {
            if (f?.name && typeof f.name === "string" && f.name.trim()) {
              names.push(f.name.trim());
            }
          }
        }
      } catch (_) {}
    }
  }

  // Fallback to relation link table if still empty and ownerId is present
  if (names.length === 0 && ownerId) {
    try {
      const res = await strapi.db.connection.raw(
        `SELECT cf.name FROM club_facilities cf
         JOIN club_owners_club_facilities_lnk lnk ON lnk.club_facility_id = cf.id
         WHERE lnk.club_owner_id = ?`,
        [ownerId],
      );
      const rows = res?.rows || res || [];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r?.name && typeof r.name === "string" && r.name.trim()) {
            names.push(r.name.trim());
          }
        }
      }
    } catch (_) {}
  }

  if (names.length === 0 && Array.isArray(rawList) && rawList.length > 0) {
    for (const item of rawList) {
      if (item !== null && item !== undefined) {
        names.push(
          typeof item === "object"
            ? item?.name || JSON.stringify(item)
            : String(item),
        );
      }
    }
  }

  return Array.from(new Set(names));
}

/* ---------- RESOLVE SERVICE NAMES HELPER ---------- */
async function resolveServiceNames(
  items: any,
  relationItems?: any[],
  ownerId?: number,
): Promise<string[]> {
  const names = extractStringList(items, relationItems || []);

  // If items contains numeric IDs, resolve their names from club_services
  let rawList = items;
  if (typeof rawList === "string") {
    try {
      rawList = JSON.parse(rawList);
    } catch {
      rawList = rawList.split(",").map((s: string) => s.trim());
    }
  }
  if (Array.isArray(rawList)) {
    const numericIds = rawList
      .map((x) => (typeof x === "object" && x !== null ? x.id : x))
      .filter(
        (x) =>
          typeof x === "number" || (!isNaN(Number(x)) && typeof x === "string"),
      )
      .map((x) => Number(x));

    if (numericIds.length > 0) {
      try {
        const found = await strapi.db
          .query("api::club-service.club-service")
          .findMany({
            where: { id: { $in: numericIds } },
            select: ["id", "name"],
          });
        if (Array.isArray(found)) {
          for (const s of found) {
            if (s?.name && typeof s.name === "string" && s.name.trim()) {
              names.push(s.name.trim());
            }
          }
        }
      } catch (_) {}
    }
  }

  // Fallback to relation link table if still empty and ownerId is present
  if (names.length === 0 && ownerId) {
    try {
      const res = await strapi.db.connection.raw(
        `SELECT cs.name FROM club_services cs
         JOIN club_owners_club_services_lnk lnk ON lnk.club_service_id = cs.id
         WHERE lnk.club_owner_id = ?`,
        [ownerId],
      );
      const rows = res?.rows || res || [];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r?.name && typeof r.name === "string" && r.name.trim()) {
            names.push(r.name.trim());
          }
        }
      }
    } catch (_) {}
  }

  if (names.length === 0 && Array.isArray(rawList) && rawList.length > 0) {
    for (const item of rawList) {
      if (item !== null && item !== undefined) {
        names.push(
          typeof item === "object"
            ? item?.name || JSON.stringify(item)
            : String(item),
        );
      }
    }
  }

  return Array.from(new Set(names));
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
                $or: [{ id: Number(detailStr) }, { documentId: detailStr }],
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

        formatClubOwnerMedia(entity);

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

        // 2. Fetch club photos, holidays, services, facilities, active membership plans & client favorite status concurrently
        const [
          photosRes,
          holidaysRes,
          servicesRes,
          facilitiesRes,
          plansRes,
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

          // Active local membership plans
          strapi.db.connection.raw(
            `SELECT 
              lmp.document_id,
              lmp.plan_name,
              lmp.price,
              lmp.month_duration,
              lmp.is_active,
              lmp.valid_upto
            FROM local_membership_plans lmp
            JOIN local_membership_plans_club_owner_lnk lnk ON lnk.local_membership_plan_id = lmp.id
            WHERE lnk.club_owner_id = ?
              AND lmp.is_active = true
            ORDER BY lmp.id ASC`,
            [ownerId],
          ),

          // Favorite check
          checkIsClubFavoritedDirect(ctx, ownerId),
        ]);

        // 3. Format club_photos: return small url (with fallback) and imageInfo
        const club_photos: { url: string; imageInfo: string }[] = [];
        for (const photo of photosRes?.rows || []) {
          if (photo?.url) {
            let formats = photo.formats;
            if (typeof formats === "string") {
              try {
                formats = JSON.parse(formats);
              } catch (_) {}
            }
            const photoUrl =
              formats?.small?.url || formats?.thumbnail?.url || photo.url;

            const url = formatMediaUrl(photoUrl);
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

        // 6. Format active membership plans
        const membershipPlans = (plansRes?.rows || []).map((p: any) => ({
          documentId:p.document_id,
          planName: p.plan_name,
          price:
            typeof p.price === "string" ? parseFloat(p.price) : p.price,
          monthDuration: p.month_duration,
          isActive: p.is_active,
          validUpto: p.valid_upto || "unlimited",
        }));

        // 7. Optional distance calculation if user coordinates are provided
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

        // 8. Format logo
        let logoFormats = owner.logo_formats;
        if (typeof logoFormats === "string") {
          try {
            logoFormats = JSON.parse(logoFormats);
          } catch (_) {}
        }
        const logo = formatMediaUrl(
          logoFormats?.small?.url ||
            logoFormats?.thumbnail?.url ||
            owner.logo_url ||
            null,
        );

        // 9. Order weekdayScheduling
        let weekdaySchedulingData = owner.weekday_scheduling;
        if (typeof weekdaySchedulingData === "string") {
          try {
            weekdaySchedulingData = JSON.parse(weekdaySchedulingData);
          } catch (_) {}
        }
        const weekdayScheduling = weekdaySchedulingData
          ? orderWeekdayScheduling(weekdaySchedulingData)
          : null;

        // 10. Exact payload format requested by client
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
          membershipPlans,
        };

        return ctx.send(responseData);
      } catch (err) {
        strapi.log.error("GET CLIENT DETAIL ERROR:", err);
        return ctx.internalServerError("Failed to fetch client detail");
      }
    },

    /* =======================================================
       STEP 1A — SEND OTP FOR EMAIL / PHONE PROFILE UPDATE
    ======================================================= */
    async sendDetailsOtp(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clubOwner = await getClubOwnerForUser(user);
        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found for this account");
        }

        let fullUser = user;
        if (!fullUser.username || fullUser.phoneNumber === undefined) {
          const u = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: user.id },
              select: ["id", "username", "email", "phoneNumber"],
            });
          if (u) fullUser = u;
        }

        const regType = getUserRegistrationType(fullUser);
        const body = getBody(ctx);
        const rawIdentifier =
          body.identifier ||
          (regType === "email" ? body.phoneNumber : body.email) ||
          body.phoneNumber ||
          body.email ||
          null;

        if (!rawIdentifier) {
          return ctx.badRequest(
            regType === "email"
              ? "Phone number is required to send verification OTP."
              : "Email address is required to send verification OTP.",
          );
        }

        const isEmail = String(rawIdentifier).includes("@");

        if (regType === "email" && isEmail) {
          return ctx.badRequest(
            "Your email address is already verified from signup and cannot be changed. Only phone number is editable.",
          );
        }

        if (regType === "phone" && !isEmail) {
          return ctx.badRequest(
            "Your phone number is already verified from signup and cannot be changed. Only email address is editable.",
          );
        }

        const identifier = isEmail
          ? String(rawIdentifier).trim().toLowerCase()
          : normalizePhone(String(rawIdentifier).trim());

        if (isEmail) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(identifier)) {
            return ctx.badRequest("Invalid email address format.");
          }
        } else {
          const cleanDigits = identifier.replace(/\D/g, "");
          if (cleanDigits.length < 10) {
            return ctx.badRequest("Invalid phone number format.");
          }
        }

        // Prevent verifying same current value
        if (isEmail) {
          const currentEmail = String(clubOwner.email || user.email || "")
            .trim()
            .toLowerCase();
          if (identifier === currentEmail) {
            return ctx.badRequest(
              "The provided email is already your current email address.",
            );
          }
        } else {
          const currentPhone = normalizePhone(
            String(clubOwner.phoneNumber || user.phoneNumber || "").trim(),
          );
          if (identifier === currentPhone) {
            return ctx.badRequest(
              "The provided phone number is already your current phone number.",
            );
          }
        }

        // Uniqueness check across other club owners
        if (isEmail) {
          const existingClub = await strapi.db.query(CLUB_OWNER_UID).findOne({
            where: {
              email: identifier,
              id: { $ne: clubOwner.id },
            },
            select: ["id"],
          });

          if (existingClub) {
            return ctx.badRequest(
              "This email address is already in use by another club owner.",
            );
          }
        } else {
          const existingClub = await strapi.db.query(CLUB_OWNER_UID).findOne({
            where: {
              phoneNumber: identifier,
              id: { $ne: clubOwner.id },
            },
            select: ["id"],
          });

          if (existingClub) {
            return ctx.badRequest(
              "This phone number is already in use by another club owner.",
            );
          }
        }

        const otp = generateOtp();
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
        const docId = Math.random().toString(36).substring(2, 26);
        const now = new Date();

        await strapi.db.connection.raw(
          `DELETE FROM otp_requests 
           WHERE identifier = ? AND purpose = 'club_owner_verification'`,
          [identifier],
        );

        await strapi.db.connection.raw(
          `INSERT INTO otp_requests (
            document_id,
            identifier,
            otp_hash,
            expires_at,
            attempts,
            verified,
            purpose,
            last_sent_at,
            created_at,
            updated_at,
            published_at
          ) VALUES (?, ?, ?, ?, 0, false, 'club_owner_verification', ?, ?, ?, ?)`,
          [docId, identifier, otpHash, expiresAt, now, now, now, now],
        );

        if (isEmail) {
          try {
            await axios.post(
              "https://api.brevo.com/v3/smtp/email",
              {
                sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
                to: [{ email: identifier }],
                subject: "FitFob Club Owner Email Verification OTP",
                htmlContent: getOtpEmailTemplate(otp, {
                  title: "FitFob Email Verification Code",
                  subtext:
                    "Use the One-Time Password (OTP) below to verify and update your email address for your club profile:",
                  validityMinutes: 2,
                }),
              },
              { headers: { "api-key": process.env.BREVO_API_KEY } },
            );
          } catch (emailError: any) {
            strapi.log.error(
              "[CLUB OWNER EMAIL OTP SEND ERROR]",
              emailError?.response?.data || emailError,
            );
            return ctx.badRequest(
              "Failed to send verification email. Please verify the email address.",
            );
          }

          return ctx.send({
            success: true,
            verificationType: "email",
            identifier,
            message: "OTP sent to your email address to verify.",
          });
        } else {
          try {
            await sendTwilioOtp(identifier, otp);
          } catch (smsError: any) {
            strapi.log.error("[CLUB OWNER PHONE OTP SEND ERROR]", smsError);
            return ctx.badRequest(
              "Failed to send OTP to the provided phone number. Please verify the phone number.",
            );
          }

          return ctx.send({
            verificationType: "phone",
            identifier,
            message: "OTP sent to your phone number to verify.",
          });
        }
      } catch (err: any) {
        strapi.log.error("CLUB OWNER SEND OTP ERROR:", err);
        return ctx.internalServerError(
          err?.message || "Failed to send verification OTP",
        );
      }
    },

    /* =======================================================
       STEP 1B — VERIFY OTP AND UPDATE EMAIL / PHONE
    ======================================================= */
    async verifyDetailsOtp(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clubOwner = await getClubOwnerForUser(user);
        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found for this account");
        }

        let fullUser = user;
        if (!fullUser.username || fullUser.phoneNumber === undefined) {
          const u = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: user.id },
              select: ["id", "username", "email", "phoneNumber"],
            });
          if (u) fullUser = u;
        }

        const regType = getUserRegistrationType(fullUser);
        const body = getBody(ctx);
        const otp = String(body.otp || "").trim();

        if (!otp) {
          return ctx.badRequest("OTP is required");
        }

        const rawIdentifier =
          body.identifier ||
          (regType === "email" ? body.phoneNumber : body.email) ||
          body.phoneNumber ||
          body.email ||
          null;

        if (!rawIdentifier) {
          return ctx.badRequest(
            regType === "email"
              ? "Phone number is required to verify OTP"
              : "Email address is required to verify OTP",
          );
        }

        const isEmail = String(rawIdentifier).includes("@");

        if (regType === "email" && isEmail) {
          return ctx.badRequest(
            "Your email address is already verified from signup and cannot be changed. Only phone number is editable.",
          );
        }

        if (regType === "phone" && !isEmail) {
          return ctx.badRequest(
            "Your phone number is already verified from signup and cannot be changed. Only email address is editable.",
          );
        }

        const identifier = isEmail
          ? String(rawIdentifier).trim().toLowerCase()
          : normalizePhone(String(rawIdentifier).trim());

        const recordRes = await strapi.db.connection.raw(
          `SELECT id, otp_hash, expires_at, attempts 
           FROM otp_requests 
           WHERE identifier = ? AND purpose = 'club_owner_verification' 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [identifier],
        );

        const record = recordRes?.rows?.[0];

        if (!record) {
          return ctx.badRequest("OTP not found. Please request a new OTP.");
        }

        if (new Date(record.expires_at).getTime() < Date.now()) {
          await strapi.db.connection.raw(
            `DELETE FROM otp_requests WHERE id = ?`,
            [record.id],
          );
          return ctx.badRequest("OTP expired. Please resend OTP.");
        }

        const valid = await bcrypt.compare(otp, record.otp_hash);
        if (!valid) {
          await strapi.db.connection.raw(
            `UPDATE otp_requests SET attempts = attempts + 1, updated_at = NOW() WHERE id = ?`,
            [record.id],
          );
          return ctx.badRequest("Invalid OTP");
        }

        // Delete consumed OTP
        await strapi.db.connection.raw(
          `DELETE FROM otp_requests WHERE id = ?`,
          [record.id],
        );

        // Update in database: ONLY club_owners (not up_users)
        if (isEmail) {
          await strapi.db.connection.raw(
            `UPDATE club_owners 
             SET email = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [identifier, clubOwner.id],
          );
        } else {
          await strapi.db.connection.raw(
            `UPDATE club_owners 
             SET phone_number = ?, 
                 updated_at = NOW() 
             WHERE id = ?`,
            [identifier, clubOwner.id],
          );
        }

        // Invalidate cached club owner on user object
        if (typeof user === "object" && user !== null) {
          delete user._cachedClubOwner;
        }

        // Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::club-owner-activity-log.club-owner-activity-log",
          );
          if (activityLogService?.logActivity) {
            await activityLogService.logActivity({
              clubOwnerId: clubOwner.documentId || clubOwner.id,
              category: "profile",
              actionType: "UPDATE",
              entityName: "Club Profile",
              entityId: clubOwner.documentId || clubOwner.id,
              description: `Verified and updated ${
                isEmail ? "email" : "phone number"
              } for ${clubOwner.clubName || "club"} to ${identifier}`,
            });
          }
        } catch (logErr) {
          strapi.log.warn(
            "[ActivityLog] Failed to log verified detail update:",
            logErr,
          );
        }

        return ctx.send({
          verified: true,
          verificationType: isEmail ? "email" : "phone",
          identifier,
          message: `${
            isEmail ? "Email address" : "Phone number"
          } verified and updated successfully.`,
        });
      } catch (err: any) {
        strapi.log.error("CLUB OWNER VERIFY OTP ERROR:", err);
        return ctx.internalServerError(
          err?.message || "Failed to verify details OTP",
        );
      }
    },

    /* =======================================================
       STEP 1C — RESEND OTP FOR EMAIL / PHONE PROFILE UPDATE
    ======================================================= */
    async resendDetailsOtp(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clubOwner = await getClubOwnerForUser(user);
        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found for this account");
        }

        let fullUser = user;
        if (!fullUser.username || fullUser.phoneNumber === undefined) {
          const u = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: user.id },
              select: ["id", "username", "email", "phoneNumber"],
            });
          if (u) fullUser = u;
        }

        const regType = getUserRegistrationType(fullUser);
        const body = getBody(ctx);
        const rawIdentifier =
          body.identifier ||
          (regType === "email" ? body.phoneNumber : body.email) ||
          body.phoneNumber ||
          body.email ||
          null;

        if (!rawIdentifier) {
          return ctx.badRequest(
            regType === "email"
              ? "Phone number is required to resend OTP"
              : "Email address is required to resend OTP",
          );
        }

        const isEmail = String(rawIdentifier).includes("@");

        if (regType === "email" && isEmail) {
          return ctx.badRequest(
            "Your email address is already verified from signup and cannot be changed. Please provide your phone number to resend OTP.",
          );
        }

        if (regType === "phone" && !isEmail) {
          return ctx.badRequest(
            "Your phone number is already verified from signup and cannot be changed. Please provide your email address to resend OTP.",
          );
        }

        const identifier = isEmail
          ? String(rawIdentifier).trim().toLowerCase()
          : normalizePhone(String(rawIdentifier).trim());

        // Check cooldown (30 seconds) via direct SQL
        const existingRes = await strapi.db.connection.raw(
          `SELECT id, last_sent_at 
           FROM otp_requests 
           WHERE identifier = ? AND purpose = 'club_owner_verification' 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [identifier],
        );

        const existing = existingRes?.rows?.[0];

        if (existing?.last_sent_at) {
          const now = Date.now();
          const last = new Date(existing.last_sent_at).getTime();
          if (now - last < 30000) {
            return ctx.badRequest(
              "Please wait 30 seconds before requesting again",
            );
          }
        }

        const otp = generateOtp();
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
        const docId = Math.random().toString(36).substring(2, 26);
        const now = new Date();

        await strapi.db.connection.raw(
          `DELETE FROM otp_requests 
           WHERE identifier = ? AND purpose = 'club_owner_verification'`,
          [identifier],
        );

        await strapi.db.connection.raw(
          `INSERT INTO otp_requests (
            document_id,
            identifier,
            otp_hash,
            expires_at,
            attempts,
            verified,
            purpose,
            last_sent_at,
            created_at,
            updated_at,
            published_at
          ) VALUES (?, ?, ?, ?, 0, false, 'club_owner_verification', ?, ?, ?, ?)`,
          [docId, identifier, otpHash, expiresAt, now, now, now, now],
        );

        if (isEmail) {
          try {
            await axios.post(
              "https://api.brevo.com/v3/smtp/email",
              {
                sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
                to: [{ email: identifier }],
                subject: "FitFob Club Owner Email Verification OTP",
                htmlContent: getOtpEmailTemplate(otp, {
                  title: "FitFob Email Verification Code",
                  subtext:
                    "Here is your requested One-Time Password (OTP) to verify your email address for your club profile:",
                  validityMinutes: 2,
                }),
              },
              { headers: { "api-key": process.env.BREVO_API_KEY } },
            );
          } catch (emailError: any) {
            strapi.log.error(
              "[CLUB OWNER EMAIL OTP SEND ERROR]",
              emailError?.response?.data || emailError,
            );
            return ctx.badRequest(
              "Failed to send verification email. Please verify the email address.",
            );
          }
        } else {
          try {
            await sendTwilioOtp(identifier, otp);
          } catch (smsError: any) {
            strapi.log.error("[CLUB OWNER PHONE OTP SEND ERROR]", smsError);
            return ctx.badRequest(
              "Failed to send OTP to the provided phone number. Please verify the phone number.",
            );
          }
        }

        return ctx.send({
          message: "OTP resent successfully",
          identifier,
        });
      } catch (err: any) {
        strapi.log.error("CLUB OWNER RESEND OTP ERROR:", err);
        return ctx.internalServerError(
          err?.message || "Failed to resend verification OTP",
        );
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
            club_facilities: {
              select: ["id", "name"],
            },
            club_services: {
              select: ["id", "name"],
            },
          },
        });

        if (!existing) {
          existing = await strapi.entityService.findOne(CLUB_OWNER_UID, id, {
            populate: ["user", "club_facilities", "club_services"],
          });
        }

        if (!existing) {
          return ctx.notFound("Club owner not found");
        }

        const oldFacilities = await resolveFacilityNames(
          existing?.facilities,
          existing?.club_facilities,
          existing?.id,
        );
        const oldServices = await resolveServiceNames(
          existing?.services,
          existing?.club_services,
          existing?.id,
        );

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
                  { key: "latitude", label: "latitude" },
                  { key: "longitude", label: "longitude" },
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
                  const oldScheduleStr = formatWeekdaySchedulingToString(
                    existing?.weekdayScheduling ?? existing?.weekday_scheduling,
                  );
                  const newScheduleStr = formatWeekdaySchedulingToString(
                    entity?.weekdayScheduling ??
                      entity?.weekday_scheduling ??
                      updateData.weekdayScheduling ??
                      data.weekdayScheduling,
                  );
                  if (oldScheduleStr !== newScheduleStr) {
                    changedDetails.push(
                      `weekdayScheduling: '${oldScheduleStr}' -> '${newScheduleStr}'`,
                    );
                  }
                }
                if (
                  data.facilities !== undefined ||
                  data.club_facilities !== undefined
                ) {
                  const newFacilities = await resolveFacilityNames(
                    entity?.facilities !== undefined
                      ? entity.facilities
                      : data.facilities !== undefined
                      ? data.facilities
                      : data.club_facilities,
                    entity?.club_facilities,
                    existing?.id || id,
                  );
                  const oldFacilitiesStr = oldFacilities.join(", ");
                  const newFacilitiesStr = newFacilities.join(", ");
                  if (oldFacilitiesStr !== newFacilitiesStr) {
                    changedDetails.push(
                      `facilities: '${oldFacilitiesStr}' -> '${newFacilitiesStr}'`,
                    );
                  }
                }
                if (
                  data.services !== undefined ||
                  data.club_services !== undefined
                ) {
                  const newServices = await resolveServiceNames(
                    entity?.services !== undefined
                      ? entity.services
                      : data.services !== undefined
                      ? data.services
                      : data.club_services,
                    entity?.club_services,
                    existing?.id || id,
                  );
                  const oldServicesStr = oldServices.join(", ");
                  const newServicesStr = newServices.join(", ");
                  if (oldServicesStr !== newServicesStr) {
                    changedDetails.push(
                      `services: '${oldServicesStr}' -> '${newServicesStr}'`,
                    );
                  }
                }
                if (data.logo !== undefined) {
                  changedDetails.push("logo");
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
                  "clubCategory",
                  "weekdayScheduling",
                  "facilities",
                  "club_facilities",
                  "services",
                  "club_services",
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
       TOGGLE SEND NOTIFICATIONS (ADMIN / SUPERADMIN ONLY)
       Route: PUT /api/toggle-send-noyifications/:documentId
    ======================================================= */
    async toggleSendNotifications(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin users can enable or disable notifications for club owners.",
          );
        }

        const targetDocumentId =
          ctx.params.documentId ||
          ctx.params.documentid ||
          ctx.params.id ||
          (ctx.request.body as any)?.documentId ||
          (ctx.query as any)?.documentId;

        if (!targetDocumentId || String(targetDocumentId).trim() === "") {
          return ctx.badRequest("Club owner documentId is required");
        }

        const docIdStr = String(targetDocumentId).trim();

        // 1. Fetch existing club owner using direct PostgreSQL query
        const selectSql = `
          SELECT id, document_id, club_name, owner_name, send_notifications 
          FROM club_owners 
          WHERE document_id = ? OR CAST(id AS TEXT) = ?
          LIMIT 1
        `;
        const selectRes = await strapi.db.connection.raw(selectSql, [
          docIdStr,
          docIdStr,
        ]);
        const existing = selectRes?.rows?.[0];

        if (!existing) {
          return ctx.notFound("Club owner not found with the provided documentId");
        }

        // 2. Determine target status (explicitly set if provided, otherwise toggle)
        const body = getBody(ctx);
        let targetStatus: boolean;

        if (body.sendNotifications !== undefined) {
          targetStatus = Boolean(body.sendNotifications);
        } else if (body.send_notifications !== undefined) {
          targetStatus = Boolean(body.send_notifications);
        } else if (body.enabled !== undefined) {
          targetStatus = Boolean(body.enabled);
        } else if (body.status !== undefined) {
          targetStatus = Boolean(body.status);
        } else {
          targetStatus = !Boolean(existing.send_notifications);
        }

        // 3. Update notification status in PostgreSQL directly
        const updateSql = `
          UPDATE club_owners 
          SET send_notifications = ?, updated_at = NOW() 
          WHERE id = ? 
          RETURNING id, document_id, club_name, owner_name, send_notifications
        `;
        const updateRes = await strapi.db.connection.raw(updateSql, [
          targetStatus,
          existing.id,
        ]);
        const updated = updateRes?.rows?.[0] || {
          ...existing,
          send_notifications: targetStatus,
        };

        return ctx.send({
          message: `Notifications ${
            targetStatus ? "enabled" : "disabled"
          } successfully`,
          data: {
            id: updated.id,
            documentId: updated.document_id,
            clubName: updated.club_name,
            ownerName: updated.owner_name,
            sendNotifications: updated.send_notifications,
          },
        });
      } catch (err: any) {
        strapi.log.error("TOGGLE SEND NOTIFICATIONS ERROR:", err);
        return ctx.internalServerError("Failed to update notification status");
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

        const { startDate, endDate } = ctx.query as any;

        const where: any = {
          club_owner: clubOwner.id,
        };

        // Date range: custom range if passed, otherwise defaults to Today
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

        // 6. Fetch check-ins
        const checkins = await strapi.db
          .query("api::client-checkin.client-checkin")
          .findMany({
            where,
            populate: {
              client_detail: {
                select: ["id", "documentId", "clientId", "name", "gender"],
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

        let maxRadiusKm = 10;
        if (
          radius !== undefined &&
          radius !== null &&
          String(radius).trim() !== ""
        ) {
          const parsedRadius = Number(radius);
          if (isNaN(parsedRadius) || parsedRadius <= 0) {
            return ctx.badRequest(
              "Please provide a valid radius greater than 0 km.",
            );
          }
          if (parsedRadius > 30) {
            return ctx.badRequest("Radius cannot exceed 30 km.");
          }
          maxRadiusKm = parsedRadius;
        }

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
          plansRes,
        ] = await Promise.all([
          // 1. Club Photos with images (latest first)
          strapi.db.connection.raw(
            `SELECT 
              cp.id,
              lnk.club_owner_id,
              f.url,
              f.formats
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

          // 5. Active local membership plans
          strapi.db.connection.raw(
            `SELECT 
              lnk.club_owner_id,
              lmp.document_id,
              lmp.plan_name,
              lmp.price,
              lmp.month_duration,
              lmp.is_active,
              lmp.valid_upto
            FROM local_membership_plans lmp
            JOIN local_membership_plans_club_owner_lnk lnk ON lnk.local_membership_plan_id = lmp.id
            WHERE lnk.club_owner_id = ANY(?)
              AND lmp.is_active = true
            ORDER BY lmp.id ASC`,
            [clubOwnerIds],
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
            let formats = photo.formats;
            if (typeof formats === "string") {
              try {
                formats = JSON.parse(formats);
              } catch (_) {}
            }
            const photoUrl =
              formats?.small?.url || formats?.thumbnail?.url || photo.url;

            const formattedUrl = formatMediaUrl(photoUrl);
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

        // Map active membership plans by owner ID
        const plansByOwnerId = new Map<number, any[]>();
        for (const p of plansRes?.rows || []) {
          const ownerId = p.club_owner_id;
          if (!ownerId) continue;

          if (!plansByOwnerId.has(ownerId)) {
            plansByOwnerId.set(ownerId, []);
          }

          plansByOwnerId.get(ownerId)!.push({
            documentId: p.document_id,
            planName: p.plan_name,
            price:
              typeof p.price === "string" ? parseFloat(p.price) : p.price,
            monthDuration: p.month_duration,
            isActive: p.is_active,
            validUpto: p.valid_upto || "unlimited",
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
          membershipPlans: plansByOwnerId.get(club.id) || [],
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
