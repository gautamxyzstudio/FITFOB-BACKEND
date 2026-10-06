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
      .jpeg({ quality, mozjpeg: true })
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

/* ---------------- BODY PARSER ---------------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try {
      body = JSON.parse(body.data);
    } catch {}
  }
  return body;
}

/* ---------------- GET LATEST DRAFT ---------------- */
async function getDraft(userId: number) {
  const drafts = await strapi.entityService.findMany(PENDING_UID, {
    filters: { user: { id: userId } },
    sort: { id: "desc" },
    limit: 1,
    populate: ["logo"],
  });
  return drafts?.[0] || null;
}

/* ---------------- EDITABLE DRAFT GUARD ---------------- */
async function getEditableDraft(ctx: Context) {
  const user = ctx.state.user;

  if (!user) {
    ctx.unauthorized();
    return null;
  }

  let draft: any = await getDraft(user.id);

  if (!draft) {
    draft = await strapi.entityService.create(PENDING_UID, {
      data: {
        user: user.id,
        status: "draft",
        currentStep: 1,
        isPhoneVerified: false,
        isEmailVerified: false,
      },
    });
    return draft;
  }

  if (draft.status === "completed") {
    ctx.badRequest("Your onboarding is already completed.");
    return null;
  }

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

async function ensureStep1Verified(ctx: Context, draft: any): Promise<boolean> {
  const sessionUser = ctx.state.user;
  if (!sessionUser) {
    ctx.unauthorized("Login required");
    return false;
  }

  const user: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: sessionUser.id },
    });

  if (!isPhoneOrEmailVerified(draft, user)) {
    const regType = getUserRegistrationType(user);
    ctx.badRequest(
      regType === "email"
        ? "Please verify your phone number in Step 1 before proceeding."
        : "Please verify your email address in Step 1 before proceeding.",
    );
    return false;
  }

  return true;
}

/* ---------------- SUBMISSION VALIDATION ---------------- */
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

  const docs = await strapi.entityService.findMany(GOV_DOC_UID, {
    filters: { pending_club_owner: { id: draft.id } },
  });

  if (!docs || docs.length === 0)
    return "Please upload at least one government document";

  const photos = await strapi.entityService.findMany(CLUB_PHOTO_UID, {
    filters: { pending_club_owner: { id: draft.id } },
  });

  if (!photos || photos.length === 0)
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

