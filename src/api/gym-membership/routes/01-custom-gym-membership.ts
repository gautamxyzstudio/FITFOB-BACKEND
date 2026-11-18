export default {
  routes: [
    {
      method: "GET",
      path: "/club-memberships/:id",
      handler: "gym-membership.clubMemberships",
      config: {
        auth: {},
      },
    },
  ],
};
