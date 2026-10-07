export default {
  routes: [
    /* START / RESUME ONBOARDING */
    {
      method: "GET",
      path: "/pending-club-owner/me",
      handler: "pending-club-owner.me",
      config: { auth: {} },
    },
    /* UNVERIFIED CLUB OWNERS */
    {
      method: "GET",
      path: "/pending-club-owner/unverified",
      handler: "pending-club-owner.unverified",
      config: { auth: {} },
    },
    /* GET MY DOCUMENTS */
    {
      method: "GET",
      path: "/pending-club-owner/documents",
      handler: "pending-club-owner.getMyDocuments",
      config: { auth: {} },
    },
    /* STEP 1 — CLUB + OWNER + LOGO */
    {
      method: "POST",
      path: "/pending-club-owner/club-owner-details",
      handler: "pending-club-owner.clubOwnerDetails",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/send-otp",
      handler: "pending-club-owner.sendDetailsOtp",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/verify-otp",
      handler: "pending-club-owner.verifyDetailsOtp",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/resend-otp",
      handler: "pending-club-owner.resendDetailsOtp",
      config: { auth: {} },
    },
    /* STEP 2 — MAP LOCATION (LATITUDE / LONGITUDE) */
    {
      method: "POST",
      path: "/pending-club-owner/map-location",
      handler: "pending-club-owner.mapLocation",
      config: { auth: {} },
    },

    /* STEP 3 — ADDRESS DETAILS */
    {
      method: "POST",
      path: "/pending-club-owner/address-details",
      handler: "pending-club-owner.addressDetails",
      config: { auth: {} },
    },

    /* STEP 4 — CONFIGURE CLUB */
    {
      method: "POST",
      path: "/pending-club-owner/configure-club",
      handler: "pending-club-owner.configureClub",
      config: { auth: {} },
    },

    /* STEP 5 — CLUB OWNER GOVERNMENT ID'S */
    {
      method: "POST",
      path: "/pending-club-owner/verify-government-doc",
      handler: "pending-club-owner.verifyGovernmentDoc",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/upload-government-doc",
      handler: "pending-club-owner.uploadGovernmentDoc",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/confirm-government-docs",
      handler: "pending-club-owner.confirmGovernmentDocs",
      config: { auth: {} },
    },

    /* STEP 6 — CLUB PHOTOS & SUBMIT ONBOARDING */
    {
      method: "GET",
      path: "/pending-club-owner/club-photos",
      handler: "pending-club-owner.getMyClubPhotos",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/upload-club-photo",
      handler: "pending-club-owner.uploadClubPhoto",
      config: {
        auth: {},
        body: {
          multipart: true,
        },
      },
    },
    {
      method: "DELETE",
      path: "/pending-club-owner/club-photos/:id",
      handler: "pending-club-owner.deleteClubPhoto",
      config: { auth: {} },
    },
    {
      method: "POST",
      path: "/pending-club-owner/confirm",
      handler: "pending-club-owner.uploadClubPhotos",
      config: {
        auth: {},
        body: {
          multipart: true,
        },
      },
    },

    /* GET SINGLE PENDING CLUB OWNER BY ID (MUST BE AFTER SPECIFIC PATHS LIKE /me) */
    {
      method: "GET",
      path: "/pending-club-owner/:id",
      handler: "pending-club-owner.findOne",
      config: { auth: {} },
    },

    /* UPDATE PENDING CLUB OWNER BY ID */
    {
      method: "PUT",
      path: "/pending-club-owner/:id",
      handler: "pending-club-owner.update",
      config: { auth: {} },
    },
  ],
};
