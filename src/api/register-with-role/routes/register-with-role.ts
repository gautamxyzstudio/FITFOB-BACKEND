export default {
  routes: [
    {
      method: "POST",
      path: "/register-with-role",
      handler: "register-with-role.register",
      config: {
        auth: false,
      },
    },
     {
      method: "POST",
      path: "/verify-register-otp",
      handler: "verify-register-otp.verify",
      config: { auth: false },
    }, 
    {
      method: "POST",
      path: "/resend-register-otp",
      handler: "resend-register-otp.resend",
      config: {
        auth: false,
      },
    },
    
  ],
};
