import type { Core } from '@strapi/strapi';

export default (plugin: any) => {
  // Disable sharp image processing (Windows EPERM fix)
  plugin.services['image-manipulation'] = {
    async generateThumbnail() {
      return null;
    },

    async optimize() {
      return null;
    },

    async generateResponsiveFormats() {
      return null;
    },
  };

  return plugin;
};
