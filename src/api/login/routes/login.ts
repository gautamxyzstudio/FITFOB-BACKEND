export default {
  routes: [
    {
      method: "POST",
      path: "/login",
      handler: "login.login",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/send-otp",
      handler: "login.sendOtp",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/verify-otp",
      handler: "login.verifyOtp",
      config: {
        auth: false,
      },
    },
  ],
};
