export default {
  routes: [
    // Client cancel gym trial
    {
      method: "POST",
      path: "/client/my-trials/:id/cancel",
      handler: "gym-trial.cancelTrial",
      config: {
        auth: false,
      },
    },

    // Client reschedule gym trial (today to tomorrow)
    {
      method: "POST",
      path: "/client/my-trials/:id/reschedule",
      handler: "gym-trial.rescheduleTrial",
      config: {
        auth: false,
      },
    },

    // Gym Owner own trial history / guest list (via auth token)
    {
      method: "GET",
      path: "/club-owner/trial-guests",
      handler: "gym-trial.ownerTrialHistory",
      config: {
        auth: false,
      },
    },

    // Client own trial history (via auth token)
    {
      method: "GET",
      path: "/client/my-trials",
      handler: "gym-trial.myTrialHistory",
      config: {
        auth: false,
      },
    },

    // Club owner trial client list (Admin or by docId)
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
