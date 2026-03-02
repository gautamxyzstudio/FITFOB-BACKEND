import { Context } from "koa";
import { generateClubId } from "../../../utils/generateClubId";

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
      data: { user: user.id, status: "draft", currentStep: 1 },
    });
    return draft;
  }

  if (draft.status === "completed") {
    ctx.badRequest("Your onboarding is already completed.");
    return null;
  }

  return draft;
}

/* ---------------- SUBMISSION VALIDATION ---------------- */
async function validateBeforeSubmission(draft: any) {

  if (!draft.clubName || !draft.ownerName || !draft.phoneNumber || !draft.email)
    return "Please complete owner details";

  if (!draft.latitude || !draft.longitude)
    return "Please set map location";

  if (!draft.clubAddress || !draft.city || !draft.state || !draft.pincode)
    return "Please complete address details";

  if (!draft.openingTime || !draft.closingTime || !draft.clubCategory)
    return "Please configure your club";

  const docs = await strapi.entityService.findMany(GOV_DOC_UID, {
    filters: { pending_club_owner: { id: draft.id } },
  });

  if (!docs || docs.length === 0)
    return "Please upload at least one government document";

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

export default {

  /* ===================================================== */
  async me(ctx: Context) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const existingClub = await strapi.db.query(CLUB_UID).findOne({
      where: { user: user.id },
    });

    if (existingClub) {
      return ctx.send({ status: "completed", currentStep: 6 });
    }

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
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    const body = getBody(ctx);
    const files: any = ctx.request.files;

    let logoId = draft.logo?.id ?? null;

    if (files?.logo) {
      if (draft.logo?.id) {
        await strapi.plugin("upload").service("upload").remove(draft.logo);
      }
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
        currentStep: Math.max(draft.currentStep || 1, 2),
      },
    });

    ctx.send({ nextStep: 2 });
  },

  /* ===================================================== */
  async mapLocation(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

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

    const body = getBody(ctx);
    const allowedCategories = ["Basic", "Premium", "Luxury"];
    if (!allowedCategories.includes(body.clubCategory))
      return ctx.badRequest("Invalid club category");

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: {
        services: body.services,
        facilities: body.facilities,
        openingTime: body.openingTime,
        closingTime: body.closingTime,
        weekday: body.weekday,
        weekend: body.weekend,
        clubCategory: body.clubCategory,
        currentStep: Math.max(draft.currentStep || 1, 5),
      },
    });

    ctx.send({ nextStep: 5 });
  },

  /* ===================================================== */
  async uploadGovernmentDoc(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

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
        await strapi.plugin("upload").service("upload").remove(existingDoc[0].File);
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

  /* ===================================================== */
  async confirmGovernmentDocs(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    await strapi.entityService.update(PENDING_UID, draft.id, {
      data: { currentStep: Math.max(draft.currentStep || 1, 6) },
    });

    ctx.send({ nextStep: 6 });
  },

  /* ===================================================== */
  async uploadClubPhotos(ctx: Context) {
    const draft: any = await getEditableDraft(ctx);
    if (!draft) return;

    const validationError = await validateBeforeSubmission(draft);
    if (validationError) return ctx.badRequest(validationError);

    const user = ctx.state.user;
    const files: any = ctx.request.files;

    if (!files?.clubPhotos)
      return ctx.badRequest("Please upload club photos");

    const uploadedPhotos = await uploadToFolder(files.clubPhotos);
    const photoIds = uploadedPhotos.map((f: any) => f.id);

    const updatedDraft: any = await strapi.entityService.findOne(
      PENDING_UID,
      draft.id,
      { populate: ["logo"] }
    );

    const logoId = updatedDraft.logo?.id ?? null;

    const newClubId = await generateClubId();
    const clubOwner = await strapi.entityService.create(CLUB_UID, {
      data: {
        user: user.id,
        clubId: newClubId,
        ownerName: updatedDraft.ownerName,
        phoneNumber: updatedDraft.phoneNumber,
        email: updatedDraft.email,
        clubName: updatedDraft.clubName,
        openingTime: updatedDraft.openingTime,
        closingTime: updatedDraft.closingTime,
        weekday: updatedDraft.weekday,
        weekend: updatedDraft.weekend,
        clubCategory: updatedDraft.clubCategory,
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

    const myDocs = await strapi.entityService.findMany(GOV_DOC_UID, {
      filters: { pending_club_owner: { id: draft.id } },
    });

    for (const doc of myDocs) {
      await strapi.entityService.update(GOV_DOC_UID, doc.id, {
        data: { club_owner: clubOwner.id, pending_club_owner: null },
      });
    }

    const docIds = myDocs.map((d: any) => ({ id: d.id }));

    await strapi.entityService.update(CLUB_UID, clubOwner.id, {
      data: { club_owner_documents: { connect: docIds } as any },
    });

    /* ---------- DELETE PENDING ONBOARDING ---------- */
    await strapi.entityService.delete(PENDING_UID, draft.id);

    ctx.send({
      success: true,
      message: "Club Owner profile created successfully",
    });
  }

};

