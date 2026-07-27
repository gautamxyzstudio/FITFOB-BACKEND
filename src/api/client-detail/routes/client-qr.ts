export default {
  routes: [
    {
      method: "GET",
      path: "/client/qr",
      handler: "client-qr.getQR",
      config: {
        auth: {},
      },
    },
  ],
};