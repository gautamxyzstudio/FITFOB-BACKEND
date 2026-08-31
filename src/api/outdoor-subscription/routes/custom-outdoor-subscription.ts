export default {
  routes: [
    {
      method: "POST",
      path: "/outdoor-subscriptions/buy",
      handler: "outdoor-subscription.buy",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/outdoor-subscriptions/my-subscriptions",
      handler: "outdoor-subscription.getMySubscriptions",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
