export default {
  routes: [
    {
      method: "GET",
      path: "/client-detail/me",
      handler: "custom-client-detail.getMyClientDetail",
      config: {
        auth: {}
      }
    }
  ]
};