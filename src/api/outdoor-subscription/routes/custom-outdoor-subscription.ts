export default {
  routes: [
    {
      method: "GET",
      path: "/outdoor-subscriptions/my-subscriptions",
      handler: "outdoor-subscription.getMySubscriptions",
      config: {
        auth:{}
      },
    },
  ],
};
