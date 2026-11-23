/**
 * gym-enquiry controller
 *
 * Core CRUD actions (for the admin panel) plus three public actions for the website:
 *   GET  /api/website-enquiry/gyms?lat=..&lng=..&radius=5|10   -> approved gyms within the radius
 *   GET  /api/website-enquiry/gyms?city=Mohali                 -> approved gyms in a city
 *   GET  /api/website-enquiry/cities                           -> cities that have approved gyms
 *   POST /api/website-enquiry/submit                           -> save an enquiry for a partner gym
 *                                                                 (gymId) or a gym from the website's
 *                                                                 Tricity list (gymSource: "listing")
 *
 * Gym coordinates and the visitor's coordinates are never returned to the website;
 * only the computed distance in km is.
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

const ENQUIRY_UID = "api::gym-enquiry.gym-enquiry" as any;
const CLUB_UID = "api::club-owner.club-owner" as any;

const ALLOWED_RADII = [5, 10];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

type Club = {
  documentId: string;
  clubName: string | null;
  city: string | null;
  clubAddress: string | null;
  clubCategory: string | null;
  latitude: string | null;
  longitude: string | null;
};

function siteKeyOk(ctx: Context) {
  const expected = process.env.WEBSITE_ENQUIRY_KEY;
  if (!expected) return true;
  return ctx.request.header["x-site-key"] === expected;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validCoords(lat: number | null, lng: number | null) {
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Great-circle distance in km. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

async function approvedClubs(strapi: any, where: Record<string, unknown> = {}): Promise<Club[]> {
  return strapi.db.query(CLUB_UID).findMany({
    select: ["documentId", "clubName", "city", "clubAddress", "clubCategory", "latitude", "longitude"],
    where: { ...where, user: { verification_status: "approved" } },
    orderBy: { clubName: "asc" },
  });
}

/** Shape sent to the website: no coordinates, no owner contact details. */
function publicGym(c: Club, distanceKm: number | null = null) {
  return {
    id: c.documentId,
    name: c.clubName || "Unnamed gym",
    city: c.city || null,
    address: c.clubAddress || null,
    category: c.clubCategory || null,
    distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
  };
}

