export default {
  routes: [
    {
      method: "POST",
      path: "/local-subscriptions/buy",
      handler: "local-subscription.buy",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/local-subscriptions/my-subscriptions",
      handler: "local-subscription.getMySubscriptions",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
