export default {
  routes: [
    {
      method: "POST",
      path: "/auth/forgot-password",
      handler: "forgot-password.sendOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/auth/verify-otp",
      handler: "forgot-password.verifyOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/auth/reset-password",
      handler: "forgot-password.resetPassword",
      config: { auth: false },
    },
  ],
};
