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
    },
    {
      method: "GET",
      path: "/checkin/:id",
      handler: "client-checkin.adminClientCheckin",
      config: {
        auth: {}
      }
    },
    {
      method: "GET",
      path: "/club/checkins/:id",
      handler: "client-checkin.adminClubCheckins",
      config: {
        auth: {}
      }
    }
  ]
}