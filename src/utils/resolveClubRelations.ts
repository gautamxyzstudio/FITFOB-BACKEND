/**
 * Resolves club service and facility inputs (numeric IDs, documentIds, objects, or names)
 * into an array of numeric database IDs for relation linking.
 */

let cachedServices: any[] | null = null;
let servicesCacheTime = 0;
let cachedFacilities: any[] | null = null;
let facilitiesCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function resolveClubServiceIds(servicesInput: any): Promise<number[]> {
  if (!servicesInput) return [];

  let items = servicesInput;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [items];
    }
  }

  if (!Array.isArray(items)) {
    if (typeof items === "object" && items !== null) {
      items = Object.values(items);
    } else {
      items = [items];
    }
  }

  let allServices: any[] = [];
  const now = Date.now();
  if (cachedServices && now - servicesCacheTime < CACHE_TTL_MS) {
    allServices = cachedServices;
  } else {
    try {
      const res = await strapi.db.connection.raw(
        `SELECT id, document_id, LOWER(TRIM(name)) AS name FROM club_services`,
      );
      allServices = res?.rows || [];
      cachedServices = allServices;
      servicesCacheTime = now;
    } catch (err) {
      strapi.log.warn("Failed to fetch club_services directly, fallback:", err);
      allServices = cachedServices || [];
    }
  }

  const ids: number[] = [];

  for (const item of items) {
    if (!item) continue;

    // 1. Direct number ID
    if (typeof item === "number" && !isNaN(item)) {
      ids.push(item);
      continue;
    }

    // 2. Object with id, documentId, name, or serviceName
    if (typeof item === "object") {
      if (typeof item.id === "number" && !isNaN(item.id)) {
        ids.push(item.id);
        continue;
      }

      const docId = item.documentId || item.document_id;
      if (docId) {
        const found = allServices.find(
          (s: any) => s.document_id === String(docId).trim(),
        );
        if (found) {
          ids.push(found.id);
          continue;
        }
      }

      const nameStr =
        item.name || item.serviceName || item.service_name || item.title;
      if (nameStr) {
        const lowerName = String(nameStr).trim().toLowerCase();
        const found = allServices.find((s: any) => s.name === lowerName);
        if (found) {
          ids.push(found.id);
          continue;
        }
      }
    }

    // 3. String (could be numeric ID, documentId, or service name)
    if (typeof item === "string") {
      const str = item.trim();
      if (!isNaN(Number(str))) {
        ids.push(Number(str));
        continue;
      }

      const lowerStr = str.toLowerCase();
      const found = allServices.find(
        (s: any) => s.document_id === str || s.name === lowerStr,
      );
      if (found) {
        ids.push(found.id);
      }
    }
  }

  return Array.from(new Set(ids));
}

export async function resolveClubFacilityIds(facilitiesInput: any): Promise<number[]> {
  if (!facilitiesInput) return [];

  let items = facilitiesInput;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [items];
    }
  }

  if (!Array.isArray(items)) {
    if (typeof items === "object" && items !== null) {
      items = Object.values(items);
    } else {
      items = [items];
    }
  }

  let allFacilities: any[] = [];
  const now = Date.now();
  if (cachedFacilities && now - facilitiesCacheTime < CACHE_TTL_MS) {
    allFacilities = cachedFacilities;
  } else {
    try {
      const res = await strapi.db.connection.raw(
        `SELECT id, document_id, LOWER(TRIM(name)) AS name FROM club_facilities`,
      );
      allFacilities = res?.rows || [];
      cachedFacilities = allFacilities;
      facilitiesCacheTime = now;
    } catch (err) {
      strapi.log.warn("Failed to fetch club_facilities directly, fallback:", err);
      allFacilities = cachedFacilities || [];
    }
  }

  const ids: number[] = [];

  for (const item of items) {
    if (!item) continue;

    // 1. Direct number ID
    if (typeof item === "number" && !isNaN(item)) {
      ids.push(item);
      continue;
    }

    // 2. Object with id, documentId, name, or facilityName
    if (typeof item === "object") {
      if (typeof item.id === "number" && !isNaN(item.id)) {
        ids.push(item.id);
        continue;
      }

      const docId = item.documentId || item.document_id;
      if (docId) {
        const found = allFacilities.find(
          (f: any) => f.document_id === String(docId).trim(),
        );
        if (found) {
          ids.push(found.id);
          continue;
        }
      }

      const nameStr =
        item.name || item.facilityName || item.facility_name || item.title;
      if (nameStr) {
        const lowerName = String(nameStr).trim().toLowerCase();
        const found = allFacilities.find((f: any) => f.name === lowerName);
        if (found) {
          ids.push(found.id);
          continue;
        }
      }
    }

    // 3. String (could be numeric ID, documentId, or facility name)
    if (typeof item === "string") {
      const str = item.trim();
      if (!isNaN(Number(str))) {
        ids.push(Number(str));
        continue;
      }

      const lowerStr = str.toLowerCase();
      const found = allFacilities.find(
        (f: any) => f.document_id === str || f.name === lowerStr,
      );
      if (found) {
        ids.push(found.id);
      }
    }
  }

  return Array.from(new Set(ids));
}
