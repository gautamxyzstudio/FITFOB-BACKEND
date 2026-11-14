import { Context } from "koa";

/* =======================================================
   HELPERS
======================================================= */

function formatMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const baseUrl = strapi.config.get("server.url") || "";
  return `${baseUrl}${url}`;
}

function getMediaUrl(media: any): string | null {
  if (!media) return null;
  if (Array.isArray(media)) {
    if (media.length === 0) return null;
    return getMediaUrl(media[0]);
  }
  if (typeof media === "string") return formatMediaUrl(media);

  const target = media.data ? media.data : media;
  const item = target.attributes ? target.attributes : target;

  let formats = item.formats;
  if (typeof formats === "string") {
    try {
      formats = JSON.parse(formats);
    } catch (_) {}
  }

  const rawUrl =
    formats?.small?.url ||
    formats?.thumbnail?.url ||
    item.url ||
    null;
  return formatMediaUrl(rawUrl);
}

function getCommissionDetails(membership: any) {
  let commTx: any = null;
  if (
    Array.isArray(membership.commission_transactions) &&
    membership.commission_transactions.length > 0
  ) {
    commTx = membership.commission_transactions[0];
  } else if (
    membership.commission_transactions &&
    typeof membership.commission_transactions === "object"
  ) {
    commTx = membership.commission_transactions;
  }

  const mode = (commTx?.commissionMode || "").toLowerCase();
  const promotionApplied = Boolean(
    commTx?.promotionApplied || mode === "promotion"
  );

  let commissionCharged = false;
  if (mode === "promotion" || promotionApplied) {
    commissionCharged = false;
  } else if (mode === "custom" || mode === "default") {
    commissionCharged = true;
  } else {
    commissionCharged = Number(commTx?.commissionAmount || 0) > 0;
  }

  const commissionAmount =
    commTx?.commissionAmount != null
      ? typeof commTx.commissionAmount === "string"
        ? parseFloat(commTx.commissionAmount)
        : Number(commTx.commissionAmount)
      : 0;

  const gymPayout =
    commTx?.gymPayout != null
      ? typeof commTx.gymPayout === "string"
        ? parseFloat(commTx.gymPayout)
        : Number(commTx.gymPayout)
      : null;

  return {
    commissionCharged,
    commissionMode:
      commTx?.commissionMode || (promotionApplied ? "promotion" : "default"),
    commissionAmount,
    promotionApplied,
    gymPayout,
    transactionStatus: commTx?.transactionStatus || null,
    notes: commTx?.notes || null,
  };
}

