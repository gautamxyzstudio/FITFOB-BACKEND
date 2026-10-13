import { Context } from "koa";
import fs from "fs";
import sharp from "sharp";
import AWS from "aws-sdk";
import { generateClientAssets } from "../../../utils/generateClientId";
import axios from "axios";
import bcrypt from "bcryptjs";
import { compareFaces } from "../../../utils/awsRekognition";
import { validateGovernmentDocument } from "../../../services/aws-document-validator";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { getOtpEmailTemplate } from "../../../utils/otpEmailTemplate";

const PENDING_UID = "api::pending-client-detail.pending-client-detail";
const CLIENT_UID = "api::client-detail.client-detail";

const UPLOAD_FOLDER_ID = 2;

const s3Client = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "ap-south-1",
});

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

  const user: any = cachedUser || (await getFullUser(sessionUser.id));
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

    return optimizedBuffer;
  } catch (err) {
    strapi.log.warn("Image optimization fallback to original buffer:", err);
    return originalBuffer;
  }
}

/* ---------- SAFE BODY PARSER ---------- */
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

/* ---------- HELPERS: MAP DB ROWS TO STRAPI RESPONSE FORMAT ---------- */
function mapDraftRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    gender: row.gender,
    email: row.email,
    phoneNumber: row.phone_number,
    weight: row.weight,
    height: row.height,
    longitude: row.longitude,
    latitude: row.latitude,
    currentStep: row.current_step ? Number(row.current_step) : 1,
    status: row.status,
    date_of_birth: row.date_of_birth,
    documentVerified: Boolean(row.document_verified),
    documentType: row.document_type,
    isPhoneVerified: Boolean(row.is_phone_verified),
    isEmailVerified: Boolean(row.is_email_verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

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

/* ---------- GET USER DRAFT (DIRECT SQL) ---------- */
async function getDraftDirect(userId: number) {
  const draftRes = await strapi.db.connection.raw(
    `SELECT 
      p.id,
      p.document_id,
      p.name,
      p.gender,
      p.email,
      p.phone_number,
      p.weight,
      p.height,
      p.longitude,
      p.latitude,
      p.current_step,
      p.status,
      to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
      p.document_verified,
      p.document_type,
      p.is_phone_verified,
      p.is_email_verified,
      p.created_at,
      p.updated_at,
      p.published_at
    FROM pending_client_details p
    JOIN pending_client_details_user_lnk lnk ON lnk.pending_client_detail_id = p.id
    WHERE lnk.user_id = ?
    ORDER BY p.id DESC
    LIMIT 1`,
    [userId],
  );

  const rawDraft = draftRes?.rows?.[0];
  if (!rawDraft) return null;

  const draft: any = mapDraftRow(rawDraft);

  // Fetch selfieUpload & governmentId files in 1 quick query
  const filesRes = await strapi.db.connection.raw(
    `SELECT 
      frm.field,
      f.id,
      f.document_id,
      f.name,
      f.alternative_text,
      f.caption,
      f.width,
      f.height,
      f.formats,
      f.hash,
      f.ext,
      f.mime,
      f.size,
      f.url,
      f.provider
    FROM files_related_mph frm
    JOIN files f ON f.id = frm.file_id
    WHERE frm.related_id = ? 
      AND frm.related_type = 'api::pending-client-detail.pending-client-detail'
      AND frm.field IN ('selfieUpload', 'governmentId')`,
    [draft.id],
  );

  const rawFiles = filesRes?.rows || [];
  const selfieRow = rawFiles.find((f: any) => f.field === "selfieUpload");
  const govRow = rawFiles.find((f: any) => f.field === "governmentId");

  draft.selfieUpload = selfieRow ? mapFileRow(selfieRow) : null;
  draft.governmentId = govRow ? mapFileRow(govRow) : null;

  return draft;
}

/* ---------- EDITABLE DRAFT GUARD (DIRECT SQL) ---------- */
async function getEditableDraft(ctx: Context) {
  const sessionUser = ctx.state.user;
  if (!sessionUser) {
    ctx.unauthorized();
    return null;
  }

  const user = await getFullUser(sessionUser.id);
  if (!user) {
    ctx.unauthorized("User not found");
    return null;
  }

  let draft: any = await getDraftDirect(user.id);

  // create automatically if draft does not exist
  if (!draft) {
    const regType = getUserRegistrationType(user);
    draft = await strapi.entityService.create(PENDING_UID, {
      data: {
        user: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber || null,
        currentStep: 1,
        status: "draft",
        isPhoneVerified: regType === "phone",
        isEmailVerified: regType === "email",
      },
    });
  }

  // lock after completion
  if (draft.status === "completed") {
    ctx.badRequest("Profile already completed and locked.");
    return null;
  }

  draft._user = user;
  return draft;
}

/* ---------- FINAL VALIDATION BEFORE CLIENT CREATION ---------- */
async function validateBeforeClientCreation(draft: any, user?: any) {
  if (!draft.name || !draft.gender) return "Please complete basic information";

  if (user && !isPhoneOrEmailVerified(draft, user)) {
    const regType = getUserRegistrationType(user);
    return regType === "email"
      ? "Please verify your phone number in Step 1"
      : "Please verify your email address in Step 1";
  }

  if (!draft.date_of_birth) return "Please complete body information";

  if (!draft.latitude || !draft.longitude) return "Please set your location";

  if (!draft.selfieUpload) return "Please upload selfie";

  return null;
}

/* ---------- UNIQUE CLIENT ID & DOCUMENT ID (DIRECT SQL) ---------- */
function generateDocumentId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateClientIdDirect(): Promise<string> {
  while (true) {
    const numbers = Math.floor(
      100000000 + Math.random() * 900000000,
    ).toString();
    const clientId = `CL-${numbers.slice(0, 3)}-${numbers.slice(
      3,
      6,
    )}-${numbers.slice(6, 9)}`;
    const res = await strapi.db.connection.raw(
      `SELECT 1 FROM client_details WHERE client_id = ? LIMIT 1`,
      [clientId],
    );
    if (!res?.rows?.length) return clientId;
  }
}

/* ---------- FAST IMAGE BUFFER FETCHING (DIRECT S3 WITH AXIOS FALLBACK) ---------- */
async function fetchImageBuffer(url: string): Promise<Buffer> {
  const bucket = process.env.AWS_BUCKET;
  if (bucket && url.includes(".amazonaws.com/")) {
    try {
      const match = url.match(/^https?:\/\/[^\/]+\/(.+)$/);
      if (match) {
        const key = decodeURIComponent(match[1]);
        const s3Res = await s3Client
          .getObject({ Bucket: bucket, Key: key })
          .promise();
        if (s3Res.Body) {
          return Buffer.isBuffer(s3Res.Body)
            ? s3Res.Body
            : Buffer.from(s3Res.Body as any);
        }
      }
    } catch (err) {
      strapi.log.warn(
        "[fetchImageBuffer] S3 getObject fallback to axios:",
        err,
      );
    }
  }

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 10000,
  });
  return Buffer.from(res.data as any);
}

