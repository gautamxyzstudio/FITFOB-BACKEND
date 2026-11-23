/**
 * gym-enquiry core router (admin / authenticated access, controlled by Roles & Permissions).
 */

import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::gym-enquiry.gym-enquiry" as any);
