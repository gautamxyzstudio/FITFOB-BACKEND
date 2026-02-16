module.exports = {
    routes: [

        // resume onboarding
        {
            method: "GET",
            path: "/pending-club-owner/me",
            handler: "pending-club-owner.me",
            config: { auth: {} }
        },

        // step 1
        {
            method: "POST",
            path: "/pending-club-owner/club-owner-details",
            handler: "pending-club-owner.clubOwnerDetails",
            config: { auth: {} }
        },

        // step 2
        {
            method: "POST",
            path: "/pending-club-owner/location-details",
            handler: "pending-club-owner.locationDetails",
            config: { auth: {} }
        },

        // step 3
        {
            method: "POST",
            path: "/pending-club-owner/configure-club",
            handler: "pending-club-owner.configureClub",
            config: { auth: {} }
        },

        // step 4 (FINAL)
        {
            method: "POST",
            path: "/pending-club-owner/upload-club-photos",
            handler: "pending-club-owner.uploadClubPhotos",
            config: { auth: {} }
        }

    ]
};
