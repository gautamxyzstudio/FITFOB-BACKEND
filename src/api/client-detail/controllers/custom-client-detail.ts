/* ---------- HELPER: GET TODAY DATE (YYYY-MM-DD) ---------- */
function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* ---------- HAVERSINE DISTANCE HELPER ---------- */
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's radius in kilometers
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ---------- MEDIA URL FORMATTER ---------- */
function formatMediaUrl(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith("http")
    ? url
    : `${strapi.config.server.url || ""}${url}`;
}

/* ---------- EXTRACT FLAT STRING LIST (SERVICES / FACILITIES) ---------- */
function extractStringList(jsonField: any, relationItems: any[]): string[] {
  const result: string[] = [];

  // From relation entities (e.g. { name: "Gym" })
  if (Array.isArray(relationItems)) {
    for (const item of relationItems) {
      if (typeof item === "string" && item.trim()) {
        result.push(item.trim());
      } else if (
        item?.name &&
        typeof item.name === "string" &&
        item.name.trim()
      ) {
        result.push(item.name.trim());
      }
    }
  }

  // From JSON array or string
  if (jsonField) {
    let parsed = jsonField;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = parsed.split(",").map((s: string) => s.trim());
      }
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          result.push(item.trim());
        } else if (typeof item === "object" && item !== null) {
          const name =
            item.name || item.serviceName || item.facilityName || item.title;
          if (name && typeof name === "string" && name.trim()) {
            result.push(name.trim());
          }
        }
      }
    }
  }

  return Array.from(new Set(result));
}

