export default {
  routes: [
    {
      method: "GET",
      path: "/client-details/me/qr",
      handler: "custom-client-detail.getMyQR",
      config: {
        auth: {}
      },
    },
  ],
};