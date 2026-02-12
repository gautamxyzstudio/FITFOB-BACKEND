import { Context } from "koa";

const PENDING_UID = "api::pending-club-owner.pending-club-owner";
const CLUB_UID = "api::club-owner.club-owner";

/* helper */
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

    // PREVENT MULTIPLE CLUBS PER USER
    const existingClub = await strapi.db.query(CLUB_UID).findOne({
      where: { user: user.id },
    });

    if (existingClub) {
      return ctx.send({ status: "completed" });
    }

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

  /* ================= STEP 1 : CLUB DETAILS + LOGO ================= */
  async clubDetails(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body: any = ctx.request.body;
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 1)
      return ctx.badRequest("Invalid step order");

    let logoId: number | null = null;

    /* upload logo */
    if (files && files.logo) {
      const uploadedLogo = await strapi
        .plugin("upload")
        .service("upload")
        .upload({
          data: {},
          files: Array.isArray(files.logo) ? files.logo : [files.logo],
        });

      logoId = uploadedLogo[0].id;
    }

    /* SAVE STEP 1 */
    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        clubName: body.clubName,
        latitude: body.latitude,
        longitude: body.longitude,
        clubAddress: body.clubAddress,
        city: body.city,
        state: body.state,
        pincode: body.pincode,

        // MEDIA ATTACH (THIS FIXES YOUR LOGO)
        logo: logoId,

        currentStep: 2,
      },
    });

    ctx.send({ nextStep: 2 });
  },

  /* ================= STEP 2 : PERSONAL DETAILS ================= */
  async personalDetails(ctx: Context) {
    const user = ctx.state.user;
    const body: any = ctx.request.body;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 2)
      return ctx.badRequest("Invalid step order");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        ownerName: body.ownerName,
        phoneNumber: body.phoneNumber,
        email: body.email,
        currentStep: 3,
      },
    });

    ctx.send({ nextStep: 3 });
  },

  /* ================= STEP 3 : CONFIGURE CLUB ================= */
  async configureClub(ctx: Context) {
    const user = ctx.state.user;
    const body: any = ctx.request.body;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 3)
      return ctx.badRequest("Invalid step order");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        services: body.services,
        facilities: body.facilities,
        openingTime: body.openingTime,
        closingTime: body.closingTime,
        weekday: body.weekday,
        weekend: body.weekend,
        currentStep: 4,
      },
    });

    ctx.send({ nextStep: 4 });
  },

  /* ================= STEP 4 : PHOTOS + CREATE CLUB ================= */
  async uploadClubPhotos(ctx: Context) {
    const user = ctx.state.user;
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 4)
      return ctx.badRequest("Complete previous steps first");

    if (!files || !files.clubPhotos)
      return ctx.badRequest("Please upload club photos");

    /* upload photos */
    const uploadedPhotos = await strapi
      .plugin("upload")
      .service("upload")
      .upload({
        data: {},
        files: Array.isArray(files.clubPhotos)
          ? files.clubPhotos
          : [files.clubPhotos],
      });

    const photoIds = uploadedPhotos.map((file: any) => file.id);

    /* get updated draft */
    const updatedDraft: any = await strapi.entityService.findOne(
      PENDING_UID,
      draft.id,
      { populate: ["logo"] }
    );

    const logoId = updatedDraft.logo?.id ?? null;

    /* CREATE FINAL CLUB OWNER */
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

        // MEDIA ATTACH
        logo: logoId,
        clubPhotos: photoIds,
      },
    });

    /* DELETE TEMP RECORD */
    await strapi.entityService.delete(PENDING_UID, draft.id);

    ctx.send({
      success: true,
      message: "Club profile created successfully",
      clubOwner,
    });
  },
};
