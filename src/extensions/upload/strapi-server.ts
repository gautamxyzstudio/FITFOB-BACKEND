export default (plugin: any) => {
  // Override image-manipulation service to disable thumbnail generation
  const originalService = plugin.services['image-manipulation'];

  if (typeof originalService === 'function') {
    plugin.services['image-manipulation'] = (args: any) => {
      const s = originalService(args);
      return {
        ...s,
        async generateThumbnail() {
          return null;
        },
      };
    };
  } else if (originalService) {
    plugin.services['image-manipulation'] = {
      ...originalService,
      async generateThumbnail() {
        return null;
      },
    };
  }

  return plugin;
};
