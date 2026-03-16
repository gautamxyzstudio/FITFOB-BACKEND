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

    ctx.body = {
      success: true,
      total: finalData.length,
      data: finalData,
    };

  } catch (err) {
    console.error(err);
    ctx.throw(500, "Failed to fetch pending clients");
  }
}

};