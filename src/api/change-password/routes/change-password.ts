export default {
  routes: [
    {
      method: "POST",
      path: "/change-password",
      handler: "change-password.changePassword",
      config: {
        auth: {},
      },
    },
  ],
};