export default {
  routes: [
    {
      method: 'GET',
      path: '/gym-contract/:documentId',
      handler: 'gym-contract.getGymContract',
      config: {
        auth:{}
      },
    },
    {
      method: 'GET',
      path: '/gym-contracts/my-contract',
      handler: 'gym-contract.getMyContract',
      config: {
        auth:{}
      },
    },
  ],
};