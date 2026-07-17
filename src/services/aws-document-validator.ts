import AWS from "aws-sdk";

const textract = new AWS.Textract({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
  region: process.env.AWS_REGION || "ap-south-1",
});

interface ValidationResult {
  valid: boolean;
  documentType:
    | "aadhaar"
    | "passport"
    | "driving-license"
    | "pan"
    | "voter-id"
    | "unknown";
}

export const validateGovernmentDocument = async (
  buffer: Buffer
): Promise<ValidationResult> => {
  const response = await textract
    .detectDocumentText({
      Document: {
        Bytes: buffer,
      },
    })
    .promise();

  const text = (
    response.Blocks?.filter((b) => b.BlockType === "LINE")
      .map((b) => b.Text)
      .join(" ")
      .toLowerCase() || ""
  );

  // Aadhaar
  if (
    text.includes("aadhaar") ||
    text.includes("uidai") ||
    text.includes("government of india")
  ) {
    return {
      valid: true,
      documentType: "aadhaar",
    };
  }

  // Passport
  if (
    text.includes("passport") ||
    text.includes("republic of india")
  ) {
    return {
      valid: true,
      documentType: "passport",
    };
  }

  // Driving Licence
  if (
    text.includes("driving licence") ||
    text.includes("driving license") ||
    text.includes("transport")
  ) {
    return {
      valid: true,
      documentType: "driving-license",
    };
  }

  // PAN
  if (
    text.includes("income tax department") ||
    text.includes("permanent account number")
  ) {
    return {
      valid: true,
      documentType: "pan",
    };
  }

  // Voter ID
  if (
    text.includes("election commission") ||
    text.includes("elector")
  ) {
    return {
      valid: true,
      documentType: "voter-id",
    };
  }

  return {
    valid: false,
    documentType: "unknown",
  };
};