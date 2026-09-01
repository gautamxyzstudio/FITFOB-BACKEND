export default {
  routes: [
    // Unverified Club Owners (Must be before :id route)
    {
      method: "GET",
      path: "/pending-club-owner/unverified",
      handler: "pending-club-owner.unverified",
      config: { auth: {} },
    },
    // Get Single Club Owner
    {
      method: "GET",
      path: "/pending-club-owner/:id",
      handler: "pending-club-owner.findOne",
      config: { auth: {} },
    },
  ],
};
