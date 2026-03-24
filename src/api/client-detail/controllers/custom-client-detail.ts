import axios from "axios";
import { Context } from "koa";
import { compareFaces } from "../../../utils/awsRekognition";

export default {

  async getMyClientDetail(ctx) {

    try {

      /* GET LOGGED IN USER FROM TOKEN */
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      /* FIND CLIENT DETAIL FOR THIS USER */
      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          populate: {
            user: {
              fields: ["id", "username", "email"]
            },
            selfieUpload: true,
            governmentId: true
          }
        });

      if (!clientDetail) {
        return ctx.notFound("Client detail not found");
      }

      ctx.body = clientDetail;

    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError("Something went wrong");
    }

  },

  async markClientRead(ctx: any) {
    try {
      const admin = ctx.state.user;
      const { id } = ctx.params;

      if (!admin) {
        return ctx.unauthorized("Admin not found");
      }

      const client = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { id },
          select: ["id", "read_by_admins"],
        });

      if (!client) {
        return ctx.notFound("Client not found");
      }

      let readers = client.read_by_admins || [];

      if (!readers.includes(admin.id)) {
        readers.push(admin.id);

        await strapi.db
          .query("api::client-detail.client-detail")
          .update({
            where: { id },
            data: {
              read_by_admins: readers,
            },
          });
      }

      ctx.send({
        message: "Client request marked as read",
      });
    } catch (error) {
      strapi.log.error("CLIENT READ ERROR:", error);
      ctx.internalServerError("Something went wrong");
    }
  },

  async approvedClients(ctx: any) {
    try {

      const { search } = ctx.query as any;

      const data: any[] = await strapi.entityService.findMany(
        "api::client-detail.client-detail",
        {
          populate: {
            user: {
              populate: {
                role: true
              }
            },
            selfieUpload: true,
            governmentId: true
          },
          sort: { id: "desc" }
        }
      );

      // filter approved users
      let finalData = data.filter(
        (item: any) => item.user?.verification_status === "approved"
      );

      // 🔍 Search
      if (search?.trim()) {

        const searchValue = search.replace(/\s+/g, "").toLowerCase();

        finalData = finalData.filter((item: any) => {

          const name = item.name?.replace(/\s+/g, "").toLowerCase();
          const email = item.email?.replace(/\s+/g, "").toLowerCase();
          const phone = item.phoneNumber?.replace(/\s+/g, "").toLowerCase();

          return (
            name?.includes(searchValue) ||
            email?.includes(searchValue) ||
            phone?.includes(searchValue)
          );

        });
      }

      finalData = finalData.map(item => ({
        ...item,
        isRead: item.read_by_admins?.length > 0
      }));

      ctx.body = {
        success: true,
        total: finalData.length,
        data: finalData,
      };

    } catch (err) {
      console.error(err);
      ctx.throw(500, "Failed to fetch approved clients");
    }
  },

  async pendingClients(ctx: any) {
    try {

      const { search } = ctx.query as any;

      const data: any[] = await strapi.entityService.findMany(
        "api::client-detail.client-detail",
        {
          populate: {
            user: {
              populate: {
                role: true
              }
            },
            selfieUpload: true,
            governmentId: true
          },
          sort: { id: "desc" }
        }
      );

      // filter pending users
      let finalData = data.filter(
        (item: any) => item.user?.verification_status === "pending"
      );

      // 🔍 Search
      if (search?.trim()) {

        const searchValue = search.replace(/\s+/g, "").toLowerCase();

        finalData = finalData.filter((item: any) => {

          const name = item.name?.replace(/\s+/g, "").toLowerCase();
          const email = item.email?.replace(/\s+/g, "").toLowerCase();
          const phone = item.phoneNumber?.replace(/\s+/g, "").toLowerCase();

          return (
            name?.includes(searchValue) ||
            email?.includes(searchValue) ||
            phone?.includes(searchValue)
          );

        });
      }

      finalData = finalData.map(item => ({
        ...item,
        isRead: item.read_by_admins?.length > 0
      }));

      ctx.body = {
        success: true,
        total: finalData.length,
        data: finalData,
      };

    } catch (err) {
      console.error(err);
      ctx.throw(500, "Failed to fetch pending clients");
    }
  },

  async verifyClientId(ctx: Context) {
    try {
      const { clientId } = ctx.params;

      if (!clientId) {
        return ctx.badRequest("clientId is required");
      }

      // 1. Fetch client
      const client: any = await strapi.entityService.findOne(
        "api::client-detail.client-detail",
        clientId,
        {
          populate: ["selfieUpload", "governmentId"],
        }
      );

      if (!client) {
        return ctx.notFound("Client not found");
      }

      // 🔥 2. If already verified → return cached result
      if (client.faceMatched !== null && client.faceMatched !== undefined) {
        return ctx.send({
          success: true,
          clientId,
          matched: client.faceMatched,
          similarity: client.faceSimilarity,
          source: "cache", // 🔥 important
        });
      }

      // 3. Validate images
      if (!client.selfieUpload || !client.governmentId) {
        return ctx.badRequest("Selfie or Government ID missing");
      }

      const selfieUrl: string = client.selfieUpload.url;
      const idUrl: string = client.governmentId.url;

      const baseUrl =
        strapi.config.get("server.url") || "http://localhost:1337/api";

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

      // 🔥 6. Decide status (business logic)
      let matched = false;

      if (result.similarity >= 90) {
        matched = true; // auto approve
      } else if (result.similarity >= 80) {
        matched = false; // manual review zone
      } else {
        matched = false; // reject
      }

      // 7. Save result (IMPORTANT)
      await strapi.entityService.update(
        "api::client-detail.client-detail",
        clientId,
        {
          data: {
            faceMatched: matched,
            faceSimilarity: result.similarity,
            approvedAt: matched ? new Date() : null,
          },
        }
      );

      // 8. Response
      return ctx.send({
        success: true,
        clientId,
        matched,
        similarity: result.similarity,
        source: "aws",
      });
    } catch (error) {
      console.error("VERIFY ERROR:", error);
      return ctx.internalServerError("Verification failed");
    }
  },


};