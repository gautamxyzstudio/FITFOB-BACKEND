/**
 * pending-client-detail router
 */

export default {
routes: [

/* START / RESUME ONBOARDING */
{
  method: "GET",
  path: "/pending-client/me",
  handler: "pending-client-detail.me",
  config: { auth: {} },
},

/* STEP 1 BASIC INFO */
{
  method: "POST",
  path: "/pending-client/basic-info",
  handler: "pending-client-detail.basicInfo",
  config: { auth: {} },
},

/* STEP 2 BODY INFO */
{
  method: "POST",
  path: "/pending-client/body-info",
  handler: "pending-client-detail.bodyInfo",
  config: { auth: {} },
},

/* STEP 3 LOCATION */
{
  method: "POST",
  path: "/pending-client/location",
  handler: "pending-client-detail.location",
  config: { auth: {} },
},

/* STEP 4 SELFIE */
{
  method: "POST",
  path: "/pending-client/selfie",
  handler: "pending-client-detail.selfie",
  config: { auth: {} },
},

/* STEP 5 GOVERNMENT ID */
{
  method: "POST",
  path: "/pending-client/government-id",
  handler: "pending-client-detail.governmentId",
  config: { auth: {} },
},

],
};

