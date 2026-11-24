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
      path: "/forgot-password",
      handler: "forgot-password.sendOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/forgot-password/send-otp",
      handler: "forgot-password.sendOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/auth/resend-reset-otp",
      handler: "forgot-password.resendOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/forgot-password/resend-otp",
      handler: "forgot-password.resendOtp",
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
      path: "/forgot-password/verify-otp",
      handler: "forgot-password.verifyOtp",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/auth/reset-password",
      handler: "forgot-password.resetPassword",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/forgot-password/reset-password",
      handler: "forgot-password.resetPassword",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/reset-password",
      handler: "forgot-password.resetPassword",
      config: { auth: false },
    },
  ],
};
