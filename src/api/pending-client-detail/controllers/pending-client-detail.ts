import { Context } from "koa";
import axios from "axios";
import { compareFaces } from "../../../utils/awsRekognition";
import { validateGovernmentDocument } from "../../../services/aws-document-validator";
const PENDING_UID = "api::pending-client-detail.pending-client-detail";
const CLIENT_UID = "api::client-detail.client-detail";

const UPLOAD_FOLDER_ID = 2;

/* ---------- SAFE BODY PARSER ---------- */
function getBody(ctx: Context) {
  let body: any = ctx.request.body || {};
  if (body.data && typeof body.data === "string") {
    try { body = JSON.parse(body.data); } catch { }
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

    const files: any = ctx.request.files;

    if (!files || !files.governmentId) {
      return ctx.badRequest("Please upload government ID");
    }

    const uploadService = strapi.plugin("upload").service("upload");

    const rawFile = Array.isArray(files.governmentId)
      ? files.governmentId[0]
      : files.governmentId;

    // Upload file
    const uploaded = await uploadService.upload({
      data: {
        fileInfo: {
          folder: UPLOAD_FOLDER_ID,
        },
      },
      files: rawFile,
    });

    const idFile = uploaded[0];

    try {
      /* ==========================================
         DOWNLOAD FILE
      ========================================== */

      const fileUrl = idFile.url.startsWith("http")
        ? idFile.url
        : `${strapi.config.get("server.url")}${idFile.url}`;

      const response = await axios.get<ArrayBuffer>(fileUrl, {
        responseType: "arraybuffer",
      });

      const buffer = Buffer.from(response.data);

      /* ==========================================
         VALIDATE DOCUMENT (AWS)
      ========================================== */

      // You'll implement this service next
      const documentResult = await validateGovernmentDocument(buffer);

      if (!documentResult.valid) {
        // Delete uploaded media
        await uploadService.remove(idFile);

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
         SAVE TO PENDING DRAFT
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

      // Cleanup uploaded media if AWS fails
      try {
        await uploadService.remove(idFile);
      } catch (_) { }

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

      // 1. Fetch client
      const pendingClient: any = await strapi.entityService.findOne(
        PENDING_UID,
        draft.id,
        {
          populate: ["selfieUpload", "governmentId", "user"],
        }
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

      const fullIdUrl = idUrl.startsWith("http")
        ? idUrl
        : `${baseUrl}${idUrl}`;

      // 4. Convert to buffer
      const [selfieRes, idRes] = await Promise.all([
        axios.get<ArrayBuffer>(fullSelfieUrl, {
          responseType: "arraybuffer",
        }),
        axios.get<ArrayBuffer>(fullIdUrl, {
          responseType: "arraybuffer",
        }),
      ]);

      const selfieBuffer = Buffer.from(selfieRes.data);
      const idBuffer = Buffer.from(idRes.data);

      // 5. AWS compare
      const result = await compareFaces(selfieBuffer, idBuffer);

      // check existing
      const existingClient = await strapi.db
        .query(CLIENT_UID)
        .findOne({
          where: {
            user: pendingClient.user.id,
          },
        });

      if (existingClient) {
        return ctx.badRequest("Client already exists.");
      }

      // 🔥 6. Decide status
      const approved = result.similarity >= 90;

      const verificationStatus = approved
        ? "approved"
        : "in-review";

      await strapi.entityService.update(
        "plugin::users-permissions.user",
        pendingClient.user.id,
        {
          data: {
            verification_status: verificationStatus,
          },
        }
      );

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
        }
      );

      /* 🧹 DELETE THE PENDING DRAFT AFTER SUCCESSFUL CREATION */
      await strapi.entityService.delete(
        PENDING_UID,
        pendingClient.id
      );

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

  //   async governmentId(ctx: Context) {
  //     const draft: any = await getEditableDraft(ctx);
  //     if (!draft) return;

  //     const validationError = await validateBeforeClientCreation(draft);
  //     if (validationError) return ctx.badRequest(validationError);

  //     const sessionUser = ctx.state.user;
  //     const user = await getFullUser(sessionUser.id);
  //     const files: any = ctx.request.files;

  //     if (!files || !files.governmentId)
  //       return ctx.badRequest("Please upload government ID");

  //     const uploadService = strapi.plugin("upload").service("upload");

  //     const rawFile = Array.isArray(files.governmentId)
  //       ? files.governmentId[0]
  //       : files.governmentId;

  //     const uploaded = await uploadService.upload({
  //       data: { fileInfo: { folder: UPLOAD_FOLDER_ID } },
  //       files: rawFile,
  //     });

  //     const idFile = uploaded[0];

  //     const finalDraft: any = await strapi.entityService.findOne(
  //       PENDING_UID,
  //       draft.id,
  //       { populate: ["selfieUpload"] }
  //     );

  //     // CLIENT CREATION LOGIC 
  //     const client = await strapi.entityService.create(CLIENT_UID, {
  //       data: {
  //         user: user.id,
  //         name: finalDraft.name,
  //         gender: finalDraft.gender,
  //         email: finalDraft.email,
  //         phoneNumber: finalDraft.phoneNumber,
  //         date_of_birth: finalDraft.date_of_birth,
  //         height: finalDraft.height,
  //         weight: finalDraft.weight,
  //         latitude: finalDraft.latitude,
  //         longitude: finalDraft.longitude,
  //         selfieUpload: finalDraft.selfieUpload?.id ?? null,
  //         governmentId: idFile.id,
  //         approvedAt: new Date(),
  //       },
  //     });

  //     // 🔒 lock draft (DO NOT DELETE)
  //     await strapi.entityService.update(PENDING_UID, draft.id, {
  //       data: {
  //         status: "completed",
  //         governmentId: idFile.id,
  //         currentStep: 5,
  //       },
  //     });

  //     /* 🔥 FETCH CLIENT WITH MEDIA */
  //     const fullClient = await strapi.entityService.findOne(
  //       CLIENT_UID,
  //       client.id,
  //       {
  //         populate: {
  //           selfieUpload: true,
  //           governmentId: true,
  //           user: true,
  //         },
  //       }
  //     );

  //     /* 🧹 DELETE THE PENDING DRAFT AFTER SUCCESSFUL CREATION */
  // await strapi.entityService.delete(PENDING_UID, draft.id);

  //     ctx.send({
  //       success: true,
  //       message: "Client profile created successfully",
  //       client: fullClient,
  //     });
  //   },

   //   async verifyClientId(ctx: Context) {
  //     try {
  //       const { clientId } = ctx.params;

  //       if (!clientId) {
  //         return ctx.badRequest("clientId is required");
  //       }

  //       // 1. Fetch client
  //       const client: any = await strapi.entityService.findOne(
  //         "api::client-detail.client-detail",
  //         clientId,
  //         {
  //           populate: ["selfieUpload", "governmentId"],
  //         }
  //       );

  //       if (!client) {
  //         return ctx.notFound("Client not found");
  //       }

  //       // 🔥 2. If already verified → return cached result
  //       if (client.faceMatched !== null && client.faceMatched !== undefined) {
  //         return ctx.send({
  //           success: true,
  //           clientId,
  //           matched: client.faceMatched,
  //           similarity: client.faceSimilarity,
  //           source: "cache", // 🔥 important
  //         });
  //       }

  //       // 3. Validate images
  //       if (!client.selfieUpload || !client.governmentId) {
  //         return ctx.badRequest("Selfie or Government ID missing");
  //       }

  //       const selfieUrl: string = client.selfieUpload.url;
  //       const idUrl: string = client.governmentId.url;

  //       const baseUrl =
  //         strapi.config.get("server.url") || "http://localhost:1337/api";

  //       const fullSelfieUrl = selfieUrl.startsWith("http")
  //         ? selfieUrl
  //         : `${baseUrl}${selfieUrl}`;

  //       const fullIdUrl = idUrl.startsWith("http")
  //         ? idUrl
  //         : `${baseUrl}${idUrl}`;

  //       // 4. Convert to buffer
  //       const [selfieRes, idRes] = await Promise.all([
  //         axios.get<ArrayBuffer>(fullSelfieUrl, {
  //           responseType: "arraybuffer",
  //         }),
  //         axios.get<ArrayBuffer>(fullIdUrl, {
  //           responseType: "arraybuffer",
  //         }),
  //       ]);

  //       const selfieBuffer = Buffer.from(selfieRes.data);
  //       const idBuffer = Buffer.from(idRes.data);

  //       // 5. AWS compare
  //       const result = await compareFaces(selfieBuffer, idBuffer);

  //       // 🔥 6. Decide status (business logic)
  //       let matched = false;

  //       if (result.similarity >= 90) {
  //         matched = true; // auto approve
  //       } else if (result.similarity >= 80) {
  //         matched = false; // manual review zone
  //       } else {
  //         matched = false; // reject
  //       }

  //       // 7. Save result (IMPORTANT)
  //       await strapi.entityService.update(
  //         "api::client-detail.client-detail",
  //         clientId,
  //         {
  //           data: {
  //             faceMatched: matched,
  //             faceSimilarity: result.similarity,
  //             approvedAt: matched ? new Date() : null,
  //           },
  //         }
  //       );

  //       // 8. Response
  //       return ctx.send({
  //         success: true,
  //         clientId,
  //         matched,
  //         similarity: result.similarity,
  //         source: "aws",
  //       });
  //     } catch (error) {
  //       console.error("VERIFY ERROR:", error);
  //       return ctx.internalServerError("Verification failed");
  //     }
  //   },

};

