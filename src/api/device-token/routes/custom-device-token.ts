export default {
  routes: [
    {
      method: "POST",
      path: "/device-tokens/register",
      handler: "device-token.register",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/device-tokens/unregister",
      handler: "device-token.unregister",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/push-notifications/test",
      handler: "device-token.testPush",
      config: {
        auth: {},
      },
    },
  ],
};