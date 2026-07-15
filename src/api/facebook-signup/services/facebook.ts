import axios from "axios";

export const verifyFacebookToken = async (accessToken: string) => {
  const { data } = await axios.get(
    "https://graph.facebook.com/me",
    {
      params: {
        fields: "id,name,email,picture",
        access_token: accessToken,
      },
    }
  );

  if (!data?.email) {
    throw new Error("Invalid Facebook token.");
  }

  return data;
};