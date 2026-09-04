export default () => ({
  /* ====================================== */
  /* COMMON HELPERS */
  /* ====================================== */

  async getClubOwner(userId: number) {
    const clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({ where: { user: userId } });

    if (!clubOwner) throw new Error("Gym not found");

    return clubOwner;
  },

  async getClient(clientId: string) {
    const client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({ where: { clientId } });

    if (!client) throw new Error("Client not found");

    return client;
  },

  getStartOfTodayUTC() {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);
    const startOfTodayIST = new Date(
      Date.UTC(
        nowIST.getUTCFullYear(),
        nowIST.getUTCMonth(),
        nowIST.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    return new Date(startOfTodayIST.getTime() - IST_OFFSET);
  },

  async checkRecentCheckin(clientId: number) {
    const now = new Date();
    const startOfTodayUTC = this.getStartOfTodayUTC();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    /*
     * Use whichever is later:
     *
     * 1. Start of today
     * 2. Four hours ago
     *
     * This ensures previous-day entries are NEVER checked.
     */
    const checkFrom =
      fourHoursAgo > startOfTodayUTC ? fourHoursAgo : startOfTodayUTC;

    /* ======================================================
       FIND RECENT CHECK-IN FROM TODAY ONLY
    ====================================================== */

    const recentCheckin = await strapi.db
      .query("api::client-checkin.client-checkin")
      .findOne({
        where: {
          client_detail: clientId,

          checkinTime: {
            $gte: checkFrom,
            $lte: now,
          },
        },

        orderBy: {
          checkinTime: "desc",
        },
      });

    /* ======================================================
       ALREADY CHECKED IN
    ====================================================== */

    if (recentCheckin) {
      const checkinTime = new Date(
        recentCheckin.checkinTime,
      ).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      throw new Error(
        `Client already checked in at ${checkinTime}. Try again after 4 hours`,
      );
    }

    return null;
  },

  /* ====================================== */
  /* SCAN QR */
  /* ====================================== */

  async scan(clientId: string, clubOwnerUserId: number) {
    const clubOwner = await this.getClubOwner(clubOwnerUserId);
    const client = await this.getClient(clientId);

    await this.checkRecentCheckin(client.id);

    /* ---------------- LOCAL SUBSCRIPTION ---------------- */

    let localSub = await strapi.db
      .query("api::local-subscription.local-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          subscriptionStatus: "active",
        },
        orderBy: { endDate: "desc" },
      });

    if (!localSub) {
      localSub = await strapi.db
        .query("api::local-subscription.local-subscription")
        .findOne({
          where: {
            client_detail: client.id,
            club_owner: clubOwner.id,
          },
          orderBy: { endDate: "desc" },
        });
    }

    if (localSub) {
      if (localSub.subscriptionStatus === "active") {
        await strapi.entityService.create(
          "api::client-checkin.client-checkin",
          {
            data: {
              client_detail: client.id,
              club_owner: clubOwner.id,
              subscriptionType: "local",
              checkinTime: new Date(),
              local_subscription: localSub.id,
            },
          },
        );

        return {
          status: "success",
          type: "local",
        };
      }
    }

    /* ---------------- OUTDOOR SUBSCRIPTION ---------------- */

    let outdoorSub = await strapi.db
      .query("api::outdoor-subscription.outdoor-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          subscriptionStatus: "active",
          remainingVisits: { $gt: 0 },
        },
        orderBy: { createdAt: "desc" },
      });

    if (!outdoorSub) {
      outdoorSub = await strapi.db
        .query("api::outdoor-subscription.outdoor-subscription")
        .findOne({
          where: {
            client_detail: client.id,
            subscriptionStatus: "active",
          },
          orderBy: { createdAt: "desc" },
        });
    }

    if (!outdoorSub) {
      if (localSub) {
        if (localSub.subscriptionStatus === "cancelled") {
          throw new Error("Local membership cancelled");
        }
        if (localSub.subscriptionStatus === "expired") {
          throw new Error("Local membership expired");
        }
      }

      throw new Error("No membership found");
    }

    if (
      outdoorSub.subscriptionStatus !== "active" ||
      !outdoorSub.remainingVisits ||
      outdoorSub.remainingVisits <= 0
    ) {
      if (localSub) {
        if (localSub.subscriptionStatus === "cancelled") {
          throw new Error("Local membership cancelled");
        }
        if (localSub.subscriptionStatus === "expired") {
          throw new Error("Local membership expired");
        }
      }

      throw new Error("Outdoor membership has no remaining visits");
    }

    if (localSub) {
      if (localSub.subscriptionStatus === "cancelled") {
        return {
          status: "choose",
          message: "Local membership cancelled. Use outdoor membership?",
          remainingVisits: outdoorSub.remainingVisits,
        };
      }

      if (localSub.subscriptionStatus === "expired") {
        return {
          status: "choose",
          message: "Local membership expired. Use outdoor membership?",
          remainingVisits: outdoorSub.remainingVisits,
        };
      }
    }

    return await this.createOutdoorCheckin(client, clubOwner.id, outdoorSub);
  },

  /* ====================================== */
  /* CONFIRM OUTDOOR */
  /* ====================================== */

  async confirmOutdoor(clientId: string, clubOwnerUserId: number) {
    const clubOwner = await this.getClubOwner(clubOwnerUserId);
    const client = await this.getClient(clientId);

    await this.checkRecentCheckin(client.id);

    let outdoorSub = await strapi.db
      .query("api::outdoor-subscription.outdoor-subscription")
      .findOne({
        where: {
          client_detail: client.id,
          subscriptionStatus: "active",
          remainingVisits: { $gt: 0 },
        },
        orderBy: { createdAt: "desc" },
      });

    if (!outdoorSub) {
      outdoorSub = await strapi.db
        .query("api::outdoor-subscription.outdoor-subscription")
        .findOne({
          where: {
            client_detail: client.id,
            subscriptionStatus: "active",
          },
          orderBy: { createdAt: "desc" },
        });
    }

    if (!outdoorSub) throw new Error("Outdoor membership not found");

    if (
      outdoorSub.subscriptionStatus !== "active" ||
      !outdoorSub.remainingVisits ||
      outdoorSub.remainingVisits <= 0
    ) {
      throw new Error("Outdoor membership has no remaining visits");
    }

    return await this.createOutdoorCheckin(client, clubOwner.id, outdoorSub);
  },

  /* ====================================== */
  /* CREATE OUTDOOR CHECKIN */
  /* ====================================== */

  async createOutdoorCheckin(
    client: any,
    clubOwnerId: number,
    outdoorSub: any,
  ) {
    return await strapi.db.connection.transaction(async () => {
      const newUsedVisits = outdoorSub.usedVisits + 1;
      const newRemainingVisits = outdoorSub.remainingVisits - 1;

      if (newRemainingVisits < 0) {
        throw new Error("No visits remaining");
      }

      const updateData: any = {
        usedVisits: newUsedVisits,
        remainingVisits: newRemainingVisits,
      };

      if (newRemainingVisits === 0) {
        updateData.subscriptionStatus = "expired";
      }

      await strapi.entityService.update(
        "api::outdoor-subscription.outdoor-subscription",
        outdoorSub.id,
        {
          data: updateData,
        },
      );

      await strapi.entityService.create("api::client-checkin.client-checkin", {
        data: {
          client_detail: client.id,
          club_owner: clubOwnerId,
          subscriptionType: "outdoor",
          checkinTime: new Date(),
          outdoor_subscription: outdoorSub.id,
        },
      });

      return {
        status: "success",
        type: "outdoor",
        remainingVisits: newRemainingVisits,
      };
    });
  },

  /* ====================================== */
  /* CHECKOUT */
  /* ====================================== */

  async checkout(clientId: string, clubOwnerUserId: number) {
    const clubOwner = await this.getClubOwner(clubOwnerUserId);
    const client = await this.getClient(clientId);

    const startOfTodayUTC = this.getStartOfTodayUTC();

    /* Find all check-ins of this client at this gym from today */
    const todayCheckins = await strapi.db
      .query("api::client-checkin.client-checkin")
      .findMany({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          checkinTime: {
            $gte: startOfTodayUTC,
          },
        },
        orderBy: {
          checkinTime: "desc",
        },
      });

    if (!todayCheckins || todayCheckins.length === 0) {
      throw new Error("No check-in found for this client today");
    }

    /* Find the active check-in with empty checkout time */
    const activeCheckin = todayCheckins.find(
      (c: any) => c.checkoutTime === null || c.checkoutTime === undefined,
    );

    if (!activeCheckin) {
      throw new Error("Client has already checked out for today");
    }

    const now = new Date();

    await strapi.entityService.update(
      "api::client-checkin.client-checkin",
      activeCheckin.id,
      {
        data: {
          checkoutTime: now,
        },
      },
    );

    const checkinTime = new Date(activeCheckin.checkinTime);
    const durationMinutes = Math.max(
      0,
      Math.round((now.getTime() - checkinTime.getTime()) / (1000 * 60)),
    );

    return {
      status: "success",
      message: "Checked out successfully",
      clientId: client.clientId,
      clientName: client.name,
      checkinTime: activeCheckin.checkinTime,
      checkoutTime: now,
      durationMinutes,
      subscriptionType: activeCheckin.subscriptionType,
    };
  },

  /* ====================================== */
  /* MANUAL CHECK-IN */
  /* ====================================== */

  async manualCheckin(clientId: string, clubOwnerUserId: number) {
    return await this.scan(clientId, clubOwnerUserId);
  },
});
