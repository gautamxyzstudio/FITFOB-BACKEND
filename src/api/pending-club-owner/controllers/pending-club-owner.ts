import { Context } from "koa";
import fs from "fs";
import sharp from "sharp";
import axios from "axios";
import bcrypt from "bcryptjs";
import { generateClubId } from "../../../utils/generateClubId";
import {
  normalizeWeekdayScheduling,
  orderWeekdayScheduling,
} from "../../../utils/weekdayScheduling";
import { validateOwnerGovernmentDocument } from "../../../services/aws-owner-document-validator";
import {
  resolveClubServiceIds,
  resolveClubFacilityIds,
} from "../../../utils/resolveClubRelations";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { getOtpEmailTemplate } from "../../../utils/otpEmailTemplate";

const PENDING_UID = "api::pending-club-owner.pending-club-owner";
const GOV_DOC_UID = "api::club-owner-document.club-owner-document";
const CLUB_PHOTO_UID = "api::club-photo.club-photo";
const CLUB_UID = "api::club-owner.club-owner";

const UPLOAD_FOLDER_ID = 2;

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

/* ---------- OPTIMIZE IMAGE & UPDATE TEMP FILE ---------- */
async function prepareAndOptimizeImage(
  rawFile: any,
  maxWidth = 1600,
  quality = 85,
): Promise<Buffer> {
  const filePath = rawFile.filepath || rawFile.path;
  if (!filePath) {
    throw new Error("Temporary file path not found");
  }

  const originalBuffer = await fs.promises.readFile(filePath);

  // If PDF, return original buffer directly (sharp is only for raster images)
  const isPdf =
    rawFile.mimetype === "application/pdf" ||
    (rawFile.originalFilename &&
      rawFile.originalFilename.toLowerCase().endsWith(".pdf")) ||
    originalBuffer.subarray(0, 4).toString() === "%PDF";

  if (isPdf) {
    return originalBuffer;
  }

  try {
    const optimizedBuffer = await sharp(originalBuffer)
      .rotate() // auto-orient based on EXIF
      .resize({
        width: maxWidth,
        height: maxWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: false })
      .toBuffer();

    // Overwrite temp file so Strapi uploads the lightweight optimized image
    await fs.promises.writeFile(filePath, optimizedBuffer);
    rawFile.size = optimizedBuffer.length;
    rawFile.mimetype = "image/jpeg";
    rawFile._skipCompression = true;
    rawFile._optimized = true;

    return optimizedBuffer;
  } catch (err) {
    strapi.log.warn("Image optimization fallback to original buffer:", err);
    return originalBuffer;
  }
}

/* ---------------- BODY PARSER ---------------- */
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

/* ---------- GET FULL USER (DIRECT SQL) ---------- */
async function getFullUser(userId: number) {
  const res = await strapi.db.connection.raw(
    `SELECT 
      id, 
      document_id,
      username, 
      email, 
      phone_number, 
      confirmed, 
      blocked, 
      verification_status
    FROM up_users 
    WHERE id = ? 
    LIMIT 1`,
    [userId],
  );
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    ...row,
    phoneNumber: row.phone_number,
  };
}

/* ---------- MAP DRAFT ROW ---------- */
function mapDraftRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    clubName: row.club_name,
    ownerName: row.owner_name,
    phoneNumber: row.phone_number,
    email: row.email,
    latitude: row.latitude,
    longitude: row.longitude,
    clubAddress: row.club_address,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    currentStep: row.current_step ? Number(row.current_step) : 1,
    status: row.status,
    services: row.services,
    facilities: row.facilities,
    weekdayScheduling: row.weekday_scheduling,
    clubCategory: row.club_category,
    isPhoneVerified: Boolean(row.is_phone_verified),
    isEmailVerified: Boolean(row.is_email_verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

/* ---------- MAP FILE ROW ---------- */
function mapFileRow(row: any) {
  if (!row) return null;
  let parsedFormats = row.formats;
  if (typeof parsedFormats === "string") {
    try {
      parsedFormats = JSON.parse(parsedFormats);
    } catch (_) {}
  }
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    alternativeText: row.alternative_text,
    caption: row.caption,
    width: row.width,
    height: row.height,
    formats: parsedFormats,
    hash: row.hash,
    ext: row.ext,
    mime: row.mime,
    size: row.size ? Number(row.size) : null,
    url: row.url,
    provider: row.provider,
  };
}

/* ---------- MAP DOCS & PHOTOS WITH FILES ---------- */
function mapDocumentsWithFiles(rows: any[]) {
  return rows.map((r: any) => {
    let file = null;
    if (r.file_id) {
      let parsedFormats = r.file_formats;
      if (typeof parsedFormats === "string") {
        try {
          parsedFormats = JSON.parse(parsedFormats);
        } catch (_) {}
      }
      file = {
        id: r.file_id,
        documentId: r.file_document_id,
        name: r.file_name,
        alternativeText: r.file_alternative_text,
        caption: r.file_caption,
        width: r.file_width,
        height: r.file_height,
        formats: parsedFormats,
        hash: r.file_hash,
        ext: r.file_ext,
        mime: r.file_mime,
        size: r.file_size ? Number(r.file_size) : null,
        url: r.file_url,
        provider: r.file_provider,
      };
    }
    return {
      id: r.id,
      documentId: r.document_id,
      documentName: r.document_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      publishedAt: r.published_at,
      File: file,
    };
  });
}

function groupPhotosWithFiles(rows: any[]) {
  const photoMap = new Map<number, any>();
  for (const r of rows) {
    if (!photoMap.has(r.id)) {
      photoMap.set(r.id, {
        id: r.id,
        documentId: r.document_id,
        imageInfo: r.image_info,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        publishedAt: r.published_at,
        images: [],
      });
    }
    if (r.file_id) {
      const photo = photoMap.get(r.id);
      let parsedFormats = r.file_formats;
      if (typeof parsedFormats === "string") {
        try {
          parsedFormats = JSON.parse(parsedFormats);
        } catch (_) {}
      }
      photo.images.push({
        id: r.file_id,
        documentId: r.file_document_id,
        name: r.file_name,
        alternativeText: r.file_alternative_text,
        caption: r.file_caption,
        width: r.file_width,
        height: r.file_height,
        formats: parsedFormats,
        hash: r.file_hash,
        ext: r.file_ext,
        mime: r.file_mime,
        size: r.file_size ? Number(r.file_size) : null,
        url: r.file_url,
        provider: r.file_provider,
      });
    }
  }
  return Array.from(photoMap.values());
}

/* ---------------- GET LATEST DRAFT (DIRECT SQL) ---------------- */
async function getDraftDirect(userId: number, includeLogo = false) {
  const res = await strapi.db.connection.raw(
    `SELECT 
      p.*
    FROM pending_club_owners p
    JOIN up_users_pending_club_owner_lnk lnk ON lnk.pending_club_owner_id = p.id
    WHERE lnk.user_id = ?
    ORDER BY p.id DESC
    LIMIT 1`,
    [userId],
  );

  const rawDraft = res?.rows?.[0];
  if (!rawDraft) return null;

  const draft: any = mapDraftRow(rawDraft);

  if (includeLogo) {
    const logoRes = await strapi.db.connection.raw(
      `SELECT 
        f.*
      FROM files_related_mph frm
      JOIN files f ON f.id = frm.file_id
      WHERE frm.related_id = ? 
        AND frm.related_type = 'api::pending-club-owner.pending-club-owner' 
        AND frm.field = 'logo'
      LIMIT 1`,
      [draft.id],
    );
    draft.logo = logoRes?.rows?.[0] ? mapFileRow(logoRes.rows[0]) : null;
  } else {
    draft.logo = null;
  }

  return draft;
}

