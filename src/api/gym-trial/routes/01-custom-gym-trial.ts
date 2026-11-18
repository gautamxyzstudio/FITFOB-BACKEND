export default {
  routes: [
    {
      method: "GET",
      path: "/club-owner-trials/:ownerDocId",
      handler: "gym-trial.adminClubOwnerTrials",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/gym-trials/client/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/client-trials/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/trials/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: false,
      },
    },
  ],
};