export default {
  async getMyClientDetail(ctx) {
    try {
      /* GET LOGGED IN USER FROM TOKEN */
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      /* FIND CLIENT DETAIL FOR THIS USER */
      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          populate: {
            user: {
              fields: ["id", "username", "email"],
            },
            selfieUpload: true,
            governmentId: true,
          },
        });

      if (!clientDetail) {
        return ctx.notFound("Client detail not found");
      }

      ctx.body = clientDetail;
    } catch (error) {
      strapi.log.error(error);
      return ctx.internalServerError("Something went wrong");
    }
  },

  async getFavorites(ctx: any) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          select: ["id", "latitude", "longitude"],
          populate: {
            favorites: {
              select: [
                "id",
                "documentId",
                "clubName",
                "clubId",
                "latitude",
                "longitude",
                "city",
                "services",
                "facilities",
              ],
            },
          },
        });

      if (!clientDetail) {
        return ctx.notFound("Client detail not found");
      }

      const candidateOwners: any[] = Array.isArray(clientDetail.favorites)
        ? clientDetail.favorites
        : [];

      if (!candidateOwners || candidateOwners.length === 0) {
        return ctx.send({ data: [] });
      }

      const { latitude, longitude, lat, lon, lng } = ctx.query as any;
      const rawLat = latitude ?? lat ?? clientDetail.latitude;
      const rawLon = longitude ?? lon ?? lng ?? clientDetail.longitude;

      const hasCoordinates =
        rawLat !== undefined &&
        rawLat !== null &&
        rawLon !== undefined &&
        rawLon !== null &&
        String(rawLat).trim() !== "" &&
        String(rawLon).trim() !== "" &&
        !isNaN(Number(rawLat)) &&
        !isNaN(Number(rawLon));

      let filteredClubs: any[] = [];

      if (hasCoordinates) {
        const userLat = Number(rawLat);
        const userLon = Number(rawLon);

        for (const owner of candidateOwners) {
          if (owner.latitude && owner.longitude) {
            const ownerLat = Number(owner.latitude);
            const ownerLon = Number(owner.longitude);

            if (!isNaN(ownerLat) && !isNaN(ownerLon)) {
              const dist = calculateHaversineDistance(
                userLat,
                userLon,
                ownerLat,
                ownerLon,
              );

              filteredClubs.push({
                ...owner,
              });
            } else {
              filteredClubs.push({
                ...owner,
              });
            }
          } else {
            filteredClubs.push({
              ...owner,
            });
          }
        }

        // Sort closest to farthest if coordinates present
        filteredClubs.sort((a, b) => {
          if (a.distance === null) return 1;
          if (b.distance === null) return -1;
          return a.distance - b.distance;
        });
      } else {
        filteredClubs = candidateOwners.map((owner: any) => ({
          ...owner,
        }));
      }

      const clubOwnerIds = filteredClubs.map((c) => c.id);

      // Phase 2: Concurrent pipeline for lean relations
      const today = getTodayDateString();
      const [photosList, relationsList, plansList, holidaysList] =
        await Promise.all([
          // 1. Club Photos with images
          strapi.db.query("api::club-photo.club-photo").findMany({
            where: {
              club_owner: { id: { $in: clubOwnerIds } },
            },
            populate: {
              images: {
                select: ["url", "formats"],
              },
              club_owner: {
                select: ["id"],
              },
            },
          }),

          // 2. Club Services & Facilities relations
          strapi.db.query("api::club-owner.club-owner").findMany({
            where: {
              id: { $in: clubOwnerIds },
            },
            select: ["id"],
            populate: {
              club_services: {
                select: ["name"],
              },
              club_facilities: {
                select: ["name"],
              },
            },
          }),

          // 3. Active Local Membership Plans
          strapi.db
            .query("api::local-membership-plan.local-membership-plan")
            .findMany({
              where: {
                club_owner: { id: { $in: clubOwnerIds } },
                isActive: true,
              },
              select: [
                "id",
                "documentId",
                "planName",
                "price",
                "monthDuration",
                "validUpto",
                "isActive",
              ],
              populate: {
                club_owner: {
                  select: ["id"],
                },
              },
            }),

          // 4. Upcoming & Today Holidays (skipping past days)
          strapi.db.query("api::holdiday.holdiday").findMany({
            where: {
              club_owner: { id: { $in: clubOwnerIds } },
              $or: [
                { endDate: { $gte: today } },
                {
                  $and: [
                    { endDate: { $null: true } },
                    { startDate: { $gte: today } },
                  ],
                },
              ],
            },
            select: [
              "id",
              "documentId",
              "title",
              "closureType",
              "startDate",
              "endDate",
              "startTime",
              "endtime",
            ],
            populate: {
              club_owner: {
                select: ["id"],
              },
            },
            orderBy: { startDate: "asc" },
          }),
        ]);

      // Map photos by owner ID
      const photosByOwnerId = new Map<number, { url: string }[]>();
      for (const photo of photosList || []) {
        const ownerId = photo.club_owner?.id;
        if (!ownerId) continue;

        if (!photosByOwnerId.has(ownerId)) {
          photosByOwnerId.set(ownerId, []);
        }

        const existingPhotos = photosByOwnerId.get(ownerId)!;
        if (Array.isArray(photo.images)) {
          for (const img of photo.images) {
            if (img?.url) {
              const formattedUrl = formatMediaUrl(img.url);
              if (formattedUrl) {
                existingPhotos.push({ url: formattedUrl });
              }
            }
          }
        } else if (photo.images?.url) {
          const formattedUrl = formatMediaUrl(photo.images.url);
          if (formattedUrl) {
            existingPhotos.push({ url: formattedUrl });
          }
        }
      }

      // Map services and facilities by owner ID
      const servicesByOwnerId = new Map<number, string[]>();
      const facilitiesByOwnerId = new Map<number, string[]>();

      const relationMap = new Map<number, any>();
      for (const rel of relationsList || []) {
        relationMap.set(rel.id, rel);
      }

      for (const club of filteredClubs) {
        const rel = relationMap.get(club.id);
        const services = extractStringList(
          club.services,
          rel?.club_services || [],
        );
        const facilities = extractStringList(
          club.facilities,
          rel?.club_facilities || [],
        );
        servicesByOwnerId.set(club.id, services);
        facilitiesByOwnerId.set(club.id, facilities);
      }

      // Map active membership plans by owner ID
      const plansByOwnerId = new Map<number, any[]>();
      for (const plan of plansList || []) {
        const ownerId = plan.club_owner?.id;
        if (!ownerId) continue;

        if (!plansByOwnerId.has(ownerId)) {
          plansByOwnerId.set(ownerId, []);
        }

        plansByOwnerId.get(ownerId)!.push({
          documentId: plan.documentId,
          planName: plan.planName,
          price:
            typeof plan.price === "string"
              ? parseFloat(plan.price)
              : plan.price,
          monthDuration: plan.monthDuration,
          validUpto: plan.validUpto || "unlimited",
        });
      }

      // Map upcoming & today holidays by owner ID
      const holidaysByOwnerId = new Map<number, any[]>();
      for (const holiday of holidaysList || []) {
        const ownerId = holiday.club_owner?.id;
        if (!ownerId) continue;

        if (!holidaysByOwnerId.has(ownerId)) {
          holidaysByOwnerId.set(ownerId, []);
        }

        holidaysByOwnerId.get(ownerId)!.push({
          id: holiday.id,
          documentId: holiday.documentId,
          title: holiday.title,
          closureType: holiday.closureType,
          startDate: holiday.startDate,
          endDate: holiday.endDate || holiday.startDate,
          startTime: holiday.startTime || null,
          endtime: holiday.endtime || null,
        });
      }

      // Assemble clean, customized & lean response payload
      const data = filteredClubs.map((club: any) => ({
        id: club.id,
        documentId: club.documentId,
        clubName: club.clubName,
        clubId: club.clubId,
        club_photos: photosByOwnerId.get(club.id) || [],
        services: servicesByOwnerId.get(club.id) || [],
        facilities: facilitiesByOwnerId.get(club.id) || [],
        membershipPlans: plansByOwnerId.get(club.id) || [],
        holidays: holidaysByOwnerId.get(club.id) || [],
      }));

      return ctx.send({
        data,
      });
    } catch (error) {
      strapi.log.error("GET FAVORITES ERROR:", error);
      return ctx.internalServerError("Failed to fetch favorites");
    }
  },

  async addFavorite(ctx: any) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const clubOwnerParam =
        ctx.params.clubOwnerId ||
        ctx.params.id ||
        ctx.request.body?.clubOwnerId ||
        ctx.request.body?.id;

      if (!clubOwnerParam) {
        return ctx.badRequest(
          "Club owner identifier (clubOwnerId or id) is required",
        );
      }

      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          populate: {
            favorites: {
              select: ["id", "documentId", "clubId", "clubName"],
            },
          },
        });

      if (!clientDetail) {
        return ctx.notFound("Client detail not found");
      }

      const targetParamStr = String(clubOwnerParam).trim();
      const isNumeric =
        !isNaN(Number(targetParamStr)) && /^\d+$/.test(targetParamStr);

      let targetClubOwner: any = null;
      if ((strapi as any).documents && !isNumeric) {
        try {
          targetClubOwner = await (strapi as any)
            .documents("api::club-owner.club-owner")
            .findOne({
              documentId: targetParamStr,
              select: ["id", "documentId", "clubId", "clubName"],
            });
        } catch (e) {}
      }

      if (!targetClubOwner) {
        targetClubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: isNumeric
              ? {
                  $or: [
                    { id: Number(targetParamStr) },
                    { documentId: targetParamStr },
                    { clubId: targetParamStr },
                  ],
                }
              : {
                  $or: [
                    { documentId: targetParamStr },
                    { clubId: targetParamStr },
                  ],
                },
            select: ["id", "documentId", "clubId", "clubName"],
          });
      }

      if (!targetClubOwner) {
        return ctx.notFound("Club owner not found");
      }

      const currentFavorites: any[] = Array.isArray(clientDetail.favorites)
        ? clientDetail.favorites
        : [];

      const alreadyExists = currentFavorites.some(
        (fav: any) =>
          fav.id === targetClubOwner.id ||
          (fav.documentId && fav.documentId === targetClubOwner.documentId) ||
          (fav.clubId && fav.clubId === targetClubOwner.clubId),
      );

      if (alreadyExists) {
        return (ctx.body = {
          message: "Club owner is already added to favorites",
          clubOwner: {
            id: targetClubOwner.id,
            documentId: targetClubOwner.documentId,
            clubId: targetClubOwner.clubId,
            clubName: targetClubOwner.clubName,
          },
        });
      }

      const updatedIds = [
        ...currentFavorites.map((f: any) => f.id),
        targetClubOwner.id,
      ];
      await strapi.db.query("api::client-detail.client-detail").update({
        where: { id: clientDetail.id },
        data: {
          favorites: updatedIds,
        },
      });

      ctx.body = {
        message: "Club owner added to favorites",
        clubOwner: {
          id: targetClubOwner.id,
          documentId: targetClubOwner.documentId,
          clubId: targetClubOwner.clubId,
          clubName: targetClubOwner.clubName,
        },
      };
    } catch (error) {
      strapi.log.error("ADD FAVORITE ERROR:", error);
      return ctx.internalServerError("Failed to add favorite");
    }
  },

  async removeFavorite(ctx: any) {
    try {
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const clubOwnerParam =
        ctx.params.clubOwnerId ||
        ctx.params.id ||
        ctx.request.body?.clubOwnerId ||
        ctx.request.body?.id;

      if (!clubOwnerParam) {
        return ctx.badRequest(
          "Club owner identifier (clubOwnerId or id) is required",
        );
      }

      const clientDetail = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
          populate: {
            favorites: {
              select: ["id", "documentId", "clubId", "clubName"],
            },
          },
        });

      if (!clientDetail) {
        return ctx.notFound("Client detail not found");
      }

      const targetParamStr = String(clubOwnerParam).trim();
      const isNumeric =
        !isNaN(Number(targetParamStr)) && /^\d+$/.test(targetParamStr);

      let targetClubOwner: any = null;
      if ((strapi as any).documents && !isNumeric) {
        try {
          targetClubOwner = await (strapi as any)
            .documents("api::club-owner.club-owner")
            .findOne({
              documentId: targetParamStr,
              select: ["id", "documentId", "clubId", "clubName"],
            });
        } catch (e) {}
      }

      if (!targetClubOwner) {
        targetClubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: isNumeric
              ? {
                  $or: [
                    { id: Number(targetParamStr) },
                    { documentId: targetParamStr },
                    { clubId: targetParamStr },
                  ],
                }
              : {
                  $or: [
                    { documentId: targetParamStr },
                    { clubId: targetParamStr },
                  ],
                },
            select: ["id", "documentId", "clubId", "clubName"],
          });
      }

      if (!targetClubOwner) {
        return ctx.notFound("Club owner not found");
      }

      const currentFavorites: any[] = Array.isArray(clientDetail.favorites)
        ? clientDetail.favorites
        : [];

      const existsInFavorites = currentFavorites.some(
        (fav: any) =>
          fav.id === targetClubOwner.id ||
          (fav.documentId && fav.documentId === targetClubOwner.documentId) ||
          (fav.clubId && fav.clubId === targetClubOwner.clubId),
      );

      if (!existsInFavorites) {
        return (ctx.body = {
          message: "Club owner is not in favorites",
        });
      }

      const updatedFavorites = currentFavorites.filter(
        (fav: any) =>
          fav.id !== targetClubOwner.id &&
          fav.documentId !== targetClubOwner.documentId &&
          fav.clubId !== targetClubOwner.clubId,
      );

      const updatedIds = updatedFavorites.map((f: any) => f.id);

      await strapi.db.query("api::client-detail.client-detail").update({
        where: { id: clientDetail.id },
        data: {
          favorites: updatedIds,
        },
      });

      ctx.body = {
        message: "Club owner removed from favorites",
        clubOwner: {
          id: targetClubOwner.id,
          documentId: targetClubOwner.documentId,
          clubId: targetClubOwner.clubId,
          clubName: targetClubOwner.clubName,
        },
      };
    } catch (error) {
      strapi.log.error("REMOVE FAVORITE ERROR:", error);
      return ctx.internalServerError("Failed to remove favorite");
    }
  },

  async markClientRead(ctx: any) {
    try {
      const admin = ctx.state.user;
      const { id } = ctx.params;

      if (!admin) {
        return ctx.unauthorized("Admin not found");
      }

      const client = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { id },
          select: ["id", "read_by_admins"],
        });

      if (!client) {
        return ctx.notFound("Client not found");
      }

      let readers = client.read_by_admins || [];

      if (!readers.includes(admin.id)) {
        readers.push(admin.id);

        await strapi.db.query("api::client-detail.client-detail").update({
          where: { id },
          data: {
            read_by_admins: readers,
          },
        });
      }

      ctx.send({
        message: "Client request marked as read",
      });
    } catch (error) {
      strapi.log.error("CLIENT READ ERROR:", error);
      ctx.internalServerError("Something went wrong");
    }
  },

  async approvedClients(ctx: any) {
    try {
      const { search } = ctx.query as any;

      const data: any[] = await strapi.entityService.findMany(
        "api::client-detail.client-detail",
        {
          populate: {
            user: {
              populate: {
                role: true,
              },
            },
            selfieUpload: true,
            governmentId: true,
          },
          sort: { id: "desc" },
        },
      );

      // filter approved users
      let finalData = data.filter(
        (item: any) => item.user?.verification_status === "approved",
      );

      // 🔍 Search
      if (search?.trim()) {
        const searchValue = search.replace(/\s+/g, "").toLowerCase();

        finalData = finalData.filter((item: any) => {
          const name = item.name?.replace(/\s+/g, "").toLowerCase();
          const email = item.email?.replace(/\s+/g, "").toLowerCase();
          const phone = item.phoneNumber?.replace(/\s+/g, "").toLowerCase();

          return (
            name?.includes(searchValue) ||
            email?.includes(searchValue) ||
            phone?.includes(searchValue)
          );
        });
      }

      finalData = finalData.map((item) => ({
        ...item,
        isRead: item.read_by_admins?.length > 0,
      }));

      ctx.body = {
        success: true,
        total: finalData.length,
        data: finalData,
      };
    } catch (err) {
      console.error(err);
      ctx.throw(500, "Failed to fetch approved clients");
    }
  },

  async pendingClients(ctx: any) {
    try {
      const { search } = ctx.query as any;

      const data: any[] = await strapi.entityService.findMany(
        "api::client-detail.client-detail",
        {
          populate: {
            user: {
              populate: {
                role: true,
              },
            },
            selfieUpload: true,
            governmentId: true,
          },
          sort: { id: "desc" },
        },
      );

      // filter pending users
      let finalData = data.filter(
        (item: any) => item.user?.verification_status === "pending",
      );

      // 🔍 Search
      if (search?.trim()) {
        const searchValue = search.replace(/\s+/g, "").toLowerCase();

        finalData = finalData.filter((item: any) => {
          const name = item.name?.replace(/\s+/g, "").toLowerCase();
          const email = item.email?.replace(/\s+/g, "").toLowerCase();
          const phone = item.phoneNumber?.replace(/\s+/g, "").toLowerCase();

          return (
            name?.includes(searchValue) ||
            email?.includes(searchValue) ||
            phone?.includes(searchValue)
          );
        });
      }

      finalData = finalData.map((item) => ({
        ...item,
        isRead: item.read_by_admins?.length > 0,
      }));

      ctx.body = {
        success: true,
        total: finalData.length,
        data: finalData,
      };
    } catch (err) {
      console.error(err);
      ctx.throw(500, "Failed to fetch pending clients");
    }
  },
};
