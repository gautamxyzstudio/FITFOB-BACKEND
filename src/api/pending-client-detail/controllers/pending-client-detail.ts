import { Context } from "koa";

const PENDING_UID = "api::pending-client-detail.pending-client-detail";
const CLIENT_UID = "api::client-detail.client-detail";

const UPLOAD_FOLDER_ID = 2;

/* ---------- SAFE BODY PARSER ---------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try { body = JSON.parse(body.data); } catch {}
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
async function validateBeforeClientCreation(draft: any) {
  if (!draft.name || !draft.gender)
    return "Please complete basic information";

  if (!draft.date_of_birth)
    return "Please complete body information";

  if (!draft.latitude || !draft.longitude)
    return "Please set your location";

  if (!draft.selfieUpload)
    return "Please upload selfie";

  return null;
}

export default {

/* ================= START / RESUME ================= */
async me(ctx: Context) {
  const sessionUser = ctx.state.user;
  if (!sessionUser) return ctx.unauthorized("Login required");

  const user = await getFullUser(sessionUser.id);

  const existing = await strapi.db.query(CLIENT_UID).findOne({
    where: { user: user.id },
  });

  if (existing) return ctx.send({ status: "completed", currentStep: 5 });

  let draft: any = await getDraft(user.id);

  if (!draft) {
    draft = await strapi.entityService.create(PENDING_UID, {
      data: {
        user: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber || null,
        currentStep: 1,
        status: "draft",
      },
    });
  }

  ctx.send({
    currentStep: draft.currentStep,
    status: draft.status,
  });
},

/* ================= STEP 1 BASIC INFO ================= */
async basicInfo(ctx: Context) {
  const draft: any = await getEditableDraft(ctx);
  if (!draft) return;

  const sessionUser = ctx.state.user;
  const user = await getFullUser(sessionUser.id);
  const body = getBody(ctx);

  await strapi.entityService.update(PENDING_UID, draft.id, {
    data: {
      name: body.name,
      gender: body.gender,
      email: body.email || user.email,
      phoneNumber: body.phoneNumber || user.phoneNumber,
      currentStep: Math.max(draft.currentStep || 1, 2),
    },
  });

  ctx.send({ nextStep: 2 });
},

/* ================= STEP 2 BODY INFO ================= */
async bodyInfo(ctx: Context) {
  const draft: any = await getEditableDraft(ctx);
  if (!draft) return;

  const body = getBody(ctx);

  if (!body.date_of_birth)
    return ctx.badRequest("date_of_birth is required");

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

  const files: any = ctx.request.files;
  if (!files || !files.selfieUpload)
    return ctx.badRequest("Please upload selfie");

  // replace old selfie
  if (draft.selfieUpload?.id) {
    await strapi.plugin("upload").service("upload").remove(draft.selfieUpload);
  }

  const uploadService = strapi.plugin("upload").service("upload");
  const rawFile = Array.isArray(files.selfieUpload)
    ? files.selfieUpload[0]
    : files.selfieUpload;

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

  const validationError = await validateBeforeClientCreation(draft);
  if (validationError) return ctx.badRequest(validationError);

  const sessionUser = ctx.state.user;
  const user = await getFullUser(sessionUser.id);
  const files: any = ctx.request.files;

  if (!files || !files.governmentId)
    return ctx.badRequest("Please upload government ID");

  const uploadService = strapi.plugin("upload").service("upload");

  const rawFile = Array.isArray(files.governmentId)
    ? files.governmentId[0]
    : files.governmentId;

  const uploaded = await uploadService.upload({
    data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
    files: rawFile,
  });

  const idFile = uploaded[0];

  const finalDraft: any = await strapi.entityService.findOne(
    PENDING_UID,
    draft.id,
    { populate: ["selfieUpload"] }
  );

  // 🔴 EXISTING CLIENT CREATION LOGIC (UNCHANGED)
  const client = await strapi.entityService.create(CLIENT_UID, {
    data: {
      user: user.id,
      name: finalDraft.name,
      gender: finalDraft.gender,
      email: finalDraft.email,
      phoneNumber: finalDraft.phoneNumber,
      date_of_birth: finalDraft.date_of_birth,
      height: finalDraft.height,
      weight: finalDraft.weight,
      latitude: finalDraft.latitude,
      longitude: finalDraft.longitude,
      selfieUpload: finalDraft.selfieUpload?.id ?? null,
      governmentId: idFile.id,
      approvedAt: new Date(),
    },
  });

  // 🔒 lock draft (DO NOT DELETE)
  await strapi.entityService.update(PENDING_UID, draft.id, {
    data: {
      status: "completed",
      governmentId: idFile.id,
      currentStep: 5,
    },
  });

  ctx.send({
    success: true,
    message: "Client profile created successfully",
    client,
  });
},

};

