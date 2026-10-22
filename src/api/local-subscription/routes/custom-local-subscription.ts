export default {
  routes: [
    {
      method: "GET",
      path: "/local-subscriptions/my-subscriptions",
      handler: "local-subscription.getMySubscriptions",
      config: {
        auth:{}
      },
    },
  ],
};
