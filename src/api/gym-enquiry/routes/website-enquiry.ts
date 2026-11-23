/**
 * Public routes used by the fitfob.com website "Enquire now" form.
 *
 * They are called server-to-server by the Next.js website (never directly from the browser).
 * If WEBSITE_ENQUIRY_KEY is set in .env, every request must send the same value in the
 * `x-site-key` header.
 */

export default {
  routes: [
    {
      method: "GET",
      path: "/website-enquiry/gyms",
      handler: "gym-enquiry.websiteGyms",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/website-enquiry/cities",
      handler: "gym-enquiry.websiteCities",
      config: { auth: false },
    },
    {
      method: "POST",
      path: "/website-enquiry/submit",
      handler: "gym-enquiry.websiteSubmit",
      config: { auth: false },
    },
  ],
};
