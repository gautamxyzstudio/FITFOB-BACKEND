import path from "path";
import cronTasks from "../src/cron/cron";

export default {
  app: {
    keys: ["fitfobKey1", "fitfobKey2", "fitfobKey3", "fitfobKey4"],
  },

  cron: {
    enabled: true,
    tasks: cronTasks,
  },

  dirs: {
    public: path.resolve(__dirname, "../../public"),
    static: path.resolve(__dirname, "../../public"),
    tmp: path.resolve(__dirname, "../../.tmp"),
  },
};
