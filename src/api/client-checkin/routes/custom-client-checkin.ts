export default {
  routes: [
    {
      method: "POST",
      path: "/client-checkin/scan",
      handler: "custom-client-checkin.scan",
      config: {
        auth: {}
      }
    },
    {
      method: "POST",
      path: "/client-checkin/confirm-outdoor",
      handler: "custom-client-checkin.confirmOutdoor",
      config: {
        auth: {}
      }
    },
    {
      method: "POST",
      path: "/client/checkout",
      handler: "custom-client-checkin.checkout",
      config: {
        auth: {}
      }
    },
    {
      method: "POST",
      path: "/client-checkin/manual-checkin",
      handler: "custom-client-checkin.manualCheckin",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ]
};