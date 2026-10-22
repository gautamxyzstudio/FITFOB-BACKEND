

export default {
  routes: [
    {
      method: "POST",
      path: "/membership-payments/webhook",
      handler: "payment-webhook.webhook",
      config: {
        auth: false,
      },
    },
  ],
};

