export default {
  routes: [
    {
      method: "POST",
      path: "/mfa/activate",
      handler: "mfa.activate",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/mfa/verify",
      handler: "mfa.verify",
      config: {
        auth: false,
      },
    },
  ],
};
