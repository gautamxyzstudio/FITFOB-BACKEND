export default {
  routes: [
    {
      method: "POST",
      path: "/client-checkins/scan",
      handler: "custom-client-checkin.scan",
      config: {
        auth: false,
      },
    },
  ],
};