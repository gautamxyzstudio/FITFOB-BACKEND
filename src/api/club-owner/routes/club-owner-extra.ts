export default {
  routes: [
    {
      method: "GET",
      path: "/club-owners/search",
      handler: "club-owner.searchNearbyOrCity",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/club-owners/client/:documentId",
      handler: "club-owner.clientDetail",
      config: {
        auth: {},
      },
    },
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
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/club-owners/:id/read",
      handler: "club-owner.markClubRead",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/club-owners/today-checkins",
      handler: "club-owner.todayCheckins",
      config: {
        auth: {},
      },
    },
  ],
};
