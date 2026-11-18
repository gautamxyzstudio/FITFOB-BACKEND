export default {
  routes: [
    // Client own trial history (via auth token)
    {
      method: "GET",
      path: "/client/my-trials",
      handler: "gym-trial.myTrialHistory",
      config: {
        auth: false,
      },
    },

    // Club owner trial client list
    {
      method: "GET",
      path: "/club-owner-trials/:ownerDocId",
      handler: "gym-trial.adminClubOwnerTrials",
      config: {
        auth: false,
      },
    },

    // Admin client trials
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
