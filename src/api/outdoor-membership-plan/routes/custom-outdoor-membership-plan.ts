export default {
  routes: [
    {
      method: "PUT",
      path: "/outdoor-membership-plans/:id/toggle-status",
      handler: "outdoor-membership-plan.toggleStatus",
      config: {
        auth: {},
      },
    },
  ],
};
