export default {
  routes: [
    {
      method: "POST",
      path: "/verify-approval/verification-approved/:id",
      handler: "verify-approval.verificationApproved",
      config: {
        auth: {},
      },
    },

    {
      method: "POST",
      path: "/revoke-approval/verification-rejected/:id",
      handler: "verify-approval.verificationRejected",
      config: {
        auth: {},
      },
    },
  ],
};
