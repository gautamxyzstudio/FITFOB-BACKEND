export default {
  routes: [
    {
      method: "GET",
      path: "/client-details/me/qr",
      handler: "client-qr.getQR",
      config: {
        auth: {},
      },
    },
  ],
};