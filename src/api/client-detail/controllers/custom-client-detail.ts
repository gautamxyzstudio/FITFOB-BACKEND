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

  }

};