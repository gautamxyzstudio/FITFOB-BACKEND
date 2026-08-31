export default {
  routes: [
    {
      method: "GET",
      path: "/local-membership-plans/my-plan",
      handler: "local-membership-plan.getMyPlans",
      config: {
        auth: {},
      },
    },
    {
      method: "PUT",
      path: "/local-membership-plans/:id/toggle-status",
      handler: "local-membership-plan.toggleStatus",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/local-membership-plans/admin-create",
      handler: "local-membership-plan.adminCreate",
      config: {
        auth: {},
      },
    },
  ],
};