/* ---------- FAST BUFFER RESIZE HELPER ---------- */
async function optimizeBufferForRekognition(
  buf: Buffer,
  maxWidth: number,
): Promise<Buffer> {
  if (buf.length <= 1024 * 1024) return buf;
  try {
    return await sharp(buf)
      .rotate()
      .resize({
        width: maxWidth,
        height: maxWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer();
  } catch (_) {
    return buf;
  }
}

export default {
  /* ================= START / RESUME ================= */
  async me(ctx: Context) {
    try {
      const sessionUser = ctx.state.user;

      if (!sessionUser) {
        return ctx.unauthorized("Login required");
      }

      const userId = sessionUser.id;

      /* ================= CHECK CLIENT DETAIL (DIRECT SQL) ================= */
      const existingRes = await strapi.db.connection.raw(
        `SELECT client_detail_id FROM up_users_client_detail_lnk WHERE user_id = ? LIMIT 1`,
        [userId],
      );

      if (
        existingRes?.rows?.length > 0 &&
        existingRes.rows[0].client_detail_id
      ) {
        return ctx.badRequest("Client detail already exists");
      }

      /* ================= CHECK PENDING CLIENT DETAIL (DIRECT SQL) ================= */
      const draft = await getDraftDirect(userId);

      if (draft) {
        const user = await getFullUser(userId);
        draft.user = user;

        return ctx.send({
          currentStep: draft.currentStep,
          status: draft.status,
          details: draft,
        });
      }

      /* ================= NEITHER EXISTS ================= */
      return ctx.send({
        currentStep: 1,
        status: "draft",
      });
    } catch (error) {
      strapi.log.error("Error fetching client onboarding details:", error);

      return ctx.internalServerError(
        "Failed to fetch client onboarding details",
      );
    }
  },

  /* ================= STEP 1 BASIC INFO ================= */
  async basicInfo(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user || (await getFullUser(ctx.state.user.id));
      if (!user) return ctx.unauthorized("User not found");

      const body = getBody(ctx);

      if (!body.name || !body.gender) {
        return ctx.badRequest("Name and gender are required");
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
            "Please verify your phone number via OTP first before submitting basic info.",
          );
        }
      } else {
        const isEmailVerified =
          Boolean(draft.isEmailVerified) &&
          (draft.email || "").toLowerCase() === submittedEmail;

        if (!isEmailVerified) {
          return ctx.badRequest(
            "Please verify your email address via OTP first before submitting basic info.",
          );
        }
      }

      // Direct SQL update to pending_client_details
      await strapi.db.connection.raw(
        `UPDATE pending_client_details
         SET 
           name = ?,
           gender = ?,
           phone_number = ?,
           email = ?,
           is_phone_verified = true,
           is_email_verified = true,
           current_step = GREATEST(COALESCE(current_step, 1), 2),
           updated_at = NOW()
         WHERE id = ?`,
        [body.name, body.gender, submittedPhone, submittedEmail, draft.id],
      );

      return ctx.send({
        nextStep: 2,
        message: "Basic info saved successfully.",
      });
    } catch (err: any) {
      strapi.log.error("CLIENT BASIC INFO ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to update basic info",
      );
    }
  },

  /* ================= STEP 1A — SEND OTP FOR PHONE / EMAIL ================= */
  async sendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user || (await getFullUser(ctx.state.user.id));
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

      // Save identifier to draft so draft stays in sync via direct Postgres update
      if (isEmail) {
        await strapi.db.connection.raw(
          `UPDATE pending_client_details 
           SET email = ?, 
               is_email_verified = CASE WHEN email = ? THEN is_email_verified ELSE false END,
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, identifier, draft.id],
        );
      } else {
        await strapi.db.connection.raw(
          `UPDATE pending_client_details 
           SET phone_number = ?, 
               is_phone_verified = CASE WHEN phone_number = ? THEN is_phone_verified ELSE false END,
               updated_at = NOW() 
           WHERE id = ?`,
          [identifier, identifier, draft.id],
        );
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      // Direct delete previous OTP requests for this identifier
      await strapi.db.connection.raw(
        `DELETE FROM otp_requests WHERE identifier = ? AND purpose = 'client_verification'`,
        [identifier],
      );

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "client_verification",
          last_sent_at: new Date(),
        },
      });

      if (isEmail) {
        try {
          await axios.post(
            "https://api.brevo.com/v3/smtp/email",
            {
              sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
              to: [{ email: identifier }],
              subject: "FitFob Client Email Verification OTP",
              htmlContent: getOtpEmailTemplate(otp, {
                title: "FitFob Email Verification Code",
                subtext:
                  "Use the One-Time Password (OTP) below to verify your email address for client onboarding:",
                validityMinutes: 2,
              }),
            },
            { headers: { "api-key": process.env.BREVO_API_KEY } },
          );
        } catch (emailError: any) {
          strapi.log.error(
            "[CLIENT EMAIL OTP SEND ERROR]",
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
          strapi.log.error("[CLIENT PHONE OTP SEND ERROR]", smsError);
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

  /* ================= STEP 1B — VERIFY OTP FOR PHONE / EMAIL ================= */
  async verifyDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user || (await getFullUser(ctx.state.user.id));
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
          "Your phone number is already verified from signup. Please provide your email address.",
        );
      }

      identifier = isEmail
        ? identifier.toLowerCase()
        : normalizePhone(identifier);

      // Direct PostgreSQL query for OTP record
      const recordRes = await strapi.db.connection.raw(
        `SELECT id, otp_hash, expires_at, attempts
         FROM otp_requests
         WHERE identifier = ? AND purpose = 'client_verification'
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
          `UPDATE otp_requests SET attempts = COALESCE(attempts, 0) + 1, updated_at = NOW() WHERE id = ?`,
          [record.id],
        );
        return ctx.badRequest("Invalid OTP");
      }

      // Delete consumed OTP directly
      await strapi.db.connection.raw(`DELETE FROM otp_requests WHERE id = ?`, [
        record.id,
      ]);

      const hasCompletedStep1Details = Boolean(draft.name && draft.gender);
      const nextStep = hasCompletedStep1Details
        ? Math.max(draft.currentStep || 1, 2)
        : draft.currentStep || 1;

      // Direct SQL update to pending_client_details
      if (isEmail) {
        await strapi.db.connection.raw(
          `UPDATE pending_client_details
           SET 
             current_step = ?,
             is_email_verified = true,
             is_phone_verified = CASE WHEN ? = 'phone' THEN true ELSE is_phone_verified END,
             email = ?,
             updated_at = NOW()
           WHERE id = ?`,
          [nextStep, regType, identifier, draft.id],
        );
      } else {
        await strapi.db.connection.raw(
          `UPDATE pending_client_details
           SET 
             current_step = ?,
             is_phone_verified = true,
             is_email_verified = CASE WHEN ? = 'email' THEN true ELSE is_email_verified END,
             phone_number = ?,
             updated_at = NOW()
           WHERE id = ?`,
          [nextStep, regType, identifier, draft.id],
        );
      }

      return ctx.send({
        verified: true,
        verificationType: isEmail ? "email" : "phone",
        identifier,
        nextStep: hasCompletedStep1Details ? 2 : 1,
      });
    } catch (err: any) {
      strapi.log.error("VERIFY CLIENT DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to verify details OTP",
      );
    }
  },

  /* ================= STEP 1C — RESEND OTP FOR PHONE / EMAIL ================= */
  async resendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const user = draft._user || (await getFullUser(ctx.state.user.id));
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

      // Check cooldown (30 seconds) directly in PostgreSQL
      const existingRes = await strapi.db.connection.raw(
        `SELECT id, last_sent_at 
         FROM otp_requests 
         WHERE identifier = ? AND purpose = 'client_verification' 
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

      // Direct delete previous OTP requests
      await strapi.db.connection.raw(
        `DELETE FROM otp_requests WHERE identifier = ? AND purpose = 'client_verification'`,
        [identifier],
      );

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "client_verification",
          last_sent_at: new Date(),
        },
      });

      if (isEmail) {
        try {
          await axios.post(
            "https://api.brevo.com/v3/smtp/email",
            {
              sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
              to: [{ email: identifier }],
              subject: "FitFob Client Email Verification OTP",
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
            "[CLIENT EMAIL OTP SEND ERROR]",
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
          strapi.log.error("[CLIENT PHONE OTP SEND ERROR]", smsError);
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
      strapi.log.error("RESEND CLIENT DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to resend details OTP",
      );
    }
  },

  /* ================= STEP 2 BODY INFO ================= */
  async bodyInfo(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft, draft._user))) return;

    const body = getBody(ctx);

    if (!body.date_of_birth) return ctx.badRequest("date_of_birth is required");

    const dob = new Date(body.date_of_birth);
    const today = new Date();

    if (isNaN(dob.getTime()))
      return ctx.badRequest("Invalid date_of_birth format. Use YYYY-MM-DD");

    if (dob > today)
      return ctx.badRequest("date_of_birth cannot be in the future");

    // Direct SQL update to pending_client_details
    await strapi.db.connection.raw(
      `UPDATE pending_client_details
       SET 
         date_of_birth = ?,
         height = ?,
         weight = ?,
         current_step = GREATEST(COALESCE(current_step, 1), 3),
         updated_at = NOW()
       WHERE id = ?`,
      [body.date_of_birth, body.height, body.weight, draft.id],
    );

    ctx.send({ nextStep: 3 });
  },

  /* ================= STEP 3 LOCATION ================= */
  async location(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft, draft._user))) return;

    const body = getBody(ctx);

    // Direct SQL update to pending_client_details
    await strapi.db.connection.raw(
      `UPDATE pending_client_details
       SET 
         latitude = ?,
         longitude = ?,
         current_step = GREATEST(COALESCE(current_step, 1), 4),
         updated_at = NOW()
       WHERE id = ?`,
      [body.latitude, body.longitude, draft.id],
    );

    ctx.send({ nextStep: 4 });
  },

  /* ================= STEP 4 SELFIE ================= */
  async selfie(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft, draft._user))) return;

    const files: any = ctx.request.files;
    if (!files || !files.selfieUpload)
      return ctx.badRequest("Please upload selfie");

    const uploadService = strapi.plugin("upload").service("upload");
    const rawFile = Array.isArray(files.selfieUpload)
      ? files.selfieUpload[0]
      : files.selfieUpload;

    // Fast image optimization before uploading to S3 (max 1200px, quality 85)
    await prepareAndOptimizeImage(rawFile, 1200, 85);

    // Non-blocking cleanup of old selfie from S3
    if (draft.selfieUpload?.id) {
      uploadService
        .remove(draft.selfieUpload)
        .catch((err: any) =>
          strapi.log.warn("[selfie] Old selfie remove error:", err),
        );
    }

    const uploaded = await uploadService.upload({
      data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
      files: rawFile,
    });

    const file = uploaded[0];

    // Direct PostgreSQL update for media relation and step
    await strapi.db.connection.raw(
      `DELETE FROM files_related_mph 
       WHERE related_id = ? 
         AND related_type = 'api::pending-client-detail.pending-client-detail' 
         AND field = 'selfieUpload'`,
      [draft.id],
    );

    await strapi.db.connection.raw(
      `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
       VALUES (?, ?, 'api::pending-client-detail.pending-client-detail', 'selfieUpload', 1)`,
      [file.id, draft.id],
    );

    await strapi.db.connection.raw(
      `UPDATE pending_client_details
       SET current_step = GREATEST(COALESCE(current_step, 1), 5), updated_at = NOW()
       WHERE id = ?`,
      [draft.id],
    );

    ctx.send({ nextStep: 5, fileUrl: file.url });
  },

  /* ================= STEP 5 GOVERNMENT ID & FINAL SUBMIT ================= */
  async governmentId(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    const user = draft._user || (await getFullUser(ctx.state.user.id));
    if (!(await ensureStep1Verified(ctx, draft, user))) return;

    const validationError = await validateBeforeClientCreation(draft, user);
    if (validationError) return ctx.badRequest(validationError);

    const files: any = ctx.request.files;

    if (!files || !files.governmentId) {
      return ctx.badRequest("Please upload government ID");
    }

    const uploadService = strapi.plugin("upload").service("upload");

    const rawFile = Array.isArray(files.governmentId)
      ? files.governmentId[0]
      : files.governmentId;

    try {
      /* ==========================================
         1. FAST IMAGE OPTIMIZE & VALIDATE DOCUMENT (AWS TEXTRACT)
      ========================================== */
      const buffer = await prepareAndOptimizeImage(rawFile, 1600, 85);

      const documentResult = await validateGovernmentDocument(buffer);

      if (!documentResult.valid) {
        // Clear draft directly in Postgres
        await strapi.db.connection.raw(
          `UPDATE pending_client_details
           SET 
             document_verified = false,
             document_type = 'unknown',
             updated_at = NOW()
           WHERE id = ?`,
          [draft.id],
        );

        if (draft.governmentId?.id) {
          uploadService
            .remove(draft.governmentId)
            .catch((err: any) =>
              strapi.log.warn("[governmentId] Old ID remove error:", err),
            );
        }

        return ctx.badRequest("Please upload a valid government ID.");
      }

      /* ==========================================
         2. UPLOAD OPTIMIZED FILE TO S3
      ========================================== */
      if (draft.governmentId?.id) {
        uploadService
          .remove(draft.governmentId)
          .catch((err: any) =>
            strapi.log.warn("[governmentId] Old ID remove error:", err),
          );
      }

      const uploaded = await uploadService.upload({
        data: {
          fileInfo: {
            folder: UPLOAD_FOLDER_ID,
          },
        },
        files: rawFile,
      });

      const idFile = uploaded[0];

      /* ==========================================
         3. SAVE TO PENDING DRAFT (DIRECT SQL)
      ========================================== */
      await strapi.db.connection.raw(
        `DELETE FROM files_related_mph 
         WHERE related_id = ? 
           AND related_type = 'api::pending-client-detail.pending-client-detail' 
           AND field = 'governmentId'`,
        [draft.id],
      );

      await strapi.db.connection.raw(
        `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
         VALUES (?, ?, 'api::pending-client-detail.pending-client-detail', 'governmentId', 1)`,
        [idFile.id, draft.id],
      );

      await strapi.db.connection.raw(
        `UPDATE pending_client_details
         SET 
           document_verified = true,
           document_type = ?,
           current_step = 5,
           updated_at = NOW()
         WHERE id = ?`,
        [documentResult.documentType, draft.id],
      );

      return ctx.send({
        success: true,
        message: "Government ID uploaded successfully.",
        documentType: documentResult.documentType,
      });
    } catch (error) {
      console.error("Government ID validation error:", error);
      return ctx.internalServerError("Unable to validate government ID.");
    }
  },

  /* ================= STEP 6 GOVERNMENT ID & SELFIE MATCH AND SUBMIT ================= */
  async verifyClient(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);

      if (!draft) {
        return ctx.notFound("Pending client not found");
      }

      const user = draft._user || (await getFullUser(ctx.state.user.id));
      if (!(await ensureStep1Verified(ctx, draft, user))) return;

      const validationError = await validateBeforeClientCreation(draft, user);
      if (validationError) return ctx.badRequest(validationError);

      const pendingClient = draft;
      pendingClient.user = user;

      if (!pendingClient.documentVerified) {
        return ctx.badRequest("Government ID is not verified.");
      }

      // Validate images
      if (!pendingClient.selfieUpload || !pendingClient.governmentId) {
        return ctx.badRequest("Selfie or Government ID missing");
      }

      const selfieUrl: string = pendingClient.selfieUpload.url;
      const idUrl: string = pendingClient.governmentId.url;

      const baseUrl =
        process.env.BACKEND_URL || strapi.config.get("server.url");

      const fullSelfieUrl = selfieUrl.startsWith("http")
        ? selfieUrl
        : `${baseUrl}${selfieUrl}`;

      const fullIdUrl = idUrl.startsWith("http") ? idUrl : `${baseUrl}${idUrl}`;

      // Fast S3 / HTTP buffer download in parallel
      const [rawSelfieBuffer, rawIdBuffer] = await Promise.all([
        fetchImageBuffer(fullSelfieUrl),
        fetchImageBuffer(fullIdUrl),
      ]);

      // Optimize in parallel only if buffer exceeds 1MB
      const [selfieBuffer, idBuffer] = await Promise.all([
        optimizeBufferForRekognition(rawSelfieBuffer, 1200),
        optimizeBufferForRekognition(rawIdBuffer, 1600),
      ]);

      // AWS Face comparison
      const result = await compareFaces(selfieBuffer, idBuffer);

      // Direct SQL check if client detail already exists
      const existingClientRes = await strapi.db.connection.raw(
        `SELECT client_detail_id FROM up_users_client_detail_lnk WHERE user_id = ? LIMIT 1`,
        [pendingClient.user.id],
      );

      if (
        existingClientRes?.rows?.length > 0 &&
        existingClientRes.rows[0].client_detail_id
      ) {
        return ctx.badRequest("Client already exists.");
      }

      // 🔥 Decide status
      const approved = result.similarity >= 90;
      const verificationStatus = approved ? "approved" : "in-review";

      // Direct SQL update to up_users
      await strapi.db.connection.raw(
        `UPDATE up_users SET verification_status = ?, updated_at = NOW() WHERE id = ?`,
        [verificationStatus, pendingClient.user.id],
      );

      if (verificationStatus === "in-review") {
        return ctx.send({
          success: true,
          status: "in-review",
          similarity: result.similarity,
          message: "Your verification has been submitted for manual review.",
        });
      }

      const clientId = await generateClientIdDirect();
      const documentId = generateDocumentId();

      // CLIENT CREATION LOGIC (DIRECT SQL)
      const insertRes = await strapi.db.connection.raw(
        `INSERT INTO client_details (
           document_id,
           name,
           gender,
           email,
           phone_number,
           date_of_birth,
           height,
           weight,
           latitude,
           longitude,
           face_similarity,
           client_id,
           created_at,
           updated_at,
           published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
         RETURNING id, document_id, name, gender, email, phone_number, date_of_birth, height, weight, latitude, longitude, face_similarity, client_id, created_at, updated_at, published_at`,
        [
          documentId,
          pendingClient.name,
          pendingClient.gender,
          pendingClient.email,
          pendingClient.phoneNumber,
          pendingClient.date_of_birth,
          pendingClient.height,
          pendingClient.weight,
          pendingClient.latitude,
          pendingClient.longitude,
          result.similarity,
          clientId,
        ],
      );

      const clientRow = insertRes.rows[0];

      // Direct SQL link to user
      await strapi.db.connection.raw(
        `INSERT INTO up_users_client_detail_lnk (user_id, client_detail_id) VALUES (?, ?)`,
        [pendingClient.user.id, clientRow.id],
      );

      // Direct SQL link to media files
      if (pendingClient.selfieUpload?.id) {
        await strapi.db.connection.raw(
          `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
           VALUES (?, ?, 'api::client-detail.client-detail', 'selfieUpload', 1)`,
          [pendingClient.selfieUpload.id, clientRow.id],
        );
      }

      if (pendingClient.governmentId?.id) {
        await strapi.db.connection.raw(
          `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
           VALUES (?, ?, 'api::client-detail.client-detail', 'governmentId', 1)`,
          [pendingClient.governmentId.id, clientRow.id],
        );
      }

      /* 🧹 DIRECT SQL CLEANUP OF PENDING DRAFT & LINKS */
      await strapi.db.connection.raw(
        `DELETE FROM files_related_mph
         WHERE related_id = ? AND related_type = 'api::pending-client-detail.pending-client-detail'`,
        [pendingClient.id],
      );

      await strapi.db.connection.raw(
        `DELETE FROM pending_client_details_user_lnk WHERE pending_client_detail_id = ?`,
        [pendingClient.id],
      );

      await strapi.db.connection.raw(
        `DELETE FROM pending_client_details WHERE id = ?`,
        [pendingClient.id],
      );

      /* 🔥 CLIENT WITH MEDIA */
      const fullClient = {
        id: clientRow.id,
        documentId: clientRow.document_id,
        name: clientRow.name,
        gender: clientRow.gender,
        email: clientRow.email,
        phoneNumber: clientRow.phone_number,
        date_of_birth: clientRow.date_of_birth,
        height: clientRow.height,
        weight: clientRow.weight,
        latitude: clientRow.latitude,
        longitude: clientRow.longitude,
        faceSimilarity: Number(clientRow.face_similarity),
        clientId: clientRow.client_id,
        createdAt: clientRow.created_at,
        updatedAt: clientRow.updated_at,
        publishedAt: clientRow.published_at,
        selfieUpload: pendingClient.selfieUpload,
        governmentId: pendingClient.governmentId,
        user: pendingClient.user,
      };

      return ctx.send({
        success: true,
        status: verificationStatus,
        similarity: result.similarity,
        message:
          verificationStatus === "approved"
            ? "Client verified successfully."
            : "Your verification has been submitted for manual review.",
        client: fullClient,
      });
    } catch (error) {
      console.error("VERIFY ERROR:", error);
      return ctx.internalServerError("Verification failed");
    }
  },
};
