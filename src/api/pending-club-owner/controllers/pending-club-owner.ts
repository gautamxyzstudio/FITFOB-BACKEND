import { Context } from "koa";

const PENDING_UID = "api::pending-club-owner.pending-club-owner";
const CLUB_UID = "api::club-owner.club-owner";
const UPLOAD_FOLDER_ID = 1; // API Uploads folder id

/* -------- safely read body (form-data or json) -------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};

  if (body.data && typeof body.data === "string") {
    try {
      body = JSON.parse(body.data);
    } catch {}
  }
  return body;
}

/* -------- get user draft -------- */
async function getDraft(userId: number) {
  return await strapi.db.query(PENDING_UID).findOne({
    where: { user: userId },
    populate: ["logo", "clubPhotos"],
  });
}

export default {

  /* ================= START / RESUME ================= */
  async me(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    // prevent multiple clubs
    const existingClub = await strapi.db.query(CLUB_UID).findOne({
      where: { user: user.id },
    });

    if (existingClub) return ctx.send({ status: "completed" });

    let draft: any = await getDraft(user.id);

    if (!draft) {
      draft = await strapi.entityService.create(PENDING_UID, {
        data: {
          user: user.id,
          currentStep: 1,
          status: "draft",
        },
      });
    }

    ctx.send({
      id: draft.id,
      currentStep: draft.currentStep,
      status: draft.status,
    });
  },

  /* ================= STEP 1 : CLUB + OWNER + LOGO ================= */
  async clubOwnerDetails(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = getBody(ctx);
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 1)
      return ctx.badRequest("Invalid step order");

    let logoId: number | null = null;

    /* ---------- upload logo into folder ---------- */
    if (files && files.logo) {
      const uploaded = await strapi
        .plugin("upload")
        .service("upload")
        .upload({
          data: { folder: UPLOAD_FOLDER_ID },
          files: Array.isArray(files.logo) ? files.logo : [files.logo],
        });

      logoId = uploaded[0].id;
    }

    /* ---------- save step 1 ---------- */
    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        clubName: body.clubName,
        ownerName: body.ownerName,
        phoneNumber: body.phoneNumber,
        email: body.email,
        logo: logoId, // attach media
        currentStep: 2,
      },
    });

    ctx.send({ nextStep: 2 });
  },

  /* ================= STEP 2 : MAP LOCATION ================= */
  async mapLocation(ctx: Context) {
    const user = ctx.state.user;
    const body = getBody(ctx);

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 2)
      return ctx.badRequest("Invalid step order");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        latitude: body.latitude,
        longitude: body.longitude,
        currentStep: 3,
      },
    });

    ctx.send({ nextStep: 3 });
  },

  /* ================= STEP 3 : ADDRESS DETAILS ================= */
  async addressDetails(ctx: Context) {
    const user = ctx.state.user;
    const body = getBody(ctx);

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 3)
      return ctx.badRequest("Invalid step order");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        clubAddress: body.clubAddress,
        city: body.city,
        state: body.state,
        pincode: body.pincode,
        currentStep: 4,
      },
    });

    ctx.send({ nextStep: 4 });
  },

  /* ================= STEP 4 : CONFIGURE CLUB ================= */
  async configureClub(ctx: Context) {
    const user = ctx.state.user;
    const body = getBody(ctx);

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 4)
      return ctx.badRequest("Invalid step order");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        services: body.services,
        facilities: body.facilities,
        openingTime: body.openingTime,
        closingTime: body.closingTime,
        weekday: body.weekday,
        weekend: body.weekend,
        currentStep: 5,
      },
    });

    ctx.send({ nextStep: 5 });
  },

  /* ================= STEP 5 : PHOTOS + CREATE CLUB ================= */
  async uploadClubPhotos(ctx: Context) {
    const user = ctx.state.user;
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 5)
      return ctx.badRequest("Complete previous steps first");

    if (!files || !files.clubPhotos)
      return ctx.badRequest("Please upload club photos");

    /* ---------- upload gallery into folder ---------- */
    const uploadedPhotos = await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        data: { folder: UPLOAD_FOLDER_ID },
        files: Array.isArray(files.clubPhotos)
          ? files.clubPhotos
          : [files.clubPhotos],
      });

    const photoIds = uploadedPhotos.map((f: any) => f.id);

    const updatedDraft: any = await strapi.entityService.findOne(
      PENDING_UID,
      draft.id,
      { populate: ["logo"] }
    );

    const logoId = updatedDraft.logo?.id ?? null;

    /* ---------- CREATE FINAL CLUB OWNER ---------- */
    const clubOwner = await strapi.entityService.create(CLUB_UID, {
      data: {
        user: user.id,
        ownerName: updatedDraft.ownerName,
        phoneNumber: updatedDraft.phoneNumber,
        email: updatedDraft.email,
        clubName: updatedDraft.clubName,
        openingTime: updatedDraft.openingTime,
        closingTime: updatedDraft.closingTime,
        weekday: updatedDraft.weekday,
        weekend: updatedDraft.weekend,
        facilities: updatedDraft.facilities,
        services: updatedDraft.services,
        latitude: updatedDraft.latitude,
        longitude: updatedDraft.longitude,
        clubAddress: updatedDraft.clubAddress,
        pincode: updatedDraft.pincode,
        city: updatedDraft.city,
        state: updatedDraft.state,
        logo: logoId,
        clubPhotos: photoIds,
      },
    });

    /* delete draft */
    await strapi.entityService.delete(PENDING_UID, draft.id);

    ctx.send({
      success: true,
      message: "Club profile created successfully",
      clubOwner,
    });
  },
};
