export default () => {
    return async (ctx: any, next: any) => {
        try {
            await next();
        } catch (err: any) {
            console.log("⚠️ [global-error] Error caught on:", ctx.request.method, ctx.request.url);
            console.log("⚠️ [global-error] Auth Header:", ctx.request.headers.authorization ? "Present" : "None");
            console.log("⚠️ [global-error] ctx.state.user:", ctx.state.user ? { id: ctx.state.user.id, email: ctx.state.user.email, role: ctx.state.user.role } : "None");
            console.log("⚠️ [global-error] Ability rules for this role:", ctx.state.auth?.ability?.rules?.map((r: any) => ({ action: r.action, subject: r.subject })));
            console.log("⚠️ [global-error] Error details:", {
                name: err.name,
                message: err.message,
                status: err.status,
                details: err.details,
            });

            const status =
                err.status ||
                err.statusCode ||
                (err.name === "ForbiddenError" ? 403 : err.name === "NotFoundError" ? 404 : 500);

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