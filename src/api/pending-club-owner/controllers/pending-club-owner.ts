import { Context } from "koa";

const PENDING_UID = "api::pending-club-owner.pending-club-owner";
const GOV_DOC_UID = "api::club-owner-document.club-owner-document";
const CLUB_UID = "api::club-owner.club-owner";

const UPLOAD_FOLDER_ID = 2;

/* ---------------- BODY PARSER ---------------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try { body = JSON.parse(body.data); } catch { }
  }
  return body;
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

/* ---------------- GET LATEST DRAFT (CRITICAL FIX) ---------------- */
async function getDraft(userId: number) {
  const drafts = await strapi.entityService.findMany(PENDING_UID, {
    filters: {
      user: { id: userId },   // ✔ correct relation filter
    },
    sort: { id: "desc" },
    limit: 1,
    populate: ["logo"],
  });

  return drafts?.[0] || null;
}

export default {

  /* ===================================================== */
  async me(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const existingClub = await strapi.db.query(CLUB_UID).findOne({
      where: { user: user.id },
    });

    if (existingClub) return ctx.send({ status: "completed" });

    let draft: any = await getDraft(user.id);

    if (!draft) {
      draft = await strapi.entityService.create(PENDING_UID, {
        data: { user: user.id, currentStep: 1, status: "draft" },
      });
    }

    ctx.send({
      id: draft.id,
      currentStep: draft.currentStep,
      status: draft.status,
    });
  },

  /* ===================================================== */
  async clubOwnerDetails(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = getBody(ctx);
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 1)
      return ctx.badRequest("Invalid step order");

    let logoId: number | null = null;

    if (files?.logo) {
      const uploaded = await uploadToFolder(files.logo);
      logoId = uploaded[0].id;
    }

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        clubName: body.clubName,
        ownerName: body.ownerName,
        phoneNumber: body.phoneNumber,
        email: body.email,
        logo: logoId,
        currentStep: 2,
      },
    });

    ctx.send({ nextStep: 2 });
  },

  /* ===================================================== */
  async mapLocation(ctx: Context) {
    const body = getBody(ctx);
    const draft: any = await getDraft(ctx.state.user.id);

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

  /* ===================================================== */
  async addressDetails(ctx: Context) {
    const body = getBody(ctx);
    const draft: any = await getDraft(ctx.state.user.id);

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

  /* ===================================================== */
  async configureClub(ctx: Context) {
    const body = getBody(ctx);
    const draft: any = await getDraft(ctx.state.user.id);

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

  /* ===================================================== */
  async uploadGovernmentDoc(ctx: Context) {
    const user = ctx.state.user;
    const body = getBody(ctx);
    const file = (ctx.request.files as any)?.file;

    if (!file) return ctx.badRequest("Please upload document");
    if (!body.documentName) return ctx.badRequest("Document name required");

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 5)
      return ctx.badRequest("You are not on government document step");

    const uploaded = await uploadToFolder(file);
    const fileId = uploaded[0].id;

    await strapi.entityService.create(GOV_DOC_UID, {
      data: {
        documentName: body.documentName,
        File: fileId,
        pending_club_owner: draft.id,
      },
    });

    ctx.send({ message: "Document uploaded" });
  },

  /* ===================================================== */
  async confirmGovernmentDocs(ctx: Context) {
    const draft: any = await getDraft(ctx.state.user.id);

    if (!draft || draft.currentStep !== 5)
      return ctx.badRequest("Upload documents first");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: { currentStep: 6 },
    });

    ctx.send({ nextStep: 6 });
  },

  /* ===================================================== */
  async uploadClubPhotos(ctx: Context) {

    const user = ctx.state.user;
    const files: any = ctx.request.files;

    const draft: any = await getDraft(user.id);
    if (!draft || draft.currentStep !== 6)
      return ctx.badRequest("Complete previous steps first");

    if (!files?.clubPhotos)
      return ctx.badRequest("Please upload club photos");

    console.log("STEP 6 START -------------------");
    let fullOwner: any = null;
    console.log("USER:", user.id);
    console.log("DRAFT ID:", draft.id);

    /* upload photos */
    const uploadedPhotos = await uploadToFolder(files.clubPhotos);
    const photoIds = uploadedPhotos.map((f: any) => f.id);
    console.log("Uploaded photos:", photoIds);

    const updatedDraft: any = await strapi.entityService.findOne(
      PENDING_UID,
      draft.id,
      { populate: ["logo"] }
    );

    const logoId = updatedDraft.logo?.id ?? null;

    /* create club owner */
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
        publishedAt: new Date(),
      },
    });

    console.log("CLUB OWNER CREATED:", clubOwner.id);

    /* ⭐⭐ CORRECT DOCUMENT TRANSFER */
    const myDocs = await strapi.entityService.findMany(GOV_DOC_UID, {
      filters: {
        pending_club_owner: { id: draft.id },   // THE REAL FIX
      },
    });

    console.log("DOCS BELONGING TO THIS DRAFT:", myDocs.length);

    for (const doc of myDocs) {
      console.log("TRANSFERRING DOC:", doc.id);

      await strapi.entityService.update(GOV_DOC_UID, doc.id, {
        data: {
          club_owner: clubOwner.id,
          pending_club_owner: null,
        },
      });

      console.log("TRANSFER COMPLETE:", doc.id);
    }

    // 🔥 CRITICAL: Sync parent side relation (Strapi v5 requirement)
const docIds = myDocs.map((d: any) => ({ id: d.id }));

await strapi.entityService.update(CLUB_UID, clubOwner.id, {
  data: {
    club_owner_documents: {
      connect: docIds,
    }as any,
  },
});

    /* FINAL FETCH WITH DOCUMENTS */
    fullOwner = await strapi.entityService.findOne(CLUB_UID, clubOwner.id, {
      populate: {
        user: true, 
        logo: true,
        clubPhotos: true,
        club_owner_documents: true
      },
    });

    /* delete draft */
    console.log("DELETING DRAFT:", draft.id);
    await strapi.entityService.delete(PENDING_UID, draft.id);

    console.log("STEP 6 END -------------------");

    ctx.send({
      success: true,
      message: "Club Owner profile created successfully",
     
    });
  }

};