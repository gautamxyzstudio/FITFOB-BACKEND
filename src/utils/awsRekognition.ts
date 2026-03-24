import AWS from "aws-sdk";

const rekognition = new AWS.Rekognition({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
  region: process.env.AWS_REGION || "ap-south-1",
});

interface CompareResult {
  matched: boolean;
  similarity: number;
}

export const compareFaces = async (
  selfieBuffer: Buffer,
  idBuffer: Buffer
): Promise<CompareResult> => {
  try {
    const params: AWS.Rekognition.CompareFacesRequest = {
      SourceImage: { Bytes: selfieBuffer },
      TargetImage: { Bytes: idBuffer },
      SimilarityThreshold: 85,
    };

    const response = await rekognition.compareFaces(params).promise();

    if (response.FaceMatches && response.FaceMatches.length > 0) {
      return {
        matched: true,
        similarity: response.FaceMatches[0].Similarity || 0,
      };
    }

    return {
      matched: false,
      similarity: 0,
    };
  } catch (error) {
    console.error("AWS ERROR:", error);
    throw error;
  }
};