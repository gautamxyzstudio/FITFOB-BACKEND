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
  ],
};
