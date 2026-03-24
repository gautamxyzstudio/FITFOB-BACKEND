export default {
  routes: [
    {
      method: "GET",
      path: "/client-detail/me",
      handler: "custom-client-detail.getMyClientDetail",
      config: {
        auth: {}
      }
    },
    {
      method: "POST",
      path: "/client-details/:id/read",
      handler: "custom-client-detail.markClientRead",
       config: {
        auth: {}
      }
    },
    {
      method: "GET",
      path: "/client/pending-list",
      handler: "custom-client-detail.pendingClients",
        config: {
        auth: {}
      }
    },
    {
      method: "GET",
      path: "/client/approved-list",
      handler: "custom-client-detail.approvedClients",
        config: {
        auth: {}
      }
    },
      {
      method: "POST",
      path: "/verify-client/:clientId",
      handler: "custom-client-detail.verifyClientId",
      config: {
        auth: false,
      },
    },

  ]
};