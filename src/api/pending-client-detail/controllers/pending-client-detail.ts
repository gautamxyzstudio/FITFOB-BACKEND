import { Context } from "koa";

const PENDING_UID = "api::pending-client-detail.pending-client-detail";
const CLIENT_UID = "api::client-detail.client-detail";

/* 🔴 IMPORTANT: this is the numeric folder id visible in Media Library URL */
const UPLOAD_FOLDER_ID = 1;

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

export default {

/* ================= START / RESUME ================= */
async me(ctx: Context) {
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized("Login required");

const user = await getFullUser(sessionUser.id);

const existing = await strapi.db.query(CLIENT_UID).findOne({
  where: { user: user.id },
});

if (existing) return ctx.send({ status: "completed" });

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
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized();

const user = await getFullUser(sessionUser.id);
const body = getBody(ctx);
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 1)
  return ctx.badRequest("Invalid step order");

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    name: body.name,
    gender: body.gender,
    email: body.email || user.email,
    phoneNumber: body.phoneNumber || user.phoneNumber,
    currentStep: 2,
  },
});

ctx.send({ nextStep: 2 });

},

/* ================= STEP 2 BODY INFO ================= */
async bodyInfo(ctx: Context) {
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized();

const user = await getFullUser(sessionUser.id);
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
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized();

const user = await getFullUser(sessionUser.id);
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

/* ================= STEP 4 SELFIE ================= */
async selfie(ctx: Context) {
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized();

const user = await getFullUser(sessionUser.id);
const files: any = ctx.request.files;
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 4)
  return ctx.badRequest("Invalid step order");

if (!files || !files.selfieUpload)
  return ctx.badRequest("Please upload selfie");

const uploadService = strapi.plugin("upload").service("upload");

const rawFile = Array.isArray(files.selfieUpload)
  ? files.selfieUpload[0]
  : files.selfieUpload;

const uploaded = await uploadService.upload({
  data: {
    fileInfo: {
      folder: UPLOAD_FOLDER_ID, // 🔴 THIS is the real v5 fix
    },
  },
  files: rawFile,
});

const file = uploaded[0];

await strapi.entityService.update(PENDING_UID, draft.id, {
  data: {
    selfieUpload: file.id,
    currentStep: 5,
  },
});

ctx.send({
  nextStep: 5,
  fileUrl: file.url,
});

},

/* ================= STEP 5 GOVERNMENT ID ================= */
async governmentId(ctx: Context) {
const sessionUser = ctx.state.user;
if (!sessionUser) return ctx.unauthorized();

const user = await getFullUser(sessionUser.id);
const files: any = ctx.request.files;
const draft: any = await getDraft(user.id);

if (!draft || draft.currentStep !== 5)
  return ctx.badRequest("Invalid step order");

if (!files || !files.governmentId)
  return ctx.badRequest("Please upload government ID");

const uploadService = strapi.plugin("upload").service("upload");

const rawFile = Array.isArray(files.governmentId)
  ? files.governmentId[0]
  : files.governmentId;

const uploaded = await uploadService.upload({
  data: {
    fileInfo: {
      folder: UPLOAD_FOLDER_ID,
    },
  },
  files: rawFile,
});

const idFile = uploaded[0];

const finalDraft: any = await strapi.entityService.findOne(
  PENDING_UID,
  draft.id,
  { populate: ["selfieUpload"] }
);

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
    governmentId: idFile.id,
    approvedAt: new Date(),
  },
});

await strapi.entityService.delete(PENDING_UID, draft.id);

ctx.send({
  success: true,
  message: "Client profile created successfully",
  client,
});

},
};