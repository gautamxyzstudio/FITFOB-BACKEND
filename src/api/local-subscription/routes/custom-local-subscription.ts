export default {
  routes: [
    // 1. Existing endpoint: My subscriptions
    {
      method: "GET",
      path: "/local-subscriptions/my-subscriptions",
      handler: "local-subscription.getMySubscriptions",
      config: {
        auth: false,
      },
    },

    // 2. Club Owner - Offline Members (Part 1 & Flowchart 1)
    {
      method: "POST",
      path: "/club-owner/offline-members",
      handler: "local-subscription.addOfflineMember",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/club-owner/offline-members",
      handler: "local-subscription.listOfflineMembers",
      config: {
        auth: false,
      },
    },
    {
      method: "PUT",
      path: "/club-owner/offline-members/:id",
      handler: "local-subscription.updateOfflineMember",
      config: {
        auth: false,
      },
    },
    {
      method: "DELETE",
      path: "/club-owner/offline-members/:id",
      handler: "local-subscription.cancelOfflineInvite",
      config: {
        auth: false,
      },
    },

    // 3. Client - Claiming Existing Membership (Part 2)
    {
      method: "GET",
      path: "/client/pending-claim",
      handler: "local-subscription.getPendingClaim",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/client/claim-membership/:id",
      handler: "local-subscription.claimMembership",
      config: {
        auth: false,
      },
    },

    // 4. Client - Buying New Membership (Pay at Gym - Part 3 & Flowchart 2)
    {
      method: "POST",
      path: "/client/pay-at-gym",
      handler: "local-subscription.requestPayAtGym",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/client/pay-at-gym/:id/cancel",
      handler: "local-subscription.cancelPayAtGymRequest",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/client/pending-approvals",
      handler: "local-subscription.getClientPendingApprovals",
      config: {
        auth: false,
      },
    },

    // 5. Club Owner - Approving "Pay at Gym" Requests (Part 4 & Flowchart 3)
    {
      method: "GET",
      path: "/club-owner/pending-approvals",
      handler: "local-subscription.getPendingApprovals",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/club-owner/pending-approvals/:id/approve",
      handler: "local-subscription.approvePayAtGym",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/club-owner/pending-approvals/:id/reject",
      handler: "local-subscription.rejectPayAtGym",
      config: {
        auth: false,
      },
    },

    // Aliases under /local-subscriptions/* for route flexibility
    {
      method: "POST",
      path: "/local-subscriptions/offline-members",
      handler: "local-subscription.addOfflineMember",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/local-subscriptions/offline-members",
      handler: "local-subscription.listOfflineMembers",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/local-subscriptions/pending-approvals",
      handler: "local-subscription.getPendingApprovals",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/local-subscriptions/pending-approvals/:id/approve",
      handler: "local-subscription.approvePayAtGym",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/local-subscriptions/pending-approvals/:id/reject",
      handler: "local-subscription.rejectPayAtGym",
      config: {
        auth: false,
      },
    },
  ],
};
