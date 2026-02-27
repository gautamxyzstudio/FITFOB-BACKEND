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
  ],
};