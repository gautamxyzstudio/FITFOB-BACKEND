
export default {
  routes: [
    {
      method: "POST",
      path: "/membership-payments/verify",
      handler: "verify-payment.verifyPayment",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
