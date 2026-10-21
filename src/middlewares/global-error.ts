export default () => {
  return async (ctx: any, next: any) => {
    try {
      await next();
    } catch (err: any) {
      console.log(
        "⚠️ [global-error] Error caught on:",
        ctx.request.method,
        ctx.request.url,
      );

    //   console.error("Error name:", err.name);
    //   console.error("Error message:", err.message);
    //   console.error("Error status:", err.status || err.statusCode);
    //   console.error("Error stack:", err.stack);

      const status =
        err.status ||
        err.statusCode ||
        (err.name === "ForbiddenError"
          ? 403
          : err.name === "NotFoundError"
          ? 404
          : 500);

      if (status !== 404 && err.name !== "NotFoundError") {
        strapi.log.error("GLOBAL ERROR:", err);
      }

      ctx.status = status;

      ctx.body = {
        error: {
          status,
          name: err.name || "Error",
          message: err.message || "Internal Server Error",
          details: err.details || null,
        },
      };
    }
  };
};
