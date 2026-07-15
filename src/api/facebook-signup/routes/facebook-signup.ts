module.exports = {
  routes: [
    {
      method: "POST",
      path: "/client/facebook",
      handler: "facebook-signup.clientFacebookSignup",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/clubOwner/facebook",
      handler: "facebook-signup.clubOwnerFacebookSignup",
      config: {
        auth: false,
      },
    },
  ],
};