/* ---------------- CREATE CLUB OWNER FROM PENDING DRAFT ---------------- */
export async function createClubOwnerFromPending(userId: number) {
  const draft: any = await strapi.db.query(PENDING_UID).findOne({
    where: { user: userId },
    populate: ["logo", "club_photos", "club_owner_documents"],
  });

  if (!draft) return null;

  const existingClub = await strapi.db.query(CLUB_UID).findOne({
    where: { user: userId },
  });

  if (existingClub) return existingClub;

  const myDocs: any = await strapi.entityService.findMany(GOV_DOC_UID, {
    filters: { pending_club_owner: { id: draft.id } },
  });

  const myPhotos: any = await strapi.entityService.findMany(CLUB_PHOTO_UID, {
    filters: { pending_club_owner: { id: draft.id } },
  });

  const logoId = draft.logo?.id ?? null;
  const photoIds = (myPhotos || []).map((p: any) => p.id);
  const docIds = (myDocs || []).map((d: any) => d.id);
  const weekdayScheduling = orderWeekdayScheduling(
    normalizeWeekdayScheduling(draft.weekdayScheduling),
  );
  const newClubId = await generateClubId();

  const serviceIds = await resolveClubServiceIds(
    draft.club_services && draft.club_services.length > 0
      ? draft.club_services
      : draft.services,
  );
  const facilityIds = await resolveClubFacilityIds(
    draft.club_facilities && draft.club_facilities.length > 0
      ? draft.club_facilities
      : draft.facilities,
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

  for (const doc of myDocs) {
    await strapi.entityService.update(GOV_DOC_UID, doc.id, {
      data: { pending_club_owner: null },
    });
  }

  for (const photo of myPhotos) {
    await strapi.entityService.update(CLUB_PHOTO_UID, photo.id, {
      data: { pending_club_owner: null },
    });
  }

  /* ---------- DELETE PENDING ONBOARDING ---------- */
  await strapi.entityService.delete(PENDING_UID, draft.id);

  return clubOwner;
}

export default {
  /* ===================================================== */
  async me(ctx: Context) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Login required");
      }

      /* ================= CHECK PENDING CLUB OWNER ================= */

      const draft: any = await strapi.db.query(PENDING_UID).findOne({
        where: {
          user: user.id,
        },
        populate: {
          user: true,
          logo: true,
          clubPhotos: true,
          club_owner_documents: {
            populate: {
              File: true,
            },
          },
        },
      });

      /* ================= PENDING CLUB OWNER EXISTS ================= */

      if (draft) {
        if (draft.weekdayScheduling) {
          draft.weekdayScheduling = orderWeekdayScheduling(
            draft.weekdayScheduling,
          );
        }
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
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const sessionUser = ctx.state.user;
      if (!sessionUser) {
        return ctx.unauthorized("Login required");
      }

      const user: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: sessionUser.id },
        });

      if (!user) {
        return ctx.unauthorized("User not found");
      }

      const body = getBody(ctx);
      const files: any = ctx.request.files;

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

      // Check if phone or email changed from current draft
      const isPhoneChanged =
        normalizePhone(draft.phoneNumber || "") !== submittedPhone;
      const isEmailChanged =
        (draft.email || "").toLowerCase() !== submittedEmail;

      let isPhoneVerified = Boolean(draft.isPhoneVerified);
      let isEmailVerified = Boolean(draft.isEmailVerified);

      let needsPhoneVerification = false;
      let needsEmailVerification = false;

      if (regType === "email") {
        // User created with email -> phone number must be verified in draft
        if (isPhoneChanged) {
          isPhoneVerified = false;
        }
        needsPhoneVerification = !isPhoneVerified;
      } else {
        // User created with phone -> email must be verified in draft
        if (isEmailChanged) {
          isEmailVerified = false;
        }
        needsEmailVerification = !isEmailVerified;
      }

      let logoId = draft.logo?.id ?? null;

      if (files?.logo) {
        if (draft.logo?.id) {
          await strapi.plugin("upload").service("upload").remove(draft.logo);
        }
        const uploaded = await uploadToFolder(files.logo);
        logoId = uploaded[0].id;
      }

      const needsVerification =
        needsPhoneVerification || needsEmailVerification;

      await strapi.entityService.update(PENDING_UID, draft.id, {
        data: {
          clubName: body.clubName,
          ownerName: body.ownerName,
          phoneNumber: submittedPhone,
          email: submittedEmail,
          logo: logoId,
          isPhoneVerified,
          isEmailVerified,
          currentStep: needsVerification
            ? 1
            : Math.max(draft.currentStep || 1, 2),
        },
      });

      if (needsPhoneVerification) {
        const otp = generateOtp();
        const otpHash = await bcrypt.hash(otp, 10);

        await strapi.db.query("api::otp-request.otp-request").deleteMany({
          where: {
            identifier: submittedPhone,
            purpose: "club_owner_verification",
          },
        });

        await strapi.entityService.create("api::otp-request.otp-request", {
          data: {
            identifier: submittedPhone,
            otp_hash: otpHash,
            expires_at: new Date(Date.now() + 2 * 60 * 1000),
            attempts: 0,
            verified: false,
            purpose: "club_owner_verification",
            last_sent_at: new Date(),
          },
        });

        try {
          await sendTwilioOtp(submittedPhone, otp);
        } catch (smsError: any) {
          strapi.log.error("[CLUB OWNER PHONE OTP SEND ERROR]", smsError);
          return ctx.badRequest(
            "Failed to send OTP to the provided phone number. Please verify the phone number.",
          );
        }

        return ctx.send({
          requiresVerification: true,
          verificationType: "phone",
          identifier: submittedPhone,
          message: "OTP sent to your phone number to verify.",
        });
      }

      if (needsEmailVerification) {
        const otp = generateOtp();
        const otpHash = await bcrypt.hash(otp, 10);

        await strapi.db.query("api::otp-request.otp-request").deleteMany({
          where: {
            identifier: submittedEmail,
            purpose: "club_owner_verification",
          },
        });

        await strapi.entityService.create("api::otp-request.otp-request", {
          data: {
            identifier: submittedEmail,
            otp_hash: otpHash,
            expires_at: new Date(Date.now() + 2 * 60 * 1000),
            attempts: 0,
            verified: false,
            purpose: "club_owner_verification",
            last_sent_at: new Date(),
          },
        });

        try {
          await axios.post(
            "https://api.brevo.com/v3/smtp/email",
            {
              sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
              to: [{ email: submittedEmail }],
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
          requiresVerification: true,
          verificationType: "email",
          identifier: submittedEmail,
          message: "OTP sent to your email address to verify.",
        });
      }

      return ctx.send({
        requiresVerification: false,
        nextStep: 2,
      });
    } catch (err: any) {
      strapi.log.error("CLUB OWNER DETAILS ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to update club owner details",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1A — VERIFY OTP FOR PHONE / EMAIL */
  async verifyDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const sessionUser = ctx.state.user;
      if (!sessionUser) return ctx.unauthorized("Login required");

      const user: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: sessionUser.id },
        });

      if (!user) return ctx.unauthorized("User not found");

      const body = getBody(ctx);
      const otp = String(body.otp || "").trim();

      if (!otp) {
        return ctx.badRequest("OTP is required");
      }

      let identifier = body.identifier ? String(body.identifier).trim() : null;

      if (!identifier) {
        const regType = getUserRegistrationType(user);
        if (regType === "email") {
          identifier = draft.phoneNumber;
        } else {
          identifier = draft.email;
        }
      }

      if (!identifier) {
        return ctx.badRequest("Identifier (phone number or email) is required");
      }

      const isEmail = identifier.includes("@");
      identifier = isEmail
        ? identifier.toLowerCase()
        : normalizePhone(identifier);

      const record = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({
          where: {
            identifier,
            purpose: "club_owner_verification",
          },
          orderBy: { createdAt: "desc" },
        });

      if (!record) {
        return ctx.badRequest("OTP not found. Please request a new OTP.");
      }

      if (new Date(record.expires_at).getTime() < Date.now()) {
        await strapi.db.query("api::otp-request.otp-request").delete({
          where: { id: record.id },
        });
        return ctx.badRequest("OTP expired. Please resend OTP.");
      }

      const valid = await bcrypt.compare(otp, record.otp_hash);
      if (!valid) {
        await strapi.db.query("api::otp-request.otp-request").update({
          where: { id: record.id },
          data: { attempts: (record.attempts || 0) + 1 },
        });
        return ctx.badRequest("Invalid OTP");
      }

      // Delete consumed OTP
      await strapi.db.query("api::otp-request.otp-request").delete({
        where: { id: record.id },
      });

      // Update pending draft (do NOT modify user record)
      const updateData: any = {
        currentStep: Math.max(draft.currentStep || 1, 2),
      };

      if (isEmail) {
        updateData.isEmailVerified = true;
        updateData.email = identifier;
      } else {
        updateData.isPhoneVerified = true;
        updateData.phoneNumber = identifier;
      }

      await strapi.entityService.update(PENDING_UID, draft.id, {
        data: updateData,
      });

      return ctx.send({
        nextStep: 2,
        message: `${isEmail ? "Email" : "Phone number"} verified successfully.`,
      });
    } catch (err: any) {
      strapi.log.error("VERIFY DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to verify details OTP",
      );
    }
  },

  /* ===================================================== */
  /* STEP 1B — RESEND OTP FOR PHONE / EMAIL */
  async resendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const sessionUser = ctx.state.user;
      if (!sessionUser) return ctx.unauthorized("Login required");

      const user: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: sessionUser.id },
        });

      if (!user) return ctx.unauthorized("User not found");

      const body = getBody(ctx);
      let identifier = body.identifier ? String(body.identifier).trim() : null;

      if (!identifier) {
        const regType = getUserRegistrationType(user);
        if (regType === "email") {
          identifier = draft.phoneNumber;
        } else {
          identifier = draft.email;
        }
      }

      if (!identifier) {
        return ctx.badRequest("Identifier (phone number or email) is required");
      }

      const isEmail = identifier.includes("@");
      identifier = isEmail
        ? identifier.toLowerCase()
        : normalizePhone(identifier);

      // Check cooldown (30 seconds)
      const existing = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({
          where: {
            identifier,
            purpose: "club_owner_verification",
          },
          orderBy: { createdAt: "desc" },
        });

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

      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: {
          identifier,
          purpose: "club_owner_verification",
        },
      });

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "club_owner_verification",
          last_sent_at: new Date(),
        },
      });

      if (isEmail) {
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
      } else {
        await sendTwilioOtp(identifier, otp);
      }

      return ctx.send({
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

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        latitude: body.latitude,
        longitude: body.longitude,
        currentStep: Math.max(draft.currentStep || 1, 3),
      },
    });

    ctx.send({ nextStep: 3 });
  },

  /* ===================================================== */
  async addressDetails(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        clubAddress: body.clubAddress,
        city: body.city,
        state: body.state,
        pincode: body.pincode,
        currentStep: Math.max(draft.currentStep || 1, 4),
      },
    });

    ctx.send({ nextStep: 4 });
  },

  /* ===================================================== */
  async configureClub(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);
    const allowedCategories = ["Basic", "Premium", "Luxury"];
    if (!allowedCategories.includes(body.clubCategory))
      return ctx.badRequest("Invalid club category");

    const serviceIds = await resolveClubServiceIds(
      body.club_services || body.services,
    );
    const facilityIds = await resolveClubFacilityIds(
      body.club_facilities || body.facilities,
    );

    const updateData: any = {
      services: body.services,
      facilities: body.facilities,
      weekdayScheduling: normalizeWeekdayScheduling(body.weekdayScheduling),
      clubCategory: body.clubCategory,
      currentStep: Math.max(draft.currentStep || 1, 5),
    };

    if (
      serviceIds.length > 0 ||
      Array.isArray(body.services) ||
      Array.isArray(body.club_services)
    ) {
      updateData.club_services = serviceIds;
    }
    if (
      facilityIds.length > 0 ||
      Array.isArray(body.facilities) ||
      Array.isArray(body.club_facilities)
    ) {
      updateData.club_facilities = facilityIds;
    }

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: updateData,
    });

    ctx.send({ nextStep: 5 });
  },

  /* ===================================================== */
  /* STEP 5A — VERIFY GOVERNMENT DOCUMENT AUTHENTICITY */
  async verifyGovernmentDoc(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
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
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);
    const file = (ctx.request.files as any)?.file;

    if (!file) return ctx.badRequest("Please upload document");
    if (!body.documentName) return ctx.badRequest("Document name required");

    /* ---------- CHECK IF SAME DOCUMENT ALREADY EXISTS ---------- */
    const existingDoc: any = await strapi.entityService.findMany(GOV_DOC_UID, {
      filters: {
        pending_club_owner: { id: draft.id },
        documentName: body.documentName,
      },
      populate: ["File"],
      limit: 1,
    });

    /* ---------- UPLOAD NEW FILE ---------- */
    const uploaded = await uploadToFolder(file);
    const fileId = uploaded[0].id;

    /* ---------- REPLACE OR CREATE ---------- */
    if (existingDoc.length > 0) {
      // remove old file from server
      if (existingDoc[0].File) {
        await strapi
          .plugin("upload")
          .service("upload")
          .remove(existingDoc[0].File);
      }

      // update existing DB record
      await strapi.entityService.update(GOV_DOC_UID, existingDoc[0].id, {
        data: {
          File: fileId,
        },
      });

      ctx.send({ message: "Document replaced" });
    } else {
      // create first time
      await strapi.entityService.create(GOV_DOC_UID, {
        data: {
          documentName: body.documentName,
          File: fileId,
          pending_club_owner: draft.id,
        },
      });

      ctx.send({ message: "Document uploaded" });
    }
  },

  async getMyDocuments(ctx: Context) {
    const user = ctx.state.user;
    if (!user) {
      console.log("❌ No user found in ctx.state");
      return ctx.unauthorized();
    }

    // get draft
    const draft: any = await getDraft(user.id);
    if (!draft) {
      console.log("No draft found");
      return ctx.send({ data: [] });
    }

    // fetch documents
    const docs: any = await strapi.entityService.findMany(GOV_DOC_UID, {
      filters: { pending_club_owner: { id: draft.id } },
      populate: ["File"],
      sort: { createdAt: "desc" },
    });

    const response = docs.map((d: any) => ({
      documentId: d.documentId,
      name: d.documentName,
      uploadedAt: d.createdAt,
      fileUrl: d.File ? `${strapi.config.server.url}${d.File.url}` : null,
    }));

    ctx.send({ data: response });
  },

  /* ===================================================== */
  async confirmGovernmentDocs(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: { currentStep: Math.max(draft.currentStep || 1, 6) },
    });

    ctx.send({ nextStep: 6 });
  },

  /* ===================================================== */
  /* STEP 6A — UPLOAD SINGLE CLUB PHOTO WITH TEXT (CAN CALL MULTIPLE TIMES) */
  async uploadClubPhoto(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
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

    const uploadedPhotos = await uploadToFolder(photoFile);
    const photoIds = uploadedPhotos.map((f: any) => f.id);

    // Create club photo entry in club_photos collection with imageInfo and uploaded images
    const newPhoto: any = await strapi.entityService.create(CLUB_PHOTO_UID, {
      data: {
        imageInfo: body.imageInfo || body.description || "",
        images: photoIds,
        pending_club_owner: draft.id,
      },
      populate: ["images"],
    });

    const fileUrl = newPhoto.images?.[0]
      ? `${strapi.config.server.url}${newPhoto.images[0].url}`
      : null;

    ctx.send({
      success: true,
      message: "Club photo uploaded successfully",
      photo: {
        id: newPhoto.id,
        documentId: newPhoto.documentId,
        imageInfo: newPhoto.imageInfo,
        fileUrl,
        images: newPhoto.images,
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

    const draft: any = await getDraft(user.id);
    if (!draft) {
      return ctx.send({ data: [] });
    }

    const photos: any = await strapi.entityService.findMany(CLUB_PHOTO_UID, {
      filters: { pending_club_owner: { id: draft.id } },
      populate: ["images"],
      sort: { createdAt: "desc" },
    });

    const response = (photos || []).map((p: any) => ({
      id: p.id,
      documentId: p.documentId,
      imageInfo: p.imageInfo,
      uploadedAt: p.createdAt,
      fileUrl: p.images?.[0]
        ? `${strapi.config.server.url}${p.images[0].url}`
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

    const photo: any = await strapi.db.query(CLUB_PHOTO_UID).findOne({
      where: {
        $or: [{ documentId: id }, { id: isNaN(Number(id)) ? -1 : Number(id) }],
        pending_club_owner: draft.id,
      },
      populate: ["images", "pending_club_owner"],
    });

    if (!photo) {
      return ctx.notFound("Club photo not found");
    }

    if (photo.images && Array.isArray(photo.images)) {
      for (const img of photo.images) {
        await strapi.plugin("upload").service("upload").remove(img);
      }
    } else if (photo.images) {
      await strapi.plugin("upload").service("upload").remove(photo.images);
    }

    await strapi.entityService.delete(CLUB_PHOTO_UID, photo.id);

    ctx.send({ success: true, message: "Club photo deleted successfully" });
  },

  /* ===================================================== */
  /* STEP 6 FINAL — CONFIRM ONBOARDING & SEND FOR APPROVAL */
  async uploadClubPhotos(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    const user = ctx.state.user;
    const fullUser = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: user.id } });

    const validationError = await validateBeforeSubmission(draft, fullUser);
    if (validationError) return ctx.badRequest(validationError);

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        status: "completed",
        currentStep: 6,
      },
    });

    if (fullUser?.verification_status === "approved") {
      const clubOwner = await createClubOwnerFromPending(user.id);
      return ctx.send({
        success: true,
        message: "Club Owner profile created successfully",
        clubOwner,
      });
    }

    if (fullUser?.verification_status === "rejected") {
      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: user.id },
        data: {
          verification_status: "pending",
          rejection_reason: null,
          rejected_by: null,
        },
      });
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
