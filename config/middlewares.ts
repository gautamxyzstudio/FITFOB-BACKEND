export default [
  "strapi::errors",
  "global::global-error", // ⭐ Custom global error handler

  {
    name: "strapi::security",
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "img-src": [
            "'self'",
            "data:",
            "blob:",
            "https://storage.googleapis.com",
            "https://fitfobs3.s3.ap-south-1.amazonaws.com",
          ],
          "media-src": [
            "'self'",
            "data:",
            "blob:",
            "https://storage.googleapis.com",
            "https://fitfobs3.s3.ap-south-1.amazonaws.com",
          ],
        },
      },
    },
  },
  {
    name: "strapi::cors",
    config: {
      origin: ["http://localhost:1337", "http://localhost:5173","https://admin.fitfob.com"],
      credentials: true,
    },
  },
  "strapi::poweredBy",
  "strapi::logger",
  "strapi::query",
  {
  name: "strapi::body",
  config: {
    formLimit: "256mb",
    jsonLimit: "256mb",
    textLimit: "256mb",
    formidable: {
      maxFileSize: 250 * 1024 * 1024, // 250MB
      multiples: true,                 // ⭐ THIS is the real fix
      keepExtensions: true,
    },
  },
},
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];
