export default {
  routes: [
    {
      method: "GET",
      path: "/gym-trials/client/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/client-trials/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: {},
      },
    },
    {
      method: "GET",
      path: "/trials/:id",
      handler: "gym-trial.adminClientTrials",
      config: {
        auth: {},
      },
    }
  ],
};
