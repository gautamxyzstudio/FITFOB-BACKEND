export default () => ({

  /* ====================================== */
  /* SCAN QR */
  /* ====================================== */

  async scan(clientId: string, clubOwnerUserId: number) {

    /* FIND CLUB OWNER FROM TOKEN */

    const clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({
        where: { user: clubOwnerUserId }
      });

    if (!clubOwner) {
      throw new Error("Gym not found");
    }

    /* FIND CLIENT */

    const client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { clientId }
      });

    if (!client) {
      throw new Error("Client not found");
    }

    /* 4 HOUR RULE */

    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const recentCheckin = await strapi.db
      .query("api::client-checkin.client-checkin")
      .findOne({
        where: {
          client_detail: client.id,
          checkinTime: { $gt: fourHoursAgo }
        }
      });

    if (recentCheckin) {
      throw new Error("Client already checked in try again after 4 hours");
    }

    /* LOCAL SUBSCRIPTION */

    const localSub = await strapi.db
      .query("api::local-subscription.local-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id
        }
      });

    const today = new Date();

    if (localSub) {

      if (localSub.subscriptionStatus === "cancelled") {
        throw new Error("Local membership cancelled");
      }

      if (
        localSub.subscriptionStatus === "active" &&
        new Date(localSub.endDate) >= today
      ) {

        await strapi.entityService.create(
          "api::client-checkin.client-checkin",
          {
            data: {
              client_detail: client.id,
              club_owner: clubOwner.id,
              subscriptionType: "local",
              checkinTime: new Date(),
              local_subscription: localSub.id
            }
          }
        );

        return {
          status: "success",
          type: "local"
        };
      }
    }

    /* OUTDOOR SUBSCRIPTION */

    const outdoorSub = await strapi.db
      .query("api::outdoor-subscription.outdoor-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          subscriptionStatus: "active"
        }
      });

    if (!outdoorSub) {
      throw new Error("No valid membership found");
    }

    if (outdoorSub.remainingVisits <= 0) {
      throw new Error("Outdoor membership has no remaining visits");
    }

    /* IF LOCAL EXISTS BUT EXPIRED */

    if (localSub) {
      return {
        status: "choose",
        message: "Local membership expired. Use outdoor membership?",
        remainingVisits: outdoorSub.remainingVisits
      };
    }

    /* IF NO LOCAL → DIRECT OUTDOOR */

    return await this.createOutdoorCheckin(client, clubOwner.id, outdoorSub);

  },

  /* ====================================== */
  /* CONFIRM OUTDOOR */
  /* ====================================== */

  async confirmOutdoor(clientId: string, clubOwnerUserId: number) {

    const clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({
        where: { user: clubOwnerUserId }
      });

    if (!clubOwner) {
      throw new Error("Gym not found");
    }

    const client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { clientId }
      });

    if (!client) {
      throw new Error("Client not found");
    }

    const outdoorSub = await strapi.db
      .query("api::outdoor-subscription.outdoor-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          subscriptionStatus: "active"
        }
      });

    if (!outdoorSub) {
      throw new Error("Outdoor membership not found");
    }

    if (outdoorSub.remainingVisits <= 0) {
      throw new Error("Outdoor membership has no remaining visits");
    }

    return await this.createOutdoorCheckin(client, clubOwner.id, outdoorSub);

  },

  /* ====================================== */
  /* CREATE OUTDOOR CHECKIN */
  /* ====================================== */

  async createOutdoorCheckin(client: any, clubOwnerId: number, outdoorSub: any) {

    return await strapi.db.connection.transaction(async () => {

      const newUsedVisits = outdoorSub.usedVisits + 1;
      const newRemainingVisits = outdoorSub.remainingVisits - 1;

      if (newRemainingVisits < 0) {
        throw new Error("No visits remaining");
      }

      /* UPDATE VISITS */

      await strapi.entityService.update(
        "api::outdoor-subscription.outdoor-subscription",
        outdoorSub.id,
        {
          data: {
            usedVisits: newUsedVisits,
            remainingVisits: newRemainingVisits
          }
        }
      );

      /* CREATE CHECKIN */

      await strapi.entityService.create(
        "api::client-checkin.client-checkin",
        {
          data: {
            client_detail: client.id,
            club_owner: clubOwnerId,
            subscriptionType: "outdoor",
            checkinTime: new Date(),
            outdoor_subscription: outdoorSub.id
          }
        }
      );

      return {
        status: "success",
        type: "outdoor",
        remainingVisits: newRemainingVisits
      };

    });

  }

});