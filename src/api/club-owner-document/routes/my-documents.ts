export default {
  routes: [
    {
      method: "GET",
      path: "/my-documents",
      handler: "my-documents.myDocuments",
      config: {
        auth: {},
      },
    },
  ],
};