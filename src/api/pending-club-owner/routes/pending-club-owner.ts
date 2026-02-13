export default {
  routes: [

    /* START / RESUME ONBOARDING */
    {
      method: "GET",
      path: "/pending-club-owner/me",
      handler: "pending-club-owner.me",
      config: { auth: {} },
    },

    /* STEP 1 — CLUB + OWNER + LOGO */
    {
      method: "POST",
      path: "/pending-club-owner/club-owner-details",
      handler: "pending-club-owner.clubOwnerDetails",
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

    /* STEP 5 — UPLOAD PHOTOS & CREATE CLUB */
    {
      method: "POST",
      path: "/pending-club-owner/upload-club-photos",
      handler: "pending-club-owner.uploadClubPhotos",
      config: { auth: {} },
    },

  ],
};
