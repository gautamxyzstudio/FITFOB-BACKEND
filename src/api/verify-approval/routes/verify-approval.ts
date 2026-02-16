export default {
  routes: [
    {
      method: "POST",
      path: "/verify-approval/:id",
      handler: "verify-approval.verifyApproval",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/revoke-approval/:id",
      handler: "verify-approval.revokeApproval",
      config: {
        auth: {},
      },
    },
  ],
};
