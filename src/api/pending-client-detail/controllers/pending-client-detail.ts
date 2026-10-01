import { Context } from "koa";
import fs from "fs";
import sharp from "sharp";
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

async function ensureStep1Verified(ctx: Context, draft: any): Promise<boolean> {
  const sessionUser = ctx.state.user;
  if (!sessionUser) {
    ctx.unauthorized("Login required");
    return false;
  }

  const user: any = await getFullUser(sessionUser.id);

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

/* ---------- SAFE BODY PARSER ---------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try {
      body = JSON.parse(body.data);
    } catch { }
  }
  return body;
}

/* ---------- GET FULL USER ---------- */
async function getFullUser(userId: number) {
  return await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({ where: { id: userId } });
}

/* ---------- GET USER DRAFT ---------- */
async function getDraft(userId: number) {
  return await strapi.db.query(PENDING_UID).findOne({
    where: { user: userId },
    populate: ["selfieUpload", "governmentId"],
  });
}

/* ---------- EDITABLE DRAFT GUARD ---------- */
async function getEditableDraft(ctx: Context) {
  const sessionUser = ctx.state.user;
  if (!sessionUser) {
    ctx.unauthorized();
    return null;
  }

  const user = await getFullUser(sessionUser.id);

  let draft: any = await getDraft(user.id);

  // create automatically
  if (!draft) {
    draft = await strapi.entityService.create(PENDING_UID, {
      data: {
        user: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber || null,
        currentStep: 1,
        status: "draft",
        isPhoneVerified: false,
        isEmailVerified: false,
      },
    });
    return draft;
  }

  // lock after completion
  if (draft.status === "completed") {
    ctx.badRequest("Profile already completed and locked.");
    return null;
  }

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

export default {
  /* ================= START / RESUME ================= */
  async me(ctx: Context) {
    try {
      const sessionUser = ctx.state.user;

      if (!sessionUser) {
        return ctx.unauthorized("Login required");
      }

      const user = await getFullUser(sessionUser.id);

      /* ================= CHECK CLIENT DETAIL ================= */

      const existing = await strapi.db.query(CLIENT_UID).findOne({
        where: {
          user: {
            id: user.id,
          },
        },
      });

      /* ================= CLIENT DETAIL EXISTS ================= */

      if (existing) {
        return ctx.badRequest("Client detail already exists");
      }

      /* ================= CHECK PENDING CLIENT DETAIL ================= */

      const draft: any = await strapi.db.query(PENDING_UID).findOne({
        where: {
          user: user.id,
        },
        populate: {
          user: true,
          selfieUpload: true,
          governmentId: true,
        },
      });

      /* ================= PENDING DETAIL EXISTS ================= */

      if (draft) {
        return ctx.send({
          currentStep: draft.currentStep,
          status: draft.status,
          details: draft,
        });
      }

      /* ================= NEITHER EXISTS ================= */
      // Do NOT create a pending client detail here.
      // Just return the default onboarding state.

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

      const sessionUser = ctx.state.user;
      const user = await getFullUser(sessionUser.id);
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

      const needsVerification =
        needsPhoneVerification || needsEmailVerification;

      await strapi.entityService.update(PENDING_UID, draft.id, {
        data: {
          name: body.name,
          gender: body.gender,
          phoneNumber: submittedPhone,
          email: submittedEmail,
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
            purpose: "client_verification",
          },
        });

        await strapi.entityService.create("api::otp-request.otp-request", {
          data: {
            identifier: submittedPhone,
            otp_hash: otpHash,
            expires_at: new Date(Date.now() + 2 * 60 * 1000),
            attempts: 0,
            verified: false,
            purpose: "client_verification",
            last_sent_at: new Date(),
          },
        });

        try {
          await sendTwilioOtp(submittedPhone, otp);
        } catch (smsError: any) {
          strapi.log.error("[CLIENT PHONE OTP SEND ERROR]", smsError);
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
            purpose: "client_verification",
          },
        });

        await strapi.entityService.create("api::otp-request.otp-request", {
          data: {
            identifier: submittedEmail,
            otp_hash: otpHash,
            expires_at: new Date(Date.now() + 2 * 60 * 1000),
            attempts: 0,
            verified: false,
            purpose: "client_verification",
            last_sent_at: new Date(),
          },
        });

        try {
          await axios.post(
            "https://api.brevo.com/v3/smtp/email",
            {
              sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
              to: [{ email: submittedEmail }],
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
      strapi.log.error("CLIENT BASIC INFO ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to update basic info",
      );
    }
  },

  /* ================= STEP 1A — VERIFY OTP FOR PHONE / EMAIL ================= */
  async verifyDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const sessionUser = ctx.state.user;
      if (!sessionUser) return ctx.unauthorized("Login required");

      const user = await getFullUser(sessionUser.id);
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
            purpose: "client_verification",
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
      strapi.log.error("VERIFY CLIENT DETAILS OTP ERROR:", err);
      return ctx.internalServerError(
        err?.message || "Failed to verify details OTP",
      );
    }
  },

  /* ================= STEP 1B — RESEND OTP FOR PHONE / EMAIL ================= */
  async resendDetailsOtp(ctx: Context) {
    try {
      const draft: any = await getEditableDraft(ctx);
      if (!draft) return;

      const sessionUser = ctx.state.user;
      if (!sessionUser) return ctx.unauthorized("Login required");

      const user = await getFullUser(sessionUser.id);
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
            purpose: "client_verification",
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
          purpose: "client_verification",
        },
      });

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
      } else {
        await sendTwilioOtp(identifier, otp);
      }

      return ctx.send({
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

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);

    if (!body.date_of_birth) return ctx.badRequest("date_of_birth is required");

    const dob = new Date(body.date_of_birth);
    const today = new Date();

    if (isNaN(dob.getTime()))
      return ctx.badRequest("Invalid date_of_birth format. Use YYYY-MM-DD");

    if (dob > today)
      return ctx.badRequest("date_of_birth cannot be in the future");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        date_of_birth: body.date_of_birth,
        height: body.height,
        weight: body.weight,
        currentStep: Math.max(draft.currentStep || 1, 3),
      },
    });

    ctx.send({ nextStep: 3 });
  },

  /* ================= STEP 3 LOCATION ================= */
  async location(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const body = getBody(ctx);

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        latitude: body.latitude,
        longitude: body.longitude,
        currentStep: Math.max(draft.currentStep || 1, 4),
      },
    });

    ctx.send({ nextStep: 4 });
  },

  /* ================= STEP 4 SELFIE ================= */
  async selfie(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const files: any = ctx.request.files;
    if (!files || !files.selfieUpload)
      return ctx.badRequest("Please upload selfie");

    const uploadService = strapi.plugin("upload").service("upload");
    const rawFile = Array.isArray(files.selfieUpload)
      ? files.selfieUpload[0]
      : files.selfieUpload;

    // Optimize image before uploading to S3 (max 1200px, quality 85)
    await prepareAndOptimizeImage(rawFile, 1200, 85);

    // replace old selfie
    if (draft.selfieUpload?.id) {
      await uploadService.remove(draft.selfieUpload);
    }

    const uploaded = await uploadService.upload({
      data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
      files: rawFile,
    });

    const file = uploaded[0];

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        selfieUpload: file.id,
        currentStep: Math.max(draft.currentStep || 1, 5),
      },
    });

    ctx.send({ nextStep: 5, fileUrl: file.url });
  },

  /* ================= STEP 5 GOVERNMENT ID & FINAL SUBMIT ================= */

  async governmentId(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    if (!(await ensureStep1Verified(ctx, draft))) return;

    const user = await getFullUser(ctx.state.user.id);
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
         1. OPTIMIZE IMAGE & VALIDATE DOCUMENT (AWS TEXTRACT)
         Read directly from local disk (no redundant S3 download!)
      ========================================== */
      const buffer = await prepareAndOptimizeImage(rawFile, 1600, 85);

      const documentResult = await validateGovernmentDocument(buffer);

      if (!documentResult.valid) {
        // Clear draft
        await strapi.entityService.update(PENDING_UID, draft.id, {
          data: {
            governmentId: null,
            documentVerified: false,
            documentType: "unknown",
          },
        });

        return ctx.badRequest("Please upload a valid government ID.");
      }

      /* ==========================================
         2. UPLOAD OPTIMIZED FILE TO S3
         Only uploaded once document is validated!
      ========================================== */
      // Remove old government ID if previously uploaded
      if (draft.governmentId?.id) {
        try {
          await uploadService.remove(draft.governmentId);
        } catch (_) { }
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
         3. SAVE TO PENDING DRAFT
      ========================================== */
      await strapi.entityService.update(PENDING_UID, draft.id, {
        data: {
          governmentId: idFile.id,
          documentVerified: true,
          documentType: documentResult.documentType,
          currentStep: 5,
        },
      });

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
      const draft = await getEditableDraft(ctx);

      if (!draft) {
        return ctx.notFound("Pending client not found");
      }

      if (!(await ensureStep1Verified(ctx, draft))) return;

      const user = await getFullUser(ctx.state.user.id);
      const validationError = await validateBeforeClientCreation(draft, user);
      if (validationError) return ctx.badRequest(validationError);

      // 1. Fetch client
      const pendingClient: any = await strapi.entityService.findOne(
        PENDING_UID,
        draft.id,
        {
          populate: ["selfieUpload", "governmentId", "user"],
        },
      );

      if (!pendingClient) {
        return ctx.notFound("Pending client not found");
      }

      if (!pendingClient.documentVerified) {
        return ctx.badRequest("Government ID is not verified.");
      }

      // 3. Validate images
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

      // 4. Convert to buffer
      const [selfieRes, idRes] = await Promise.all([
        axios.get<ArrayBuffer>(fullSelfieUrl, {
          responseType: "arraybuffer",
        }),
        axios.get<ArrayBuffer>(fullIdUrl, {
          responseType: "arraybuffer",
        }),
      ]);

      let selfieBuffer: Buffer = Buffer.from(selfieRes.data as any);
      let idBuffer: Buffer = Buffer.from(idRes.data as any);

      // Ensure buffers are optimized (< 1MB) for AWS Rekognition
      if (selfieBuffer.length > 1024 * 1024) {
        try {
          selfieBuffer = await sharp(selfieBuffer)
            .rotate()
            .resize({
              width: 1200,
              height: 1200,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (_) { }
      }

      if (idBuffer.length > 1024 * 1024) {
        try {
          idBuffer = await sharp(idBuffer)
            .rotate()
            .resize({
              width: 1600,
              height: 1600,
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (_) { }
      }

      // 5. AWS compare
      const result = await compareFaces(selfieBuffer, idBuffer);

      // check existing
      const existingClient = await strapi.db.query(CLIENT_UID).findOne({
        where: {
          user: pendingClient.user.id,
        },
      });

      if (existingClient) {
        return ctx.badRequest("Client already exists.");
      }

      // 🔥 6. Decide status
      const approved = result.similarity >= 90;

      const verificationStatus = approved ? "approved" : "in-review";

      await strapi.entityService.update(
        "plugin::users-permissions.user",
        pendingClient.user.id,
        {
          data: {
            verification_status: verificationStatus,
          },
        },
      );

      if (verificationStatus === "in-review") {
        return ctx.send({
          success: true,
          status: "in-review",
          similarity: result.similarity,
          message: "Your verification has been submitted for manual review.",
        });
      }

      const { clientId } = await generateClientAssets();

      // CLIENT CREATION LOGIC
      const client = await strapi.entityService.create(CLIENT_UID, {
        data: {
          user: pendingClient.user.id,
          name: pendingClient.name,
          gender: pendingClient.gender,
          email: pendingClient.email,
          phoneNumber: pendingClient.phoneNumber,
          date_of_birth: pendingClient.date_of_birth,
          height: pendingClient.height,
          weight: pendingClient.weight,
          latitude: pendingClient.latitude,
          longitude: pendingClient.longitude,

          selfieUpload: pendingClient.selfieUpload.id,
          governmentId: pendingClient.governmentId.id,

          documentVerified: pendingClient.documentVerified,
          documentType: pendingClient.documentType,

          faceSimilarity: result.similarity,
          clientId: clientId,
        },
      });

      /* 🔥 FETCH CLIENT WITH MEDIA */
      const fullClient = await strapi.entityService.findOne(
        CLIENT_UID,
        client.id,
        {
          populate: {
            selfieUpload: true,
            governmentId: true,
            user: true,
          },
        },
      );

      /* 🧹 DELETE THE PENDING DRAFT AFTER SUCCESSFUL CREATION */
      await strapi.entityService.delete(PENDING_UID, pendingClient.id);

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