async function getDraft(userId: number, includeLogo = false) {
  return getDraftDirect(userId, includeLogo);
}

/* ---------------- EDITABLE DRAFT GUARD (DIRECT SQL) ---------------- */
async function getEditableDraft(ctx: Context, includeLogo = false) {
  const sessionUser = ctx.state.user;

  if (!sessionUser) {
    ctx.unauthorized();
    return null;
  }

  // Combined single query to fetch full user and latest draft
  const res = await strapi.db.connection.raw(
    `SELECT 
      u.id AS user_id, 
      u.document_id AS user_document_id,
      u.username AS user_username, 
      u.email AS user_email, 
      u.phone_number AS user_phone_number, 
      u.confirmed AS user_confirmed, 
      u.blocked AS user_blocked, 
      u.verification_status AS user_verification_status,
      p.id AS draft_id,
      p.document_id,
      p.club_name,
      p.owner_name,
      p.phone_number,
      p.email,
      p.latitude,
      p.longitude,
      p.club_address,
      p.city,
      p.state,
      p.pincode,
      p.current_step,
      p.status,
      p.services,
      p.facilities,
      p.weekday_scheduling,
      p.club_category,
      p.is_phone_verified,
      p.is_email_verified,
      p.created_at,
      p.updated_at,
      p.published_at
    FROM up_users u
    LEFT JOIN up_users_pending_club_owner_lnk lnk ON lnk.user_id = u.id
    LEFT JOIN pending_club_owners p ON p.id = lnk.pending_club_owner_id
    WHERE u.id = ?
    ORDER BY p.id DESC
    LIMIT 1`,
    [sessionUser.id],
  );

  const row = res?.rows?.[0];
  if (!row) {
    ctx.unauthorized("User not found");
    return null;
  }

  const user = {
    id: row.user_id,
    documentId: row.user_document_id,
    username: row.user_username,
    email: row.user_email,
    phoneNumber: row.user_phone_number,
    confirmed: row.user_confirmed,
    blocked: row.user_blocked,
    verification_status: row.user_verification_status,
  };

  let draft: any = null;

  if (row.draft_id) {
    draft = mapDraftRow({
      ...row,
      id: row.draft_id,
    });

    if (includeLogo) {
      const logoRes = await strapi.db.connection.raw(
        `SELECT f.* FROM files_related_mph frm
         JOIN files f ON f.id = frm.file_id
         WHERE frm.related_id = ? 
           AND frm.related_type = 'api::pending-club-owner.pending-club-owner' 
           AND frm.field = 'logo'
         LIMIT 1`,
        [draft.id],
      );
      draft.logo = logoRes?.rows?.[0] ? mapFileRow(logoRes.rows[0]) : null;
    } else {
      draft.logo = null;
    }
  } else {
    const regType = getUserRegistrationType(user);
    const docId = Math.random().toString(36).substring(2, 26);
    const now = new Date();
    const isPhoneVerified = regType === "phone";
    const isEmailVerified = regType === "email";

    const insertRes = await strapi.db.connection.raw(
      `INSERT INTO pending_club_owners (
        document_id,
        current_step,
        status,
        is_phone_verified,
        is_email_verified,
        created_at,
        updated_at,
        published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`,
      [docId, 1, "draft", isPhoneVerified, isEmailVerified, now, now, now],
    );

    const insertedDraft = insertRes.rows[0];

    // Link with user
    await strapi.db.connection.raw(
      `INSERT INTO up_users_pending_club_owner_lnk (
        user_id,
        pending_club_owner_id
      ) VALUES (?, ?)`,
      [user.id, insertedDraft.id],
    );

    draft = mapDraftRow(insertedDraft);
    draft.logo = null;
  }

  if (draft.status === "completed") {
    ctx.badRequest("Your onboarding is already completed.");
    return null;
  }

  draft._user = user;
  return draft;
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

/* ---------- CHECK STEP 1 PHONE / EMAIL VERIFICATION ---------- */
function isPhoneOrEmailVerified(draft: any, user: any): boolean {
  if (!draft?.phoneNumber || !draft?.email || !user) return false;

  const regType = getUserRegistrationType(user);

  if (regType === "email") {
    return Boolean(draft.isPhoneVerified);
  } else {
    return Boolean(draft.isEmailVerified);
  }
}

async function ensureStep1Verified(
  ctx: Context,
  draft: any,
  cachedUser?: any,
): Promise<boolean> {
  const sessionUser = ctx.state.user;
  if (!sessionUser) {
    ctx.unauthorized("Login required");
    return false;
  }

  const user =
    cachedUser || draft?._user || (await getFullUser(sessionUser.id));
  if (!user) {
    ctx.unauthorized("User not found");
    return false;
  }

  if (!isPhoneOrEmailVerified(draft, user)) {
    const regType = getUserRegistrationType(user);
    ctx.badRequest(
      regType === "email"
        ? "Please verify your phone number before proceeding."
        : "Please verify your email address before proceeding.",
    );
    return false;
  }

  return true;
}

/* ---------------- SUBMISSION VALIDATION (DIRECT SQL) ---------------- */
async function validateBeforeSubmission(draft: any, user?: any) {
  if (!draft.clubName || !draft.ownerName)
    return "Please complete owner details";

  if (user && !isPhoneOrEmailVerified(draft, user)) {
    const regType = getUserRegistrationType(user);
    return regType === "email"
      ? "Please verify your phone number in Step 1"
      : "Please verify your email address in Step 1";
  }

  if (!draft.latitude || !draft.longitude) return "Please set map location";

  if (!draft.clubAddress || !draft.city || !draft.state || !draft.pincode)
    return "Please complete address details";

  if (!draft.weekdayScheduling || !draft.clubCategory)
    return "Please configure your club";

  const [docsRes, photosRes] = await Promise.all([
    strapi.db.connection.raw(
      `SELECT lnk.club_owner_document_id 
       FROM club_owner_documents_pending_club_owner_lnk lnk 
       WHERE lnk.pending_club_owner_id = ? 
       LIMIT 1`,
      [draft.id],
    ),
    strapi.db.connection.raw(
      `SELECT lnk.club_photo_id 
       FROM club_photos_pending_club_owner_lnk lnk 
       WHERE lnk.pending_club_owner_id = ? 
       LIMIT 1`,
      [draft.id],
    ),
  ]);

  if (!docsRes.rows || docsRes.rows.length === 0)
    return "Please upload at least one government document";

  if (!photosRes.rows || photosRes.rows.length === 0)
    return "Please upload at least one club photo";

  return null;
}

/* ---------------- MULTI FILE UPLOAD ---------------- */
async function uploadToFolder(file: any) {
  const uploadService = strapi.plugin("upload").service("upload");
  const filesArray = Array.isArray(file) ? file : [file];
  const uploadedFiles: any[] = [];

  for (const f of filesArray) {
    const res = await uploadService.upload({
      data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
      files: f,
    });
    uploadedFiles.push(...res);
  }
  return uploadedFiles;
}

/* ---------------- CREATE CLUB OWNER FROM PENDING DRAFT (DIRECT SQL) ---------------- */
export async function createClubOwnerFromPending(userId: number, existingDraft?: any) {
  const draft: any = existingDraft || (await getDraftDirect(userId, true));
  if (!draft) return null;

  const [existingRes, docsRes, photosRes, newClubId, serviceIds, facilityIds] =
    await Promise.all([
      strapi.db.connection.raw(
        `SELECT c.* 
         FROM club_owners c
         JOIN up_users_club_owner_lnk lnk ON lnk.club_owner_id = c.id
         WHERE lnk.user_id = ?
         LIMIT 1`,
        [userId],
      ),
      strapi.db.connection.raw(
        `SELECT d.id 
         FROM club_owner_documents_pending_club_owner_lnk lnk
         JOIN club_owner_documents d ON d.id = lnk.club_owner_document_id
         WHERE lnk.pending_club_owner_id = ?`,
        [draft.id],
      ),
      strapi.db.connection.raw(
        `SELECT p.id 
         FROM club_photos_pending_club_owner_lnk lnk
         JOIN club_photos p ON p.id = lnk.club_photo_id
         WHERE lnk.pending_club_owner_id = ?`,
        [draft.id],
      ),
      generateClubId(),
      resolveClubServiceIds(
        draft.club_services && draft.club_services.length > 0
          ? draft.club_services
          : draft.services,
      ),
      resolveClubFacilityIds(
        draft.club_facilities && draft.club_facilities.length > 0
          ? draft.club_facilities
          : draft.facilities,
      ),
    ]);

  if (existingRes?.rows?.[0]) return existingRes.rows[0];

  const logoId = draft.logo?.id ?? null;
  const photoIds = (photosRes?.rows || []).map((p: any) => p.id);
  const docIds = (docsRes?.rows || []).map((d: any) => d.id);
  const weekdayScheduling = orderWeekdayScheduling(
    normalizeWeekdayScheduling(draft.weekdayScheduling),
  );

  const clubOwner = await strapi.entityService.create(CLUB_UID, {
    data: {
      user: userId,
      clubId: newClubId,
      ownerName: draft.ownerName,
      phoneNumber: draft.phoneNumber,
      email: draft.email,
      clubName: draft.clubName,
      weekdayScheduling,
      clubCategory: draft.clubCategory,
      facilities: draft.facilities,
      services: draft.services,
      club_services: (serviceIds.length > 0 ? serviceIds : undefined) as any,
      club_facilities: (facilityIds.length > 0
        ? facilityIds
        : undefined) as any,
      latitude: draft.latitude,
      longitude: draft.longitude,
      clubAddress: draft.clubAddress,
      pincode: draft.pincode,
      city: draft.city,
      state: draft.state,
      logo: logoId,
      club_photos: photoIds,
      club_owner_documents: docIds,
      publishedAt: new Date(),
    },
  });

  // Remove pending links in batch
  await strapi.db.connection.raw(
    `DELETE FROM club_owner_documents_pending_club_owner_lnk WHERE pending_club_owner_id = ?;
     DELETE FROM club_photos_pending_club_owner_lnk WHERE pending_club_owner_id = ?;
     DELETE FROM club_services_pending_club_owners_lnk WHERE pending_club_owner_id = ?;
     DELETE FROM pending_club_owners_club_facilities_lnk WHERE pending_club_owner_id = ?;
     DELETE FROM files_related_mph WHERE related_id = ? AND related_type = 'api::pending-club-owner.pending-club-owner';
     DELETE FROM up_users_pending_club_owner_lnk WHERE pending_club_owner_id = ?;
     DELETE FROM pending_club_owners WHERE id = ?;`,
    [draft.id, draft.id, draft.id, draft.id, draft.id, draft.id, draft.id],
  );

  return clubOwner;
}

export default {
  /* ===================================================== */
  async me(ctx: Context) {
    try {
      const sessionUser = ctx.state.user;

      if (!sessionUser) {
        return ctx.unauthorized("Login required");
      }

      const user = await getFullUser(sessionUser.id);
      if (!user) {
        return ctx.unauthorized("User not found");
      }

      /* ================= CHECK PENDING CLUB OWNER ================= */
      const draft: any = await getDraftDirect(user.id);

      /* ================= PENDING CLUB OWNER EXISTS ================= */
      if (draft) {
        if (draft.weekdayScheduling) {
          draft.weekdayScheduling = orderWeekdayScheduling(
            draft.weekdayScheduling,
          );
        }

        const [docsRes, photosRes] = await Promise.all([
          strapi.db.connection.raw(
            `SELECT 
              d.id,
              d.document_id,
              d.document_name,
              d.created_at,
              d.updated_at,
              d.published_at,
              f.id AS file_id,
              f.document_id AS file_document_id,
              f.name AS file_name,
              f.alternative_text AS file_alternative_text,
              f.caption AS file_caption,
              f.width AS file_width,
              f.height AS file_height,
              f.formats AS file_formats,
              f.hash AS file_hash,
              f.ext AS file_ext,
              f.mime AS file_mime,
              f.size AS file_size,
              f.url AS file_url,
              f.provider AS file_provider
            FROM club_owner_documents_pending_club_owner_lnk lnk
            JOIN club_owner_documents d ON d.id = lnk.club_owner_document_id
            LEFT JOIN files_related_mph frm ON frm.related_id = d.id 
              AND frm.related_type = 'api::club-owner-document.club-owner-document' 
              AND frm.field = 'File'
            LEFT JOIN files f ON f.id = frm.file_id
            WHERE lnk.pending_club_owner_id = ?
            ORDER BY d.created_at DESC`,
            [draft.id],
          ),
          strapi.db.connection.raw(
            `SELECT 
              p.id,
              p.document_id,
              p.image_info,
              p.created_at,
              p.updated_at,
              p.published_at,
              f.id AS file_id,
              f.document_id AS file_document_id,
              f.name AS file_name,
              f.alternative_text AS file_alternative_text,
              f.caption AS file_caption,
              f.width AS file_width,
              f.height AS file_height,
              f.formats AS file_formats,
              f.hash AS file_hash,
              f.ext AS file_ext,
              f.mime AS file_mime,
              f.size AS file_size,
              f.url AS file_url,
              f.provider AS file_provider
            FROM club_photos_pending_club_owner_lnk lnk
            JOIN club_photos p ON p.id = lnk.club_photo_id
            LEFT JOIN files_related_mph frm ON frm.related_id = p.id 
              AND frm.related_type = 'api::club-photo.club-photo' 
              AND frm.field = 'images'
            LEFT JOIN files f ON f.id = frm.file_id
            WHERE lnk.pending_club_owner_id = ?
            ORDER BY p.created_at DESC`,
            [draft.id],
          ),
        ]);

        const docs = mapDocumentsWithFiles(docsRes?.rows || []);
        const photos = groupPhotosWithFiles(photosRes?.rows || []);

        draft.user = user;
        draft.club_owner_documents = docs;
        draft.club_photos = photos;
        draft.clubPhotos = photos;

        return ctx.send({
          currentStep: draft.currentStep,
          status: user.verification_status,
          details: draft,
        });
      }

      /* ================= DOES NOT EXIST ================= */
      return ctx.send({
        currentStep: 1,
        status: "draft",
      });
    } catch (error) {
      strapi.log.error("Error fetching club owner onboarding details:", error);

      return ctx.internalServerError(
        "Failed to fetch club owner onboarding details",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1 — CLUB + OWNER + LOGO */
  async clubOwnerDetails(ctx: Context) {
    try {
      const files: any = ctx.request.files;
      const draft: any = await getEditableDraft(ctx, Boolean(files?.logo));
      if (!draft) return;

      const user = draft._user;
      if (!user) {
        return ctx.unauthorized("User not found");
      }

      const body = getBody(ctx);

      if (!body.clubName || !body.ownerName) {
        return ctx.badRequest("Club name and Owner name are required");
      }

      if (!body.phoneNumber || !body.email) {
        return ctx.badRequest("Phone number and Email are required");
      }

      const submittedPhone = normalizePhone(String(body.phoneNumber).trim());
      const submittedEmail = String(body.email).trim().toLowerCase();

      // Check user registration identifier type:
      const regType = getUserRegistrationType(user);

      // Verify that the required identifier was verified via OTP endpoint
      if (regType === "email") {
        const isPhoneVerified =
          Boolean(draft.isPhoneVerified) &&
          normalizePhone(draft.phoneNumber || "") === submittedPhone;

        if (!isPhoneVerified) {
          return ctx.badRequest(
            "Please verify your phone number via OTP first before submitting club owner details.",
          );
        }
      } else {
        const isEmailVerified =
          Boolean(draft.isEmailVerified) &&
          (draft.email || "").toLowerCase() === submittedEmail;

        if (!isEmailVerified) {
          return ctx.badRequest(
            "Please verify your email address via OTP first before submitting club owner details.",
          );
        }
      }

      let logoId = draft.logo?.id ?? null;

      if (files?.logo) {
        if (draft.logo) {
          // Remove old logo asynchronously in background
          strapi
            .plugin("upload")
            .service("upload")
            .remove(draft.logo)
            .catch((e: any) =>
              strapi.log.warn("Failed to remove old logo in background:", e),
            );
        }
        await prepareAndOptimizeImage(files.logo, 1600, 85);
        const uploaded = await uploadToFolder(files.logo);
        logoId = uploaded[0].id;

        // Manage files_related_mph and draft update concurrently
        const pLogo = (async () => {
          await strapi.db.connection.raw(
            `DELETE FROM files_related_mph 
             WHERE related_id = ? 
               AND related_type = 'api::pending-club-owner.pending-club-owner' 
               AND field = 'logo'`,
            [draft.id],
          );
          await strapi.db.connection.raw(
            `INSERT INTO files_related_mph (
              file_id, related_id, related_type, field, "order"
            ) VALUES (?, ?, 'api::pending-club-owner.pending-club-owner', 'logo', 1)`,
            [logoId, draft.id],
          );
        })();

        const pDraft = strapi.db.connection.raw(
          `UPDATE pending_club_owners
           SET club_name = ?,
               owner_name = ?,
               phone_number = ?,
               email = ?,
               is_phone_verified = true,
               is_email_verified = true,
               current_step = GREATEST(COALESCE(current_step, 1), 2),
               updated_at = NOW()
           WHERE id = ?`,
          [
            body.clubName,
            body.ownerName,
            submittedPhone,
            submittedEmail,
            draft.id,
          ],
        );

        await Promise.all([pLogo, pDraft]);
      } else {
        await strapi.db.connection.raw(
          `UPDATE pending_club_owners
           SET club_name = ?,
               owner_name = ?,
               phone_number = ?,
               email = ?,
               is_phone_verified = true,
               is_email_verified = true,
               current_step = GREATEST(COALESCE(current_step, 1), 2),
               updated_at = NOW()
           WHERE id = ?`,
          [
            body.clubName,
            body.ownerName,
            submittedPhone,
            submittedEmail,
            draft.id,
          ],
        );
      }

      return ctx.send({
        nextStep: 2,
        message: "Club owner details saved successfully.",
      });
    } catch (err: any) {
      strapi.log.error("CLUB OWNER DETAILS ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to update club owner details",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1A — SEND OTP FOR PHONE / EMAIL */
  async sendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user;
      if (!user) return ctx.unauthorized("User not found");

      const regType = getUserRegistrationType(user);
      const body = getBody(ctx);
      let rawIdentifier =
        body.identifier ||
        (regType === "email" ? body.phoneNumber : body.email) ||
        body.phoneNumber ||
        body.email ||
        null;

      if (!rawIdentifier) {
        if (regType === "email") {
          rawIdentifier = draft.phoneNumber;
        } else {
          rawIdentifier = draft.email;
        }
      }

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
          "Your email address is already verified from signup. Please provide and verify your phone number.",
        );
      }

      if (regType === "phone" && !isEmail) {
        return ctx.badRequest(
          "Your phone number is already verified from signup. Please provide and verify your email address.",
        );
      }

      const identifier = isEmail
        ? String(rawIdentifier).trim().toLowerCase()
        : normalizePhone(String(rawIdentifier).trim());

      // Check if email or phone is already attached with another club in club_owners
      if (isEmail) {
        const existingClubRes = await strapi.db.connection.raw(
          `SELECT id FROM club_owners WHERE LOWER(TRIM(email)) = LOWER(?) LIMIT 1`,
          [identifier],
        );

        if (existingClubRes?.rows?.length > 0) {
          return ctx.badRequest(
            "This email is already attached with another club.",
          );
        }
      } else {
        const cleanDigits = identifier.replace(/\D/g, "");
        const raw10 = cleanDigits.slice(-10);
        const phoneVariants = Array.from(
          new Set(
            [
              identifier,
              cleanDigits,
              `+91${raw10}`,
              `91${raw10}`,
              raw10,
            ].filter(Boolean),
          ),
        );

        const existingClubRes = await strapi.db.connection.raw(
          `SELECT id FROM club_owners 
           WHERE REPLACE(REPLACE(phone_number, ' ', ''), '-', '') = ANY(?) 
              OR phone_number = ANY(?) 
           LIMIT 1`,
          [phoneVariants, phoneVariants],
        );

        if (existingClubRes?.rows?.length > 0) {
          return ctx.badRequest(
            "This phone number is already attached with another club.",
          );
        }
      }

      // Save identifier to draft so draft stays in sync via direct SQL
      if (isEmail) {
        await strapi.db.connection.raw(
          `UPDATE pending_club_owners 
           SET email = ?, 
               is_email_verified = CASE WHEN email = ? THEN is_email_verified ELSE false END,
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, identifier, draft.id],
        );
      } else {
        await strapi.db.connection.raw(
          `UPDATE pending_club_owners 
           SET phone_number = ?, 
               is_phone_verified = CASE WHEN phone_number = ? THEN is_phone_verified ELSE false END,
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, identifier, draft.id],
        );
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
                  "Use the One-Time Password (OTP) below to verify your email address for club owner onboarding:",
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
          success: true,
          verificationType: "phone",
          identifier,
          message: "OTP sent to your phone number to verify.",
        });
      }
    } catch (err: any) {
      strapi.log.error("SEND DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to send details OTP",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1B — VERIFY OTP FOR PHONE / EMAIL */
  async verifyDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user;
      if (!user) return ctx.unauthorized("User not found");

      const body = getBody(ctx);
      const otp = String(body.otp || "").trim();

      if (!otp) {
        return ctx.badRequest("OTP is required");
      }

      const regType = getUserRegistrationType(user);
      const rawIdentifier =
        body.identifier ||
        (regType === "email" ? body.phoneNumber : body.email) ||
        body.phoneNumber ||
        body.email ||
        null;
      let identifier = rawIdentifier ? String(rawIdentifier).trim() : null;

      if (!identifier) {
        if (regType === "email") {
          identifier = draft.phoneNumber;
        } else {
          identifier = draft.email;
        }
      }

      if (!identifier) {
        return ctx.badRequest(
          regType === "email"
            ? "Phone number is required to verify OTP"
            : "Email address is required to verify OTP",
        );
      }

      const isEmail = identifier.includes("@");

      if (regType === "email" && isEmail) {
        return ctx.badRequest(
          "Your email address is already verified from signup. Please verify your phone number.",
        );
      }

      if (regType === "phone" && !isEmail) {
        return ctx.badRequest(
          "Your phone number is already verified from signup. Please verify your email address.",
        );
      }

      identifier = isEmail
        ? identifier.toLowerCase()
        : normalizePhone(identifier);

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

      const hasCompletedStep1Details = Boolean(
        draft.clubName && draft.ownerName,
      );

      const nextStepVal = hasCompletedStep1Details
        ? Math.max(draft.currentStep || 1, 2)
        : draft.currentStep || 1;

      if (isEmail) {
        await strapi.db.connection.raw(
          `UPDATE pending_club_owners 
           SET is_email_verified = true, 
               email = ?, 
               current_step = ?, 
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, nextStepVal, draft.id],
        );
      } else {
        await strapi.db.connection.raw(
          `UPDATE pending_club_owners 
           SET is_phone_verified = true, 
               phone_number = ?, 
               current_step = ?, 
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, nextStepVal, draft.id],
        );
      }

      return ctx.send({
        verified: true,
        verificationType: isEmail ? "email" : "phone",
        identifier,
        nextStep: hasCompletedStep1Details ? 2 : 1,
      });
    } catch (err: any) {
      strapi.log.error("VERIFY DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to verify details OTP",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1C — RESEND OTP FOR PHONE / EMAIL */
  async resendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user;
      if (!user) return ctx.unauthorized("User not found");

      const regType = getUserRegistrationType(user);
      const body = getBody(ctx);
      const rawIdentifier =
        body.identifier ||
        (regType === "email" ? body.phoneNumber : body.email) ||
        body.phoneNumber ||
        body.email ||
        null;
      let identifier = rawIdentifier ? String(rawIdentifier).trim() : null;

      if (!identifier) {
        if (regType === "email") {
          identifier = draft.phoneNumber;
        } else {
          identifier = draft.email;
        }
      }

      if (!identifier) {
        return ctx.badRequest(
          regType === "email"
            ? "Phone number is required to resend OTP"
            : "Email address is required to resend OTP",
        );
      }

      const isEmail = identifier.includes("@");

      if (regType === "email" && isEmail) {
        return ctx.badRequest(
          "Your email address is already verified from signup. Please provide your phone number to resend OTP.",
        );
      }

      if (regType === "phone" && !isEmail) {
        return ctx.badRequest(
          "Your phone number is already verified from signup. Please provide your email address to resend OTP.",
        );
      }
      identifier = isEmail
        ? identifier.toLowerCase()
        : normalizePhone(identifier);

      // Check if email or phone is already attached with another club in club_owners
      if (isEmail) {
        const existingClubRes = await strapi.db.connection.raw(
          `SELECT id FROM club_owners WHERE LOWER(TRIM(email)) = LOWER(?) LIMIT 1`,
          [identifier],
        );

        if (existingClubRes?.rows?.length > 0) {
          return ctx.badRequest(
            "This email is already attached with another club.",
          );
        }
      } else {
        const cleanDigits = identifier.replace(/\D/g, "");
        const raw10 = cleanDigits.slice(-10);
        const phoneVariants = Array.from(
          new Set(
            [
              identifier,
              cleanDigits,
              `+91${raw10}`,
              `91${raw10}`,
              raw10,
            ].filter(Boolean),
          ),
        );

        const existingClubRes = await strapi.db.connection.raw(
          `SELECT id FROM club_owners 
           WHERE REPLACE(REPLACE(phone_number, ' ', ''), '-', '') = ANY(?) 
              OR phone_number = ANY(?) 
           LIMIT 1`,
          [phoneVariants, phoneVariants],
        );

        if (existingClubRes?.rows?.length > 0) {
          return ctx.badRequest(
            "This phone number is already attached with another club.",
          );
        }
      }

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
                  "Here is your requested One-Time Password (OTP) to verify your email address:",
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
        success: true,
        message: "OTP resent successfully",
        identifier,
      });
    } catch (err: any) {
      strapi.log.error("RESEND DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to resend details OTP",
      );
    }
  },

  /* ===================================================== */
  async mapLocation(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);

    await strapi.db.connection.raw(
      `UPDATE pending_club_owners 
       SET latitude = ?, 
           longitude = ?, 
           current_step = GREATEST(COALESCE(current_step, 1), 3),
           updated_at = NOW() 
       WHERE id = ?`,
      [body.latitude, body.longitude, draft.id],
    );

    ctx.send({ nextStep: 3 });
  },

  /* ===================================================== */
  async addressDetails(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);

    await strapi.db.connection.raw(
      `UPDATE pending_club_owners 
       SET club_address = ?, 
           city = ?, 
           state = ?, 
           pincode = ?, 
           current_step = GREATEST(COALESCE(current_step, 1), 4),
           updated_at = NOW() 
       WHERE id = ?`,
      [body.clubAddress, body.city, body.state, body.pincode, draft.id],
    );

    ctx.send({ nextStep: 4 });
  },

  /* ===================================================== */
  async configureClub(ctx: Context) {
    const draft: any = await getEditableDraft(ctx, false);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);
    const allowedCategories = ["Basic", "Premium", "Luxury"];
    if (!allowedCategories.includes(body.clubCategory))
      return ctx.badRequest("Invalid club category");

    const [serviceIds, facilityIds] = await Promise.all([
      resolveClubServiceIds(body.club_services || body.services),
      resolveClubFacilityIds(body.club_facilities || body.facilities),
    ]);

    const normScheduling = normalizeWeekdayScheduling(body.weekdayScheduling);

    // 1. Update pending draft
    const pUpdate = strapi.db.connection.raw(
      `UPDATE pending_club_owners 
       SET services = ?::jsonb, 
           facilities = ?::jsonb, 
           weekday_scheduling = ?::jsonb, 
           club_category = ?, 
           current_step = GREATEST(COALESCE(current_step, 1), 5), 
           updated_at = NOW() 
       WHERE id = ?`,
      [
        JSON.stringify(body.services || null),
        JSON.stringify(body.facilities || null),
        JSON.stringify(normScheduling || null),
        body.clubCategory,
        draft.id,
      ],
    );

    // 2. Services batch link
    const pServices = (async () => {
      if (
        serviceIds.length > 0 ||
        Array.isArray(body.services) ||
        Array.isArray(body.club_services)
      ) {
        await strapi.db.connection.raw(
          `DELETE FROM club_services_pending_club_owners_lnk WHERE pending_club_owner_id = ?`,
          [draft.id],
        );
        if (serviceIds.length > 0) {
          const placeholders = serviceIds.map(() => `(?, ?, ?, ?)`).join(", ");
          const params: any[] = [];
          serviceIds.forEach((sid: number, i: number) => {
            params.push(sid, draft.id, i + 1, i + 1);
          });
          await strapi.db.connection.raw(
            `INSERT INTO club_services_pending_club_owners_lnk (
              club_service_id, pending_club_owner_id, pending_club_owner_ord, club_service_ord
            ) VALUES ${placeholders}`,
            params,
          );
        }
      }
    })();

    // 3. Facilities batch link
    const pFacilities = (async () => {
      if (
        facilityIds.length > 0 ||
        Array.isArray(body.facilities) ||
        Array.isArray(body.club_facilities)
      ) {
        await strapi.db.connection.raw(
          `DELETE FROM pending_club_owners_club_facilities_lnk WHERE pending_club_owner_id = ?`,
          [draft.id],
        );
        if (facilityIds.length > 0) {
          const placeholders = facilityIds.map(() => `(?, ?, ?, ?)`).join(", ");
          const params: any[] = [];
          facilityIds.forEach((fid: number, i: number) => {
            params.push(draft.id, fid, i + 1, i + 1);
          });
          await strapi.db.connection.raw(
            `INSERT INTO pending_club_owners_club_facilities_lnk (
              pending_club_owner_id, club_facility_id, club_facility_ord, pending_club_owner_ord
            ) VALUES ${placeholders}`,
            params,
          );
        }
      }
    })();

    await Promise.all([pUpdate, pServices, pFacilities]);

    ctx.send({ nextStep: 5 });
  },

  /* ===================================================== */
  /* STEP 5A — VERIFY GOVERNMENT DOCUMENT AUTHENTICITY */
  async verifyGovernmentDoc(ctx: Context) {
    const draft: any = await getEditableDraft(ctx, false);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const files: any = ctx.request.files;
    const rawFile = files?.file || files?.governmentDoc || files?.governmentId;

    if (!rawFile) {
      return ctx.badRequest("Please upload a government document to verify");
    }

    const targetFile = Array.isArray(rawFile) ? rawFile[0] : rawFile;

    try {
      const buffer = await prepareAndOptimizeImage(targetFile, 1600, 85);
      const documentResult = await validateOwnerGovernmentDocument(buffer);

      if (!documentResult.valid) {
        return ctx.badRequest(
          "Please upload a valid document (Aadhaar, PAN, Voter ID, Driving License, Passport, GST Certificate, Bank Statement/Cheque, or Udyam/MSME Registration Certificate).",
        );
      }

      return ctx.send({
        valid: true,
        documentType: documentResult.documentType,
        displayName: documentResult.displayName,
        message: "Government document verified successfully.",
      });
    } catch (error) {
      strapi.log.error("Government document verification error:", error);
      return ctx.internalServerError("Unable to validate government document.");
    }
  },

  /* ===================================================== */
  async uploadGovernmentDoc(ctx: Context) {
    const draft: any = await getEditableDraft(ctx, false);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);
    const file = (ctx.request.files as any)?.file;

    if (!file) return ctx.badRequest("Please upload document");
    if (!body.documentName) return ctx.badRequest("Document name required");

    /* ---------- CHECK IF SAME DOCUMENT ALREADY EXISTS ---------- */
    const existingRes = await strapi.db.connection.raw(
      `SELECT 
        d.id,
        d.document_id,
        f.id AS file_id,
        f.url AS file_url,
        f.provider,
        f.hash,
        f.ext,
        f.mime
      FROM club_owner_documents_pending_club_owner_lnk lnk
      JOIN club_owner_documents d ON d.id = lnk.club_owner_document_id
      LEFT JOIN files_related_mph frm ON frm.related_id = d.id 
        AND frm.related_type = 'api::club-owner-document.club-owner-document' 
        AND frm.field = 'File'
      LEFT JOIN files f ON f.id = frm.file_id
      WHERE lnk.pending_club_owner_id = ? AND d.document_name = ?
      LIMIT 1`,
      [draft.id, body.documentName],
    );

    const existingDoc = existingRes?.rows?.[0];

    /* ---------- UPLOAD NEW FILE ---------- */
    await prepareAndOptimizeImage(file, 1600, 85);
    const uploaded = await uploadToFolder(file);
    const fileId = uploaded[0].id;

    /* ---------- REPLACE OR CREATE ---------- */
    if (existingDoc) {
      // remove old file from server in background
      if (existingDoc.file_id) {
        strapi
          .plugin("upload")
          .service("upload")
          .remove({
            id: existingDoc.file_id,
            provider: existingDoc.provider,
            url: existingDoc.file_url,
            hash: existingDoc.hash,
            ext: existingDoc.ext,
            mime: existingDoc.mime,
          })
          .catch((e: any) =>
            strapi.log.warn("Failed to remove old doc file in background:", e),
          );
      }

      // update existing DB record relation in files_related_mph
      const pLnk = (async () => {
        await strapi.db.connection.raw(
          `DELETE FROM files_related_mph 
           WHERE related_id = ? 
             AND related_type = 'api::club-owner-document.club-owner-document' 
             AND field = 'File'`,
          [existingDoc.id],
        );
        await strapi.db.connection.raw(
          `INSERT INTO files_related_mph (
            file_id, related_id, related_type, field, "order"
          ) VALUES (?, ?, 'api::club-owner-document.club-owner-document', 'File', 1)`,
          [fileId, existingDoc.id],
        );
      })();

      const pDoc = strapi.db.connection.raw(
        `UPDATE club_owner_documents SET updated_at = NOW() WHERE id = ?`,
        [existingDoc.id],
      );

      await Promise.all([pLnk, pDoc]);

      ctx.send({ message: "Document replaced" });
    } else {
      // create first time
      const docId = Math.random().toString(36).substring(2, 26);
      const insertRes = await strapi.db.connection.raw(
        `INSERT INTO club_owner_documents (
          document_id, document_name, created_at, updated_at, published_at
        ) VALUES (?, ?, NOW(), NOW(), NOW())
        RETURNING id`,
        [docId, body.documentName],
      );
      const newDocId = insertRes.rows[0].id;

      await Promise.all([
        strapi.db.connection.raw(
          `INSERT INTO club_owner_documents_pending_club_owner_lnk (
            club_owner_document_id, pending_club_owner_id, club_owner_document_ord
          ) VALUES (?, ?, 1)`,
          [newDocId, draft.id],
        ),
        strapi.db.connection.raw(
          `INSERT INTO files_related_mph (
            file_id, related_id, related_type, field, "order"
          ) VALUES (?, ?, 'api::club-owner-document.club-owner-document', 'File', 1)`,
          [fileId, newDocId],
        ),
      ]);

      ctx.send({ message: "Document uploaded" });
    }
  },

  async getMyDocuments(ctx: Context) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized();
    }

    const draft: any = await getDraftDirect(user.id);
    if (!draft) {
      return ctx.send({ data: [] });
    }

    const docsRes = await strapi.db.connection.raw(
      `SELECT 
        d.document_id,
        d.document_name,
        d.created_at,
        f.url AS file_url
      FROM club_owner_documents_pending_club_owner_lnk lnk
      JOIN club_owner_documents d ON d.id = lnk.club_owner_document_id
      LEFT JOIN files_related_mph frm ON frm.related_id = d.id 
        AND frm.related_type = 'api::club-owner-document.club-owner-document' 
        AND frm.field = 'File'
      LEFT JOIN files f ON f.id = frm.file_id
      WHERE lnk.pending_club_owner_id = ?
      ORDER BY d.created_at DESC`,
      [draft.id],
    );

    const response = (docsRes?.rows || []).map((d: any) => ({
      documentId: d.document_id,
      name: d.document_name,
      uploadedAt: d.created_at,
      fileUrl: d.file_url
        ? d.file_url.startsWith("http")
          ? d.file_url
          : `${strapi.config.server.url}${d.file_url}`
        : null,
    }));

    ctx.send({ data: response });
  },

  /* ===================================================== */
  async confirmGovernmentDocs(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    await strapi.db.connection.raw(
      `UPDATE pending_club_owners 
       SET current_step = GREATEST(COALESCE(current_step, 1), 6),
           updated_at = NOW() 
       WHERE id = ?`,
      [draft.id],
    );

    ctx.send({ nextStep: 6 });
  },

  /* ===================================================== */
  /* STEP 6A — UPLOAD SINGLE CLUB PHOTO WITH TEXT (CAN CALL MULTIPLE TIMES) */
  async uploadClubPhoto(ctx: Context) {
    const draft: any = await getEditableDraft(ctx, false);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);
    const files: any = ctx.request.files;

    const photoFile =
      files?.image ||
      files?.club_photos ||
      files?.clubPhotos ||
      files?.images ||
      files?.file ||
      files?.photo;

    if (!photoFile) return ctx.badRequest("Please upload a club photo");

    await prepareAndOptimizeImage(photoFile, 1600, 85);
    const uploadedPhotos = await uploadToFolder(photoFile);
    const photoIds = uploadedPhotos.map((f: any) => f.id);

    const docId = Math.random().toString(36).substring(2, 26);
    const imageInfo = body.imageInfo || body.description || "";

    const insertRes = await strapi.db.connection.raw(
      `INSERT INTO club_photos (
        document_id, image_info, created_at, updated_at, published_at
      ) VALUES (?, ?, NOW(), NOW(), NOW())
      RETURNING id, document_id, image_info, created_at`,
      [docId, imageInfo],
    );

    const newPhoto = insertRes.rows[0];

    const pLink = strapi.db.connection.raw(
      `INSERT INTO club_photos_pending_club_owner_lnk (
        club_photo_id, pending_club_owner_id, club_photo_ord
      ) VALUES (?, ?, 1)`,
      [newPhoto.id, draft.id],
    );

    const pFiles = (async () => {
      if (photoIds.length > 0) {
        const placeholders = photoIds
          .map(() => `(?, ?, 'api::club-photo.club-photo', 'images', ?)`)
          .join(", ");
        const params: any[] = [];
        photoIds.forEach((pid: number, i: number) => {
          params.push(pid, newPhoto.id, i + 1);
        });
        await strapi.db.connection.raw(
          `INSERT INTO files_related_mph (
            file_id, related_id, related_type, field, "order"
          ) VALUES ${placeholders}`,
          params,
        );
      }
    })();

    await Promise.all([pLink, pFiles]);

    const firstImg = uploadedPhotos[0];
    const fileUrl = firstImg?.url
      ? firstImg.url.startsWith("http")
        ? firstImg.url
        : `${strapi.config.server.url}${firstImg.url}`
      : null;

    ctx.send({
      success: true,
      message: "Club photo uploaded successfully",
      photo: {
        id: newPhoto.id,
        documentId: newPhoto.document_id,
        imageInfo: newPhoto.image_info,
        fileUrl,
        images: uploadedPhotos,
      },
    });
  },

  /* ===================================================== */
  /* STEP 6B — GET MY UPLOADED CLUB PHOTOS */
  async getMyClubPhotos(ctx: Context) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized();
    }

    const draft: any = await getDraftDirect(user.id);
    if (!draft) {
      return ctx.send({ data: [] });
    }

    const photosRes = await strapi.db.connection.raw(
      `SELECT 
        p.id,
        p.document_id,
        p.image_info,
        p.created_at,
        f.url AS file_url
      FROM club_photos_pending_club_owner_lnk lnk
      JOIN club_photos p ON p.id = lnk.club_photo_id
      LEFT JOIN files_related_mph frm ON frm.related_id = p.id 
        AND frm.related_type = 'api::club-photo.club-photo' 
        AND frm.field = 'images'
      LEFT JOIN files f ON f.id = frm.file_id
      WHERE lnk.pending_club_owner_id = ?
      ORDER BY p.created_at DESC`,
      [draft.id],
    );

    const response = (photosRes?.rows || []).map((p: any) => ({
      id: p.id,
      documentId: p.document_id,
      imageInfo: p.image_info,
      uploadedAt: p.created_at,
      fileUrl: p.file_url
        ? p.file_url.startsWith("http")
          ? p.file_url
          : `${strapi.config.server.url}${p.file_url}`
        : null,
    }));

    ctx.send({ data: response });
  },

  /* ===================================================== */
  /* STEP 6C — DELETE CLUB PHOTO BY DOCUMENTID */
  async deleteClubPhoto(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    const { id } = ctx.params;
    if (!id) return ctx.badRequest("Photo documentId is required");

    const numId = isNaN(Number(id)) ? -1 : Number(id);

    const photosRes = await strapi.db.connection.raw(
      `SELECT 
        p.id,
        p.document_id,
        f.id AS file_id,
        f.provider,
        f.url,
        f.hash,
        f.ext,
        f.mime
      FROM club_photos p
      JOIN club_photos_pending_club_owner_lnk lnk ON lnk.club_photo_id = p.id
      LEFT JOIN files_related_mph frm ON frm.related_id = p.id 
        AND frm.related_type = 'api::club-photo.club-photo' 
        AND frm.field = 'images'
      LEFT JOIN files f ON f.id = frm.file_id
      WHERE lnk.pending_club_owner_id = ? 
        AND (p.document_id = ? OR p.id = ?)`,
      [draft.id, String(id), numId],
    );

    const rows = photosRes?.rows || [];
    if (rows.length === 0) {
      return ctx.notFound("Club photo not found");
    }

    const photoId = rows[0].id;
    const fileObjs = rows
      .filter((r: any) => r.file_id)
      .map((r: any) => ({
        id: r.file_id,
        provider: r.provider,
        url: r.url,
        hash: r.hash,
        ext: r.ext,
        mime: r.mime,
      }));

    // Non-blocking file removal
    if (fileObjs.length > 0) {
      (async () => {
        for (const fileObj of fileObjs) {
          try {
            await strapi.plugin("upload").service("upload").remove(fileObj);
          } catch (e) {
            strapi.log.warn(
              "Failed to remove club photo file in background:",
              e,
            );
          }
        }
      })();
    }

    await strapi.db.connection.raw(
      `DELETE FROM club_photos_pending_club_owner_lnk WHERE club_photo_id = ?`,
      [photoId],
    );
    await strapi.db.connection.raw(
      `DELETE FROM files_related_mph WHERE related_id = ? AND related_type = 'api::club-photo.club-photo'`,
      [photoId],
    );
    await strapi.db.connection.raw(
      `DELETE FROM club_photos WHERE id = ?`,
      [photoId],
    );

    ctx.send({ success: true, message: "Club photo deleted successfully" });
  },

  /* ===================================================== */
  /* STEP 6 FINAL — CONFIRM ONBOARDING & SEND FOR APPROVAL */
  async uploadClubPhotos(ctx: Context) {
    const draft: any = await getEditableDraft(ctx, true);
    if (!draft) return;

    const fullUser = draft._user;

    const validationError = await validateBeforeSubmission(draft, fullUser);
    if (validationError) return ctx.badRequest(validationError);

    await strapi.db.connection.raw(
      `UPDATE pending_club_owners 
       SET status = 'completed', 
           current_step = 6, 
           updated_at = NOW() 
       WHERE id = ?`,
      [draft.id],
    );

    if (fullUser?.verification_status === "approved") {
      const clubOwner = await createClubOwnerFromPending(fullUser.id, draft);
      return ctx.send({
        success: true,
        message: "Club Owner profile created successfully",
        clubOwner,
      });
    }

    if (fullUser?.verification_status === "rejected") {
      await strapi.db.connection.raw(
        `UPDATE up_users 
         SET verification_status = 'pending', 
             rejection_reason = NULL, 
             rejected_by = NULL, 
             updated_at = NOW() 
         WHERE id = ?`,
        [fullUser.id],
      );
    }

    ctx.send({
      success: true,
      message:
        "Club Owner onboarding details submitted. Awaiting verification approval.",
    });
  },

  async unverified(ctx: Context) {
    try {
      const { search, status } = ctx.query as any;

      const targetStatus =
        !status || status === "undefined" || status === "null"
          ? "pending"
          : String(status).trim().toLowerCase();

      const filters: any = {};
      if (targetStatus !== "all") {
        filters.user = { verification_status: targetStatus };
      }

      if (search?.trim()) {
        filters.$or = [
          { ownerName: { $containsi: search.trim() } },
          { clubName: { $containsi: search.trim() } },
        ];
      }

      const data: any[] = await strapi.entityService.findMany(
        "api::pending-club-owner.pending-club-owner",
        {
          populate: {
            logo: true,
            user: true,
          },
          filters,
          sort: { id: "desc" },
        },
      );

      const dataWithCurrentStep = data.map((item: any) => {
        return {
          id: item.id,
          documentId: item.documentId,
          currentStep: item.currentStep,
          ownerName: item.ownerName,
          clubName: item.clubName,
          logo: item.logo?.formats?.thumbnail?.url || item.logo?.url || null,
          createdAt: item.createdAt,
          clubAddress: item.clubAddress,
          city: item.city,
          state: item.state,
          user: {
            verification_status: item.user?.verification_status || null,
          },
          pincode: item.pincode,
        };
      });

      let finalData = dataWithCurrentStep;

      // 🔍 Filter by status in memory (ensures accuracy even if relation filtering is skipped by ORM)
      if (targetStatus !== "all") {
        finalData = finalData.filter((item: any) => {
          const itemStatus = (
            item.user?.verification_status || "pending"
          ).toLowerCase();
          return itemStatus === targetStatus;
        });
      }

      // 🔍 Global search (ownerName + clubName)
      if (search?.trim()) {
        const searchValue = search.replace(/\s+/g, "").toLowerCase();

        finalData = finalData.filter((item: any) => {
          const owner = item.ownerName?.replace(/\s+/g, "").toLowerCase();
          const club = item.clubName?.replace(/\s+/g, "").toLowerCase();

          return owner?.includes(searchValue) || club?.includes(searchValue);
        });
      }

      ctx.body = finalData;
    } catch (err) {
      strapi.log.error("FETCH UNVERIFIED CLUB OWNERS ERROR:", err);
      return ctx.internalServerError("Failed to fetch unverified club owners");
    }
  },

  /* =======================================================
         GET SINGLE PENDING CLUB OWNER 
      ======================================================= */
  async findOne(ctx: Context) {
    try {
      const { id } = ctx.params;

      if (!id || isNaN(Number(id))) {
        return ctx.badRequest(
          "Valid numeric pending club owner ID is required",
        );
      }

      const entity: any = await strapi.entityService.findOne(
        "api::pending-club-owner.pending-club-owner",
        id,
        {
          populate: {
            logo: true,
            user: true,
            club_owner_documents: {
              populate: {
                File: {
                  fields: [
                    "url",
                    "width",
                    "height",
                    "size",
                    "formats",
                    "ext",
                    "name",
                    "mime",
                    "createdAt",
                  ],
                },
              },
              fields: ["documentName", "createdAt", "publishedAt"],
            },
            club_photos: {
              fields: ["imageInfo"],
              populate: {
                images: {
                  fields: [
                    "url",
                    "width",
                    "height",
                    "size",
                    "formats",
                    "ext",
                    "name",
                    "mime",
                  ],
                },
              },
            },
            club_services: {
              populate: ["logo"],
            },
            club_facilities: {
              populate: ["logo"],
            },
          },
        },
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
      const body = (ctx.request.body as any) ?? {};
      const data = body.data ?? body;

      if (!id) {
        return ctx.badRequest("Pending Club owner ID is required");
      }

      if (!data || Object.keys(data).length === 0) {
        return ctx.badRequest("Update data is required");
      }

      const existing = await strapi.entityService.findOne(
        "api::pending-club-owner.pending-club-owner",
        id,
      );

      if (!existing) {
        return ctx.notFound("Pending club owner not found");
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

      await strapi.entityService.update(
        "api::pending-club-owner.pending-club-owner",
        id,
        { data: updateData },
      );

      const entity: any = await strapi.entityService.findOne(
        "api::pending-club-owner.pending-club-owner",
        id,
        {
          populate: {
            logo: true,
            user: true,
            club_owner_documents: {
              populate: ["File"],
            },
            club_photos: {
              populate: ["images"],
            },
            club_services: {
              populate: ["logo"],
            },
            club_facilities: {
              populate: ["logo"],
            },
          },
        },
      );

      ctx.body = entity;
    } catch (err) {
      strapi.log.error("UPDATE CLUB OWNER ERROR:", err);
      return ctx.internalServerError("Failed to update club owner");
    }
  },
};
