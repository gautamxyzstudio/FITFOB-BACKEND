const sharp = require('sharp');
sharp.cache(false); 

export default ({ env }) => ({
  upload: {
    config: {
      provider: "aws-s3",

      providerOptions: {
        s3Options: {
          credentials: {
            accessKeyId: env("AWS_ACCESS_KEY_ID"),
            secretAccessKey: env("AWS_ACCESS_SECRET"),
          },
          region: env("AWS_REGION"),
        },

        // ⭐ DO NOT SEND ACL TO S3
        params: {
          Bucket: env("AWS_BUCKET"),
        },
      },

      // ⭐ VERY IMPORTANT — overrides Strapi default ACL behaviour
      actionOptions: {
        upload: {
          ACL: undefined,
        },
        uploadStream: {
          ACL: undefined,
        },
        delete: {},
      },

      // prevent Windows sharp crash
      responsiveDimensions: false,
      breakpoints: {},
    },
  },
});
