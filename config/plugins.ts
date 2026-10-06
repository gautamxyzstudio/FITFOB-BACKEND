import path from "path";

const sharp = require('sharp');
sharp.cache(false); 

export default ({ env }) => ({
  upload: {
    config: {
      provider: path.resolve(__dirname, "../src/providers/strapi-provider-upload-aws-s3-compressed"),

      providerOptions: {
        s3Options: {
          credentials: {
            accessKeyId: env("AWS_ACCESS_KEY_ID"),
            secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
          },
          region: env("AWS_REGION"),
          // ⭐ DO NOT SEND ACL TO S3
          params: {
            Bucket: env("AWS_BUCKET"),
          },
        },
        // Auto-compress images before storing in AWS S3
        compression: {
          maxWidth: 2048,
          maxHeight: 2048,
          jpegQuality: 80,
          pngQuality: 80,
          webpQuality: 80,
          avifQuality: 75,
          tiffQuality: 80,
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
