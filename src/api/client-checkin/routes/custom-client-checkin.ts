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
    }
  ]
};