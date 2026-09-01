import { factories } from "@strapi/strapi";

export default factories.createCoreController(
  "api::club-owner-document.club-owner-document",
  ({ strapi }) => ({
    /* ======================================================
       GET LOGGED-IN CLUB OWNER'S DOCUMENTS
    ====================================================== */

    async myDocuments(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Login required");
        }

        const clubOwner: any = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: {
              user: {
                id: user.id,
              },
            },
            populate: {
              club_owner_documents: {
                populate: {
                  File: true,
                },
              },
            },
          });

        if (!clubOwner) {
          return ctx.notFound("Club owner profile not found");
        }

        const documents = clubOwner.club_owner_documents ?? [];

        const formattedDocuments = documents.map((doc: any) => ({
          id: doc.id,
          documentId: doc.documentId,
          documentName: doc.documentName,

          file: doc.File
            ? {
                id: doc.File.id,
                name: doc.File.name,
                url: doc.File.url,
                mime: doc.File.mime,
              }
            : null,

          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        }));

        return ctx.send({
          data: formattedDocuments,
        });
      } catch (error) {
        strapi.log.error("GET CLUB OWNER DOCUMENTS ERROR", error);

        return ctx.internalServerError("Failed to get club owner documents");
      }
    },
  }),
);
