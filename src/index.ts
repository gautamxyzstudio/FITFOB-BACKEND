// export default {
//   register() {},
//   bootstrap() {},
// };


import { runSubscriptionMaintenance } from "./cron/cron";

export default {
  register() {},

  bootstrap({ strapi }) {
    console.log("📅 Registering cron jobs...");

    strapi.cron.add({
      "56 10 * * *": async () => {
        await runSubscriptionMaintenance();
      },
    });
  },
};