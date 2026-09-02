export default {
  routes: [
    {
      method: "GET",
      path: "/verify-approval/verification-status",
      handler: "verify-approval.getVerificationStatus",
      config: {
        auth: {},
      },
    },
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
