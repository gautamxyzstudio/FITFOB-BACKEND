export default {
  routes: [
    {
      method: "GET",
      path: "/activity-logs/club-owner/:documentId",
      handler: "activity-log.getClubOwnerLogs",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/activity-logs/client/:documentId",
      handler: "activity-log.getClientLogs",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/activity-logs/admin",
      handler: "activity-log.getAdminLogs",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/activity-logs/entity/:entityName/:entityId",
      handler: "activity-log.getEntityLogs",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/activity-logs/me",
      handler: "activity-log.getMyLogs",
      config: {
        auth: {},
      },
    },
  ],
};
