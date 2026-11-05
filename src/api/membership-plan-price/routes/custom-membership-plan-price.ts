export default {
  routes: [
    {
      method: 'PUT',
      path: '/membership-plan-prices',
      handler: 'membership-plan-price.updatePricing',
      config: {
       auth:{}
      },
    },
  ],
};