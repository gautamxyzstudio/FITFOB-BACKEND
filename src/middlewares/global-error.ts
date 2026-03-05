export default () => {
    return async (ctx, next) => {
        try {
            await next();
        } catch (err: any) {
            strapi.log.error("GLOBAL ERROR:", err);

            const status =
                err.status ||
                err.statusCode ||
                (err.name === "ForbiddenError" ? 403 : 500);
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