export default {
  routes: [
    {
      method: "GET",
      path: "/club-owners/unverified",
      handler: "club-owner.unverified",
      config: {
        auth: {},
      },
    },
    {
      method: "DELETE",
      path: "/club-owners/:id",
      handler: "club-owner.delete",
      config: {
        auth: {},
      },
    },
    {
      method: "PUT",
      path: "/club-owners/:id",
      handler: "club-owner.update",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/club-owner/me",
      handler: "club-owner.getMyClubOwner",
      config: {
        auth: {}
      }
    }
  ],
};