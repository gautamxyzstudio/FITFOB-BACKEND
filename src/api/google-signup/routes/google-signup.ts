export default {
  routes: [
    {
      method: "POST",
      path: "/client/google",
      handler: "google-signup.clientGoogleSignup",
      config: {
        auth: false,
      },
    },
     {
      method: "POST",
      path: "/clubOwner/google",
      handler: "google-signup.clubOwnerGoogleSignup",
      config: {
        auth: false,
      },
    },
  ],
};