export default factories.createCoreController(ENQUIRY_UID, ({ strapi }) => ({
  async websiteGyms(ctx: Context) {
    if (!siteKeyOk(ctx)) return ctx.forbidden("Invalid site key");
    try {
      const q = ctx.query as Record<string, string>;
      const lat = toNum(q.lat ?? q.latitude);
      const lng = toNum(q.lng ?? q.lon ?? q.longitude);

      if (validCoords(lat, lng)) {
        const radius = ALLOWED_RADII.includes(Number(q.radius)) ? Number(q.radius) : 10;
        const gyms = (await approvedClubs(strapi))
          .map((c) => {
            const cLat = toNum(c.latitude);
            const cLng = toNum(c.longitude);
            if (!validCoords(cLat, cLng)) return null;
            return { club: c, d: haversineKm(lat!, lng!, cLat!, cLng!) };
          })
          .filter((x): x is { club: Club; d: number } => !!x && x.d <= radius)
          .sort((a, b) => a.d - b.d)
          .slice(0, 50)
          .map((x) => publicGym(x.club, x.d));
        return ctx.send({ mode: "nearby", radiusKm: radius, data: gyms });
      }

      const city = clean(q.city, 80);
      if (city) {
        const gyms = (await approvedClubs(strapi, { city: { $eqi: city } })).map((c) => publicGym(c));
        return ctx.send({ mode: "city", city, data: gyms });
      }

      return ctx.badRequest("Send lat & lng (with radius 5 or 10) or a city.");
    } catch (err) {
      strapi.log.error("[website-enquiry] gyms failed", err);
      return ctx.internalServerError("Could not load gyms");
    }
  },

  async websiteCities(ctx: Context) {
    if (!siteKeyOk(ctx)) return ctx.forbidden("Invalid site key");
    try {
      const counts = new Map<string, { name: string; gyms: number }>();
      for (const c of await approvedClubs(strapi)) {
        const name = (c.city || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const entry = counts.get(key) ?? { name, gyms: 0 };
        entry.gyms += 1;
        counts.set(key, entry);
      }
      const data = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
      return ctx.send({ data });
    } catch (err) {
      strapi.log.error("[website-enquiry] cities failed", err);
      return ctx.internalServerError("Could not load cities");
    }
  },

  async websiteSubmit(ctx: Context) {
    if (!siteKeyOk(ctx)) return ctx.forbidden("Invalid site key");
    try {
      const body: any = (ctx.request as any).body ?? {};
      const fullName = clean(body.fullName, 120);
      const email = clean(body.email, 160).toLowerCase();
      const phone = clean(body.phone, 20);
      const locationMethod = body.locationMethod === "gps" ? "gps" : "manual";
      const lat = toNum(body.latitude);
      const lng = toNum(body.longitude);
      const radius = ALLOWED_RADII.includes(Number(body.radiusKm)) ? Number(body.radiusKm) : null;
      const hasCoords = locationMethod === "gps" && validCoords(lat, lng);

      if (fullName.length < 2) return ctx.badRequest("Please enter your name.");
      if (!EMAIL_RE.test(email)) return ctx.badRequest("Please enter a valid email address.");
      if (!/^\+?[0-9 ]{10,16}$/.test(phone)) return ctx.badRequest("Please enter a valid phone number.");

      const isListing = body.gymSource === "listing";
      let gymData: Record<string, unknown>;
      let duplicateWhere: Record<string, unknown>;

      if (isListing) {
        // Gym from the website's Tricity list (not a Fitfob partner yet).
        const listingId = clean(body.listingId, 32);
        const gymName = clean(body.gymName, 160);
        if (!listingId || !gymName) return ctx.badRequest("Please choose a gym.");
        const d = toNum(body.distanceKm);
        gymData = {
          gymSource: "listing",
          listingId,
          clubName: gymName,
          gymAddress: clean(body.gymAddress, 255) || null,
          city: clean(body.gymCity, 80) || null,
          distanceKm: hasCoords && d !== null && d >= 0 && d <= 50 ? Math.round(d * 100) / 100 : null,
        };
        duplicateWhere = { listingId };
      } else {
        // Approved Fitfob partner gym (club-owner).
        const gymId = clean(body.gymId, 64);
        if (!gymId) return ctx.badRequest("Please choose a gym.");
        const [club] = await approvedClubs(strapi, { documentId: gymId });
        if (!club) return ctx.badRequest("That gym is not available. Please choose another.");
        const cLat = toNum(club.latitude);
        const cLng = toNum(club.longitude);
        gymData = {
          gymSource: "partner",
          club_owner: { connect: [{ documentId: club.documentId }] },
          clubName: club.clubName,
          gymAddress: club.clubAddress,
          city: club.city,
          distanceKm:
            hasCoords && validCoords(cLat, cLng)
              ? Math.round(haversineKm(lat!, lng!, cLat!, cLng!) * 100) / 100
              : null,
        };
        duplicateWhere = { club_owner: { documentId: gymId } };
      }

      // Same person + same gym within 24h: don't create a duplicate, but still report success.
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
      const existing = await strapi.db.query(ENQUIRY_UID).findOne({
        select: ["documentId"],
        where: { email, ...duplicateWhere, createdAt: { $gte: since } },
      });
      if (existing) return ctx.send({ ok: true, duplicate: true });

      await strapi.documents(ENQUIRY_UID).create({
        data: {
          fullName,
          email,
          phone,
          ...gymData,
          locationMethod,
          latitude: hasCoords ? lat : null,
          longitude: hasCoords ? lng : null,
          searchRadiusKm: hasCoords ? radius : null,
          enquiryStatus: "new",
          source: "website",
        },
      });

      return ctx.send({ ok: true });
    } catch (err) {
      strapi.log.error("[website-enquiry] submit failed", err);
      return ctx.internalServerError("Could not save your enquiry");
    }
  },
}));
