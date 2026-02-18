import { Context } from "koa";

const PENDING_UID = "api::pending-client-detail.pending-client-detail";
const CLIENT_UID = "api::client-detail.client-detail";
const UPLOAD_FOLDER_ID = 1;

/* ---------- SAFE BODY PARSER (handles form-data + json) ---------- */
function getBody(ctx: Context) {
let body: any = ctx.request.body || {};
if (body.data && typeof body.data === "string") {
try {
body = JSON.parse(body.data);
} catch {}
}
return body;
}

/* ---------- GET USER DRAFT ---------- */
async function getDraft(userId: number) {
return await strapi.db.query(PENDING_UID).findOne({
where: { user: userId },
populate: ["selfieUpload", "governmentId"],
});
}

export default {

/* ================= START / RESUME ONBOARDING ================= */
async me(ctx: Context) {
const user = ctx.state.user;
if (!user) return ctx.unauthorized("Login required");

// If client already created → onboarding finished
const existing = await strapi.db.query(CLIENT_UID).findOne({
  where: { user: user.id },
});

if (existing) {
  return ctx.send({ status: "completed" });
}

// find draft
let draft: any = await getDraft(user.id);

// create draft automatically first time
if (!draft) {
  draft = await strapi.entityService.create(PENDING_UID, {
    data: {
      user: user.id,
      email: user.email,
      phoneNumber: user.phone,
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
const user = ctx.state.user;
if (!user) return ctx.unauthorized();


const body = getBody(ctx);
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 1)
  return ctx.badRequest("Invalid step order");

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    name: body.name,
    gender: body.gender,
    email: user.email,
    phoneNumber: user.phone,
    currentStep: 2,
  },
});

ctx.send({ nextStep: 2 });


},

/* ================= STEP 2 BODY INFO ================= */
async bodyInfo(ctx: Context) {
const user = ctx.state.user;
if (!user) return ctx.unauthorized();

const body = getBody(ctx);
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 2)
  return ctx.badRequest("Invalid step order");

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    age: body.age,
    height: body.height,
    weight: body.weight,
    currentStep: 3,
  },
});

ctx.send({ nextStep: 3 });


},

/* ================= STEP 3 LOCATION ================= */
async location(ctx: Context) {
const user = ctx.state.user;
if (!user) return ctx.unauthorized();

const body = getBody(ctx);
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 3)
  return ctx.badRequest("Invalid step order");

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    latitude: body.latitude,
    longitude: body.longitude,
    currentStep: 4,
  },
});

ctx.send({ nextStep: 4 });

},

/* ================= STEP 4 SELFIE UPLOAD ================= */
async selfie(ctx: Context) {
const user = ctx.state.user;
if (!user) return ctx.unauthorized();

const files: any = ctx.request.files;
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 4)
  return ctx.badRequest("Invalid step order");

if (!files || !files.selfieUpload)
  return ctx.badRequest("Please upload selfie");

const uploaded = await strapi
  .plugin("upload")
  .service("upload")
  .upload({
    data: { folder: UPLOAD_FOLDER_ID },
    files: Array.isArray(files.selfieUpload)
      ? files.selfieUpload
      : [files.selfieUpload],
  });

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    selfieUpload: uploaded[0].id,
    currentStep: 5,
  },
});

ctx.send({ nextStep: 5 });

},

/* ================= STEP 5 GOVERNMENT ID (FINAL STEP) ================= */
async governmentId(ctx: Context) {
const user = ctx.state.user;
if (!user) return ctx.unauthorized();

const files: any = ctx.request.files;
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 5)
  return ctx.badRequest("Invalid step order");

if (!files || !files.governmentId)
  return ctx.badRequest("Please upload government ID");

/* upload ID */
const uploaded = await strapi
  .plugin("upload")
  .service("upload")
  .upload({
    data: { folder: UPLOAD_FOLDER_ID },
    files: Array.isArray(files.governmentId)
      ? files.governmentId
      : [files.governmentId],
  });

/* get full draft */
const finalDraft: any = await strapi.entityService.findOne(
  PENDING_UID,
  draft.id,
  { populate: ["selfieUpload"] }
);

/* CREATE REAL CLIENT DETAIL */
const client = await strapi.entityService.create(CLIENT_UID, {
  data: {
    user: user.id,
    name: finalDraft.name,
    gender: finalDraft.gender,
    email: finalDraft.email,
    phoneNumber: finalDraft.phoneNumber,
    age: finalDraft.age,
    height: finalDraft.height,
    weight: finalDraft.weight,
    latitude: finalDraft.latitude,
    longitude: finalDraft.longitude,
    selfieUpload: finalDraft.selfieUpload?.id ?? null,
    governmentId: uploaded[0].id,
    approvedAt: new Date(),
  },
});

/* DELETE PENDING RECORD */
await strapi.entityService.delete(PENDING_UID, draft.id);

ctx.send({
  success: true,
  message: "Client profile created successfully",
  client,
});

},
};
