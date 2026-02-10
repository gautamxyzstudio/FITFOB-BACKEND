import path from "path";

export default {
  host: "0.0.0.0",
  port: 1337,

  app: {
    keys: ["fitfobKey1", "fitfobKey2", "fitfobKey3", "fitfobKey4"],
  },

  dirs: {
    public: path.resolve(__dirname, "../../public"),
    static: path.resolve(__dirname, "../../public"),
    tmp: path.resolve(__dirname, "../../.tmp"),
  },
};
