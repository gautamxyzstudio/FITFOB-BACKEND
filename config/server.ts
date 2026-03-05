import path from "path";

export default ({ env }) => ({
  app: {
    keys: env.array("APP_KEYS", [
      "fitfobKey1",
      "fitfobKey2",
      "fitfobKey3",
      "fitfobKey4",
    ]),
  },

  dirs: {
    public: path.resolve(__dirname, "../../public"),
    static: path.resolve(__dirname, "../../public"),
    tmp: path.resolve(__dirname, "../../.tmp"),
  },

  cron: {
    enabled: true,
  },
});