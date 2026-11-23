export default () => ({
  /* ====================================== */
  /* COMMON HELPERS */
  /* ====================================== */

  async getClubOwner(userId: number) {
    let clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({ where: { user: userId } });

    if (!clubOwner) {
      const userWithDetail: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: userId },
          populate: {
            club_owner: true,
          },
        });
      clubOwner = userWithDetail?.club_owner || null;
    }

    if (!clubOwner) {
      // Check if userId was directly the clubOwner record ID
      clubOwner = await strapi.db
        .query("api::club-owner.club-owner")
        .findOne({ where: { id: userId } });
    }

    if (!clubOwner) throw new Error("Gym not found");

    return clubOwner;
  },

  async getClient(clientId: string | number) {
    if (!clientId) throw new Error("Client identifier is required");
    const raw = String(clientId).trim();
    const isNum = !isNaN(Number(raw)) && /^\d+$/.test(raw);

    // 1. Try finding by custom clientId (e.g. CL-101)
    let client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { clientId: raw },
        populate: {
          selfieUpload: true,
          user: {
            select: ["id", "username", "email", "phoneNumber"],
          },
        },
      });

    // 2. Try by documentId or numeric id
    if (!client) {
      client = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: isNum ? { id: Number(raw) } : { documentId: raw },
          populate: {
            selfieUpload: true,
            user: {
              select: ["id", "username", "email", "phoneNumber"],
            },
          },
        });
    }

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

  getTodayDateString(): string {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);
    const year = nowIST.getUTCFullYear();
    const month = String(nowIST.getUTCMonth() + 1).padStart(2, "0");
    const day = String(nowIST.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },

  async checkRecentCheckin(clientId: number) {
    const now = new Date();
    const startOfTodayUTC = this.getStartOfTodayUTC();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    /*
     * Use whichever is later:
     * 1. Start of today
     * 2. Four hours ago
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
  /* SCAN QR / CHECK-IN */
  /* ====================================== */

  async scan(clientId: string | number, clubOwnerUserId: number) {
    const clubOwner = await this.getClubOwner(clubOwnerUserId);
    const client = await this.getClient(clientId);

    await this.checkRecentCheckin(client.id);

    const clientName = client.name || client.user?.username || null;
    const selfieUrl =
      client.selfieUpload?.formats?.small?.url ||
      client.selfieUpload?.formats?.thumbnail?.url ||
      client.selfieUpload?.url ||
      null;
    const gymName = clubOwner.clubName || clubOwner.club_name || "gym";
    const todayDateStr = this.getTodayDateString();

    /* ========================================================
       STEP 1: CHECK ACTIVE GYM MEMBERSHIP FOR THIS GYM
    ======================================================== */

    // Fetch all gym contracts under this club owner
    const contracts = await strapi.db
      .query("api::gym-contract.gym-contract")
      .findMany({
        where: {
          $or: [
            { club_owner: clubOwner.id },
            ...(clubOwner.documentId
              ? [{ club_owner: { documentId: clubOwner.documentId } }]
              : []),
          ],
        },
        select: ["id", "documentId", "contractId"],
      });

    const contractIds = contracts.map((c: any) => c.id);

    let existingMemberships: any[] = [];
    if (contractIds.length > 0) {
      existingMemberships = await strapi.db
        .query("api::gym-membership.gym-membership")
        .findMany({
          where: {
            client_detail: client.id,
            gym_contract: { id: { $in: contractIds } },
          },
          populate: {
            gym_contract: {
              select: ["id", "contractId"],
            },
            membership_plan_price: true,
          },
          orderBy: { id: "desc" },
        });
    }

    let activeMembership: any = null;
    for (const m of existingMemberships) {
      if (m.membershipStatus === "active") {
        if (m.paymentStatus === "failed") continue;
        if (m.endDate && m.endDate < todayDateStr) continue;
        if (m.startDate && m.startDate > todayDateStr) continue;

        activeMembership = m;
        break;
      }
    }

    // Check active local subscription if no contract membership found
    if (!activeMembership) {
      try {
        const activeLocalSubs = await strapi.db
          .query("api::local-subscription.local-subscription")
          .findMany({
            where: {
              client_detail: client.id,
              club_owner: clubOwner.id,
              subscriptionStatus: "active",
              claimStatus: { $ne: "unclaimed" },
            },
            populate: { local_membership_plan: true },
            orderBy: { id: "desc" },
          });

        for (const sub of activeLocalSubs) {
          const startStr = sub.startDate ? String(sub.startDate).split("T")[0] : null;
          if (sub.endDate && sub.endDate < todayDateStr) continue;
          if (startStr && startStr > todayDateStr) continue;

          activeMembership = {
            id: sub.id,
            membershipId: sub.documentId || String(sub.id),
            membershipStatus: sub.subscriptionStatus,
            duration: sub.local_membership_plan?.planName || "Local Plan",
            endDate: sub.endDate,
            isLocalSub: true,
          };
          break;
        }
      } catch (_) {}
    }

    // Found active membership -> proceed with membership checkin
    if (activeMembership) {
      const checkinPayload: any = {
        client_detail: client.id,
        club_owner: clubOwner.id,
        checkinType: "membership",
        checkinTime: new Date(),
      };
      if (!activeMembership.isLocalSub) {
        checkinPayload.gym_membership = activeMembership.id;
      }

      const checkin = await strapi.entityService.create(
        "api::client-checkin.client-checkin",
        {
          data: checkinPayload,
        },
      );

      try {
        await strapi
          .service("api::activity-log.activity-log")
          .createActivityLog({
            actorType: "client",
            actorId: client.documentId || client.id,
            actionType: "checkin",
            entityName: "client-checkin",
            entityId: checkin?.documentId || checkin?.id,
            description: `Checked in to ${gymName} (Membership)`,
          });
      } catch (actErr) {
        strapi.log.warn("[Checkin] Activity logging failed:", actErr);
      }

      return {
        checkinType: "membership",
        clientName,
        selfieUrl,
        membershipId: activeMembership.membershipId || activeMembership.id,
        membershipStatus: activeMembership.membershipStatus,
        duration: activeMembership.duration,
        endDate: activeMembership.endDate,
      };
    }

    /* ========================================================
       STEP 2: CHECK BOOKED GYM TRIAL FOR TODAY
    ======================================================== */

    const bookedTrial = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          trialDate: todayDateStr,
          trialstatus: { $in: ["booked", "rescheduled"] },
        },
        orderBy: { id: "desc" },
      });

    // Found booked trial for today -> mark completed and check in
    if (bookedTrial) {
      // Update trialstatus to completed
      await strapi.db.query("api::gym-trial.gym-trial").update({
        where: { id: bookedTrial.id },
        data: {
          trialstatus: "completed",
        },
      });

      if (bookedTrial.documentId && (strapi as any).documents) {
        try {
          await (strapi as any).documents("api::gym-trial.gym-trial").update({
            documentId: bookedTrial.documentId,
            data: {
              trialstatus: "completed",
            },
          });
        } catch (_) {}
      }

      const checkin = await strapi.entityService.create(
        "api::client-checkin.client-checkin",
        {
          data: {
            client_detail: client.id,
            club_owner: clubOwner.id,
            checkinType: "trial",
            checkinTime: new Date(),
          },
        },
      );

      try {
        await strapi
          .service("api::activity-log.activity-log")
          .createActivityLog({
            actorType: "client",
            actorId: client.documentId || client.id,
            actionType: "checkin",
            entityName: "client-checkin",
            entityId: checkin?.documentId || checkin?.id,
            description: `Checked in to ${gymName} (Free Trial)`,
          });
      } catch (actErr) {
        strapi.log.warn("[Checkin] Activity logging failed:", actErr);
      }

      return {
        checkinType: "trial",
        clientName,
        selfieUrl,
        trialDate: bookedTrial.trialDate,
        trialstatus: "completed",
      };
    }

    /* ========================================================
       STEP 3: NEITHER FOUND -> PROVIDE HELPFUL DIAGNOSTIC ERROR
    ======================================================== */

    // Check if free trial was already completed today
    const completedTrialToday = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          trialDate: todayDateStr,
          trialstatus: "completed",
        },
      });

    if (completedTrialToday) {
      throw new Error("Free trial for today has already been completed");
    }

    // Check if free trial was marked as no-show today
    const noShowTrialToday = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          trialDate: todayDateStr,
          $or: [{ trialstatus: "no-show" }, { trialstatus: "no_show" }],
        },
      });

    if (noShowTrialToday) {
      throw new Error("Free trial for today was marked as no-show");
    }

    // Check if trial is booked for a different date
    const otherDateTrial = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findOne({
        where: {
          client_detail: client.id,
          club_owner: clubOwner.id,
          trialstatus: "booked",
        },
        orderBy: { trialDate: "asc" },
      });

    if (otherDateTrial) {
      throw new Error(
        `Trial is booked for ${otherDateTrial.trialDate}, not today (${todayDateStr})`,
      );
    }

    // Check if there was an inactive/expired/pending membership
    if (existingMemberships && existingMemberships.length > 0) {
      const latest = existingMemberships[0];
      if (
        latest.membershipStatus === "expired" ||
        (latest.endDate && latest.endDate < todayDateStr)
      ) {
        throw new Error(
          "Gym membership has expired and no booked trial found for today",
        );
      }
      if (latest.membershipStatus === "cancelled") {
        throw new Error(
          "Gym membership is cancelled and no booked trial found for today",
        );
      }
      if (latest.membershipStatus === "pending") {
        throw new Error(
          "Gym membership payment is pending and no booked trial found for today",
        );
      }
    }

    throw new Error("No active membership or booked trial found for today");
  },

});
