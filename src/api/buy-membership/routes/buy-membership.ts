export default {
  routes: [
    {
      method: "POST",
      path: "/membership-checkout/buy",
      handler: "buy-membership.buy",
      config: {
        auth: {}
      },
    },
  ],
};