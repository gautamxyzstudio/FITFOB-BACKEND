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
      method: "GET",
      path: "/client/my-checkins",
      handler: "client-checkin.myCheckins",
      config: {
        auth: {}
      }
    }
  ]
}