async function getAuthUser(ctx: Context) {
  let user = ctx.state?.user;
  if (user?.id) return user;

  const authHeader = ctx.request?.header?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    try {
      const jwtService = strapi.plugin("users-permissions")?.service("jwt");
      if (jwtService?.verify) {
        const payload = await jwtService.verify(token);
        if (payload?.id) {
          user = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: payload.id },
              populate: { role: true },
            });
          if (user) {
            ctx.state.user = user;
            return user;
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

async function resolveClubOwner(ctx: Context, user: any) {
  const roleName = (
    user.role?.name ||
    user.role?.type ||
    ""
  ).toLowerCase();
  const isAdmin = roleName === "admin" || roleName === "superadmin";

  let clubOwner: any = null;

  const targetClubOwnerId =
    ctx.query.clubOwnerId ||
    ctx.query.club_owner_id ||
    ctx.query.clubId;

  if (isAdmin && targetClubOwnerId) {
    const targetStr = String(targetClubOwnerId).trim();
    const isNum = !isNaN(Number(targetStr)) && /^\d+$/.test(targetStr);
    clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({
        where: isNum
          ? { id: Number(targetStr) }
          : { clubId: targetStr },
      });
  }

  if (!clubOwner) {
    clubOwner = await strapi.db
      .query("api::club-owner.club-owner")
      .findOne({
        where: { user: user.id },
      });
  }

  return clubOwner;
}

/* =======================================================
   CONTROLLER EXPORT
======================================================= */

export default {
  /**
   * GET /api/member-list
   * Returns users who bought this club owner's gym membership.
   *
   * Response fields per member:
   * - documentId (client's documentId)
   * - name (client name)
   * - selfieUrl (selfie url)
   * - status ("active" | "inactive" based on latest gym membership with this owner)
   */
  async memberList(ctx: Context) {
    try {
      const user = await getAuthUser(ctx);

      if (!user?.id) {
        return ctx.unauthorized("Authentication required");
      }

      const clubOwner = await resolveClubOwner(ctx, user);

      if (!clubOwner) {
        return ctx.notFound("Club owner profile not found for this user");
      }

      // 1. Fetch all gym contracts for this club owner
      const contracts = await strapi.db
        .query("api::gym-contract.gym-contract")
        .findMany({
          where: { club_owner: clubOwner.id },
          select: ["id", "documentId", "contractId"],
        });

      if (!contracts || contracts.length === 0) {
        return ctx.send({
          summary: {
            totalMembers: 0,
            activeMembers: 0,
            inactiveMembers: 0,
            
          },
          data: [],
        });
      }

      const contractIds = contracts.map((c: any) => c.id);

      // 2. Fetch all gym memberships under this club owner's contracts
      const memberships: any[] = await strapi.db
        .query("api::gym-membership.gym-membership")
        .findMany({
          where: {
            gym_contract: { id: { $in: contractIds } },
          },
          populate: {
            client_detail: {
              populate: {
                selfieUpload: true,
                user: {
                  select: ["id", "username", "email", "phoneNumber"],
                },
              },
            },
            commission_transactions: true,
          },
          orderBy: { id: "desc" },
        });

      // 3. Filter valid purchased memberships (exclude failed or uncompleted pending checkouts)
      const purchasedMemberships = memberships.filter((m: any) => {
        if (!m.client_detail) return false;
        if (m.paymentStatus === "failed") return false;
        if (
          m.paymentStatus === "pending" &&
          m.membershipStatus === "pending" &&
          !m.paidAt
        ) {
          return false;
        }
        return true;
      });

      // 4. Group memberships by client
      const clientMap = new Map<
        string | number,
        { client: any; memberships: any[] }
      >();

      for (const m of purchasedMemberships) {
        const client = m.client_detail;
        const key = client.id || client.documentId || client.clientId;
        if (!key) continue;

        if (!clientMap.has(key)) {
          clientMap.set(key, { client, memberships: [] });
        }
        clientMap.get(key)!.memberships.push(m);
      }

      // 5. Build member records
      const allMembers: any[] = [];

      for (const [, entry] of clientMap) {
        const { client, memberships: clientMemberships } = entry;

        // Sort memberships newest to oldest
        clientMemberships.sort((a, b) => {
          const timeA = new Date(
            a.startDate || a.paidAt || a.createdAt || 0
          ).getTime();
          const timeB = new Date(
            b.startDate || b.paidAt || b.createdAt || 0
          ).getTime();
          if (timeA !== timeB) return timeB - timeA;
          return (b.id || 0) - (a.id || 0);
        });

        const latestMembership = clientMemberships[0];
        const isMemberActive =
          latestMembership.membershipStatus === "active";
        const status = isMemberActive ? "active" : "inactive";

        const comm = getCommissionDetails(latestMembership);

        allMembers.push({
          documentId: client.documentId || null,
          clientDocumentId: client.documentId || null,
          clientId: client.clientId || null,
          name: client.name || client.user?.username || null,
          selfieUrl: getMediaUrl(client.selfieUpload),
          status,
          // Internal flags retained for query filtering
          _isCommissionCharged: comm.commissionCharged,
          _email: client.email || client.user?.email || "",
          _phoneNumber: client.phoneNumber || client.user?.phoneNumber || "",
        });
      }

      // 6. Apply filters
      const rawStatus = (
        ctx.query.status ||
        ctx.query.memberStatus ||
        ""
      )
        .toString()
        .toLowerCase()
        .trim();

      const rawIsActive =
        ctx.query.isActive !== undefined
          ? String(ctx.query.isActive).toLowerCase().trim()
          : ctx.query.active !== undefined
          ? String(ctx.query.active).toLowerCase().trim()
          : "";

      let statusFilter: "active" | "inactive" | "all" = "all";
      if (
        rawStatus === "active" ||
        rawIsActive === "true" ||
        rawIsActive === "1"
      ) {
        statusFilter = "active";
      } else if (
        rawStatus === "inactive" ||
        rawIsActive === "false" ||
        rawIsActive === "0"
      ) {
        statusFilter = "inactive";
      }

      const rawComm = (
        ctx.query.commissionCharged !== undefined
          ? String(ctx.query.commissionCharged)
          : ctx.query.isCommissionCharged !== undefined
          ? String(ctx.query.isCommissionCharged)
          : ctx.query.commission !== undefined
          ? String(ctx.query.commission)
          : ""
      )
        .toLowerCase()
        .trim();

      let commissionFilter: "charged" | "not_charged" | "all" = "all";
      if (["true", "charged", "yes", "1"].includes(rawComm)) {
        commissionFilter = "charged";
      } else if (
        [
          "false",
          "not_charged",
          "uncharged",
          "free",
          "promotional",
          "no",
          "0",
        ].includes(rawComm)
      ) {
        commissionFilter = "not_charged";
      }

      const search = (ctx.query.search || ctx.query.q || "")
        .toString()
        .toLowerCase()
        .trim();

      let filteredMembers = allMembers;

      if (statusFilter === "active") {
        filteredMembers = filteredMembers.filter(
          (m) => m.status === "active"
        );
      } else if (statusFilter === "inactive") {
        filteredMembers = filteredMembers.filter(
          (m) => m.status === "inactive"
        );
      }

      if (commissionFilter === "charged") {
        filteredMembers = filteredMembers.filter(
          (m) => m._isCommissionCharged
        );
      } else if (commissionFilter === "not_charged") {
        filteredMembers = filteredMembers.filter(
          (m) => !m._isCommissionCharged
        );
      }

      if (search) {
        filteredMembers = filteredMembers.filter((m) => {
          const nameMatch = m.name?.toLowerCase().includes(search);
          const phoneMatch = m._phoneNumber?.toLowerCase().includes(search);
          const emailMatch = m._email?.toLowerCase().includes(search);
          const clientMatch = m.clientId?.toLowerCase().includes(search);
          return Boolean(
            nameMatch || phoneMatch || emailMatch || clientMatch
          );
        });
      }

      // Map to strictly requested fields
      const formattedResponseMembers = filteredMembers.map((m) => ({
        clientDocumentId: m.clientDocumentId,
        name: m.name,
        selfieUrl: m.selfieUrl,
        status: m.status,
      }));

      // 7. Optional Pagination
      const rawPageSize = ctx.query.pageSize || ctx.query.limit;
      let paginatedData = formattedResponseMembers;
      let paginationMeta: any = null;

      if (rawPageSize) {
        const page = Math.max(
          1,
          parseInt(String(ctx.query.page || "1"), 10) || 1
        );
        const pageSize = Math.max(
          1,
          parseInt(String(rawPageSize), 10) || 10
        );
        const total = formattedResponseMembers.length;
        const pageCount = Math.ceil(total / pageSize);
        const startIndex = (page - 1) * pageSize;
        paginatedData = formattedResponseMembers.slice(
          startIndex,
          startIndex + pageSize
        );

        paginationMeta = {
          page,
          pageSize,
          pageCount,
          total,
        };
      }

      return ctx.send(paginatedData);
    } catch (error) {
      strapi.log.error("Error fetching member list:", error);
      return ctx.internalServerError("Failed to fetch member list");
    }
  },

  /**
   * GET /api/member-list/:documentId
   * (also /api/member-memberships/:documentId)
   *
   * Returns all paid gym memberships for a specific client associated with the logged-in owner.
   *
   * Response returns:
   * - status (membership status)
   * - startDate
   * - endDate
   * - clientName
   * - selfieUrl
   * - commissionCharged (boolean: false if commissionMode === "promotion", true if "custom" or "default")
   */
  async memberMemberships(ctx: Context) {
    try {
      const user = await getAuthUser(ctx);

      if (!user?.id) {
        return ctx.unauthorized("Authentication required");
      }

      const clubOwner = await resolveClubOwner(ctx, user);

      if (!clubOwner) {
        return ctx.notFound("Club owner profile not found for this user");
      }

      const rawDocumentId =
        ctx.params.documentId ||
        ctx.params.clientDocumentId ||
        ctx.params.id;

      if (!rawDocumentId || !String(rawDocumentId).trim()) {
        return ctx.badRequest("Client document ID is required");
      }

      const targetDoc = String(rawDocumentId).trim();
      const isNum = !isNaN(Number(targetDoc)) && /^\d+$/.test(targetDoc);

      // 1. Find client detail
      const client = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: isNum
            ? { id: Number(targetDoc) }
            : { documentId: targetDoc },
          populate: {
            selfieUpload: true,
            user: {
              select: ["id", "username", "email", "phoneNumber"],
            },
          },
        });

      if (!client) {
        return ctx.notFound("Client profile not found");
      }

      // 2. Fetch gym contracts for this club owner
      const contracts = await strapi.db
        .query("api::gym-contract.gym-contract")
        .findMany({
          where: { club_owner: clubOwner.id },
          select: ["id", "documentId", "contractId"],
        });

      if (!contracts || contracts.length === 0) {
        return ctx.send({
          success: true,
          client: {
            documentId: client.documentId,
            clientDocumentId: client.documentId,
            name: client.name || client.user?.username || null,
            selfieUrl: getMediaUrl(client.selfieUpload),
          },
          totalMemberships: 0,
          data: [],
        });
      }

      const contractIds = contracts.map((c: any) => c.id);

      // 3. Fetch all paid gym memberships for this client under this owner's contracts
      const memberships: any[] = await strapi.db
        .query("api::gym-membership.gym-membership")
        .findMany({
          where: {
            client_detail: client.id,
            gym_contract: { id: { $in: contractIds } },
            $or: [
              { paymentStatus: "paid" },
              { paidAt: { $notNull: true } },
            ],
          },
          populate: {
            commission_transactions: true,
            membership_plan_price: true,
            gym_contract: {
              select: ["id", "contractId"],
            },
          },
          orderBy: { id: "desc" },
        });

      // 3b. Fallback: resolve missing commission transactions if any
      const membershipIdsWithoutComm = memberships
        .filter(
          (m: any) =>
            !m.commission_transactions ||
            (Array.isArray(m.commission_transactions) &&
              m.commission_transactions.length === 0)
        )
        .map((m: any) => m.id);

      if (membershipIdsWithoutComm.length > 0) {
        try {
          const extraComms = await strapi.db
            .query("api::commission-transaction.commission-transaction")
            .findMany({
              where: {
                gym_membership: { id: { $in: membershipIdsWithoutComm } },
              },
              populate: {
                gym_membership: { select: ["id"] },
              },
            });

          if (Array.isArray(extraComms) && extraComms.length > 0) {
            const commByMembershipId = new Map<number, any>();
            for (const c of extraComms) {
              const memId = c.gym_membership?.id;
              if (memId && !commByMembershipId.has(memId)) {
                commByMembershipId.set(memId, c);
              }
            }
            for (const m of memberships) {
              if (
                !m.commission_transactions ||
                (Array.isArray(m.commission_transactions) &&
                  m.commission_transactions.length === 0)
              ) {
                const found = commByMembershipId.get(m.id);
                if (found) {
                  m.commission_transactions = [found];
                }
              }
            }
          }
        } catch (commErr) {
          strapi.log.warn(
            "Fallback commission transactions query encountered an issue:",
            commErr
          );
        }
      }

      // 4. Format memberships
      const clientName = client.name || client.user?.username || null;
      const selfieUrl = getMediaUrl(client.selfieUpload);

      const formattedMemberships = memberships.map((m: any) => {
        const comm = getCommissionDetails(m);

        return {
          membershipId: m.membershipId || null,
          membershipStatus: m.membershipStatus || null,
          startDate: m.startDate || null,
          endDate: m.endDate || null,
          commissionCharged: comm.commissionCharged,
          plan: m.duration || null,
          duration: m.durationMonths ?? null,
        };
      });

      return ctx.send({

        client: {
          name: clientName,
          selfieUrl,
        },
       memberships:formattedMemberships,
      });
    } catch (error) {
      strapi.log.error("Error fetching member memberships:", error);
      return ctx.internalServerError(
        "Failed to fetch member memberships"
      );
    }
  },
};
