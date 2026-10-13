import AWS from "aws-sdk";
import { PDFParse } from "pdf-parse";

const awsConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
  region: process.env.AWS_REGION || "ap-south-1",
};

const textract = new AWS.Textract(awsConfig);
const rekognition = new AWS.Rekognition(awsConfig);

export type OwnerDocumentType =
  | "aadhaar"
  | "pan"
  | "voter-id"
  | "driving-license"
  | "passport"
  | "gst"
  | "bank-statement-or-cheque"
  | "udyam-msme"
  | "unknown";

export interface OwnerDocumentValidationResult {
  valid: boolean;
  documentType: OwnerDocumentType;
  displayName: string;
}

interface DocumentQuery {
  Text: string;
  Alias: string;
}

interface DocumentConfig {
  displayName: string;
  requiresFace: boolean;
  requiresQr: boolean;
  requiresMrz: boolean;
  validateExpiry: boolean;
  requiredFields: string[];
  queries: DocumentQuery[];
}

/*
|--------------------------------------------------------------------------
| Document configuration
|--------------------------------------------------------------------------
*/

const DOCUMENT_CONFIG: Record<
  Exclude<OwnerDocumentType, "unknown">,
  DocumentConfig
> = {
  pan: {
    displayName: "PAN Card",
    requiresFace: true,
    requiresQr: false,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "PAN_NUMBER",
      "NAME",
      "DOB",
    ],

    queries: [
      {
        Text: "What is the PAN number?",
        Alias: "PAN_NUMBER",
      },
      {
        Text: "What is the name of the PAN card holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
    ],
  },

  aadhaar: {
    displayName: "Aadhaar Card",
    requiresFace: true,
    requiresQr: true,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "AADHAAR_NUMBER",
      "NAME",
      "DOB",
    ],

    queries: [
      {
        Text: "What is the Aadhaar number?",
        Alias: "AADHAAR_NUMBER",
      },
      {
        Text: "What is the name of the Aadhaar holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth or year of birth?",
        Alias: "DOB",
      },
      {
        Text: "What is the gender?",
        Alias: "GENDER",
      },
      {
        Text: "What is the address?",
        Alias: "ADDRESS",
      },
    ],
  },

  "voter-id": {
    displayName: "Voter ID Card",
    requiresFace: true,
    requiresQr: false,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "EPIC_NUMBER",
      "NAME",
    ],

    queries: [
      {
        Text: "What is the EPIC number or voter ID number?",
        Alias: "EPIC_NUMBER",
      },
      {
        Text: "What is the name of the voter?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth or age?",
        Alias: "DOB_OR_AGE",
      },
      {
        Text: "What is the father's or husband's name?",
        Alias: "RELATION_NAME",
      },
      {
        Text: "What is the address?",
        Alias: "ADDRESS",
      },
    ],
  },

  "driving-license": {
    displayName: "Driving License",
    requiresFace: true,
    requiresQr: false,
    requiresMrz: false,
    validateExpiry: true,

    requiredFields: [
      "DL_NUMBER",
      "NAME",
      "DOB",
    ],

    queries: [
      {
        Text: "What is the driving licence number?",
        Alias: "DL_NUMBER",
      },
      {
        Text: "What is the name of the licence holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
      {
        Text: "What is the issue date?",
        Alias: "ISSUE_DATE",
      },
      {
        Text: "What is the expiry date?",
        Alias: "EXPIRY_DATE",
      },
      {
        Text: "What is the address?",
        Alias: "ADDRESS",
      },
    ],
  },

  passport: {
    displayName: "Passport",
    requiresFace: true,
    requiresQr: false,
    requiresMrz: true,
    validateExpiry: true,

    requiredFields: [
      "PASSPORT_NUMBER",
      "NAME",
      "DOB",
      "NATIONALITY",
    ],

    queries: [
      {
        Text: "What is the passport number?",
        Alias: "PASSPORT_NUMBER",
      },
      {
        Text: "What is the name of the passport holder?",
        Alias: "NAME",
      },
      {
        Text: "What is the date of birth?",
        Alias: "DOB",
      },
      {
        Text: "What is the nationality?",
        Alias: "NATIONALITY",
      },
      {
        Text: "What is the sex?",
        Alias: "SEX",
      },
      {
        Text: "What is the date of issue?",
        Alias: "ISSUE_DATE",
      },
      {
        Text: "What is the date of expiry?",
        Alias: "EXPIRY_DATE",
      },
    ],
  },

  gst: {
    displayName: "GST Registration Certificate",
    requiresFace: false,
    requiresQr: true,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "GSTIN",
      "LEGAL_NAME",
    ],

    queries: [
      {
        Text: "What is the GSTIN or Goods and Services Tax Identification Number?",
        Alias: "GSTIN",
      },
      {
        Text: "What is the legal name of the business?",
        Alias: "LEGAL_NAME",
      },
      {
        Text: "What is the trade name?",
        Alias: "TRADE_NAME",
      },
      {
        Text: "What is the constitution of business?",
        Alias: "BUSINESS_CONSTITUTION",
      },
      {
        Text: "What is the principal place of business?",
        Alias: "ADDRESS",
      },
      {
        Text: "What is the date of issue of the certificate?",
        Alias: "ISSUE_DATE",
      },
    ],
  },

  "udyam-msme": {
    displayName: "Udyam / MSME Certificate",
    requiresFace: false,
    requiresQr: true,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "UDYAM_NUMBER",
      "ENTERPRISE_NAME",
    ],

    queries: [
      {
        Text: "What is the Udyam registration number?",
        Alias: "UDYAM_NUMBER",
      },
      {
        Text: "What is the name of the enterprise?",
        Alias: "ENTERPRISE_NAME",
      },
      {
        Text: "What is the organisation type?",
        Alias: "ORGANISATION_TYPE",
      },
      {
        Text: "What is the major activity of the enterprise?",
        Alias: "MAJOR_ACTIVITY",
      },
      {
        Text: "What is the address?",
        Alias: "ADDRESS",
      },
      {
        Text: "What is the date of registration?",
        Alias: "REGISTRATION_DATE",
      },
    ],
  },

  "bank-statement-or-cheque": {
    displayName: "Bank Statement / Cheque",
    requiresFace: false,
    requiresQr: false,
    requiresMrz: false,
    validateExpiry: false,

    requiredFields: [
      "BANK_NAME",
      "ACCOUNT_HOLDER",
      "ACCOUNT_NUMBER",
    ],

    queries: [
      {
        Text: "What is the bank name?",
        Alias: "BANK_NAME",
      },
      {
        Text: "What is the account holder name?",
        Alias: "ACCOUNT_HOLDER",
      },
      {
        Text: "What is the account number?",
        Alias: "ACCOUNT_NUMBER",
      },
      {
        Text: "What is the IFSC code?",
        Alias: "IFSC",
      },
      {
        Text: "What is the branch name?",
        Alias: "BRANCH",
      },
    ],
  },
};

/*
|--------------------------------------------------------------------------
| Detect document type
|--------------------------------------------------------------------------
*/

function detectDocumentType(
  text: string,
): OwnerDocumentType {
  const normalized = normalizeText(text);

  const compact = normalized.replace(
    /[^A-Z0-9]/g,
    "",
  );

  /*
  |--------------------------------------------------------------------------
  | Aadhaar
  |--------------------------------------------------------------------------
  */

  const hasAadhaarNumber =
    /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/.test(
      normalized,
    ) ||
    /\b\d{12}\b/.test(normalized) ||
    /\b[X*]{4,8}[\s-]?\d{4}\b/.test(
      normalized,
    );

  const hasVID =
    /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/.test(
      normalized,
    ) ||
    /\b\d{16}\b/.test(normalized);

  const hasAadhaarIdentity =
    normalized.includes("AADHAAR") ||
    normalized.includes("AADHAR") ||
    normalized.includes("UIDAI") ||
    normalized.includes(
      "UNIQUE IDENTIFICATION AUTHORITY",
    ) ||
    normalized.includes("MERA AADHAAR");

  if (
    hasAadhaarIdentity ||
    (
      normalized.includes(
        "GOVERNMENT OF INDIA",
      ) &&
      hasAadhaarNumber &&
      hasVID
    )
  ) {
    return "aadhaar";
  }

  /*
  |--------------------------------------------------------------------------
  | PAN
  |--------------------------------------------------------------------------
  */

  const hasPanNumber =
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(
      normalized,
    ) ||
    /[A-Z]{5}[0-9]{4}[A-Z]/.test(
      compact,
    );

  if (
    normalized.includes(
      "INCOME TAX DEPARTMENT",
    ) ||
    normalized.includes(
      "PERMANENT ACCOUNT NUMBER",
    ) ||
    (
      normalized.includes("INCOME TAX") &&
      hasPanNumber
    )
  ) {
    return "pan";
  }

  /*
  |--------------------------------------------------------------------------
  | Voter ID
  |--------------------------------------------------------------------------
  */

  const hasEpicNumber =
    /\b[A-Z]{3}[0-9]{7}\b/.test(
      normalized,
    ) ||
    /[A-Z]{3}[0-9]{7}/.test(
      compact,
    );

  if (
    normalized.includes(
      "ELECTION COMMISSION",
    ) ||
    normalized.includes(
      "ELECTORAL PHOTO IDENTITY CARD",
    ) ||
    normalized.includes(
      "ELECTOR PHOTO IDENTITY CARD",
    ) ||
    normalized.includes("VOTER") ||
    (
      normalized.includes("ELECTOR") &&
      hasEpicNumber
    )
  ) {
    return "voter-id";
  }

  /*
  |--------------------------------------------------------------------------
  | Driving Licence
  |--------------------------------------------------------------------------
  */

  if (
    normalized.includes(
      "DRIVING LICENCE",
    ) ||
    normalized.includes(
      "DRIVING LICENSE",
    ) ||
    normalized.includes(
      "LICENCE TO DRIVE",
    ) ||
    normalized.includes(
      "LICENSE TO DRIVE",
    ) ||
    normalized.includes(
      "MOTOR VEHICLES",
    ) ||
    normalized.includes(
      "MOTOR VEHICLE",
    ) ||
    normalized.includes(
      "TRANSPORT DEPARTMENT",
    )
  ) {
    return "driving-license";
  }

  /*
  |--------------------------------------------------------------------------
  | Passport
  |--------------------------------------------------------------------------
  */

  if (
    normalized.includes("PASSPORT") ||
    normalized.includes(
      "REPUBLIC OF INDIA",
    )
  ) {
    return "passport";
  }

  /*
  |--------------------------------------------------------------------------
  | GST
  |--------------------------------------------------------------------------
  */

  if (
    normalized.includes("GSTIN") ||
    normalized.includes(
      "GOODS AND SERVICES TAX",
    ) ||
    normalized.includes(
      "GST REGISTRATION",
    ) ||
    normalized.includes(
      "FORM GST REG",
    ) ||
    (
      normalized.includes(
        "REGISTRATION CERTIFICATE",
      ) &&
      (
        normalized.includes("GST") ||
        normalized.includes("TAXPAYER")
      )
    )
  ) {
    return "gst";
  }

  /*
  |--------------------------------------------------------------------------
  | Udyam / MSME
  |--------------------------------------------------------------------------
  */

  if (
    normalized.includes("UDYAM") ||
    normalized.includes("MSME") ||
    normalized.includes(
      "UDYAM REGISTRATION",
    ) ||
    normalized.includes(
      "MINISTRY OF MICRO",
    )
  ) {
    return "udyam-msme";
  }

  /*
  |--------------------------------------------------------------------------
  | Bank
  |--------------------------------------------------------------------------
  */

  if (
    normalized.includes(
      "CANCELLED CHEQUE",
    ) ||
    normalized.includes(
      "CANCELLED CHECK",
    ) ||
    normalized.includes(
      "BANK STATEMENT",
    ) ||
    normalized.includes(
      "STATEMENT OF ACCOUNT",
    ) ||
    normalized.includes(
      "ACCOUNT STATEMENT",
    ) ||
    normalized.includes("IFSC") ||
    normalized.includes(
      "ACCOUNT NUMBER",
    ) ||
    normalized.includes(
      "ACCOUNT NO",
    )
  ) {
    return "bank-statement-or-cheque";
  }

  return "unknown";
}

/*
|--------------------------------------------------------------------------
| Get OCR text
|--------------------------------------------------------------------------
*/

function getTextractText(
  blocks: AWS.Textract.Block[] | undefined,
): string {
  return (
    blocks
      ?.filter(
        (block) => block.BlockType === "LINE",
      )
      .map((block) => block.Text || "")
      .filter(Boolean)
      .join(" ")
      .trim() || ""
  );
}

/*
|--------------------------------------------------------------------------
| Extract Textract Query Results
|--------------------------------------------------------------------------
*/

interface QueryResult {
  text: string;
  confidence: number;
}

function extractQueryResults(
  blocks: AWS.Textract.Block[] | undefined,
): Record<string, QueryResult> {
  const results: Record<
    string,
    QueryResult
  > = {};

  if (!blocks) {
    return results;
  }

  for (const queryBlock of blocks) {
    if (
      queryBlock.BlockType !== "QUERY" ||
      !queryBlock.Query?.Alias ||
      !queryBlock.Relationships
    ) {
      continue;
    }

    const answerRelationship =
      queryBlock.Relationships.find(
        (relationship) =>
          relationship.Type === "ANSWER",
      );

    if (!answerRelationship?.Ids) {
      continue;
    }

    for (const answerId of answerRelationship.Ids) {
      const answerBlock = blocks.find(
        (block) =>
          block.Id === answerId &&
          block.BlockType === "QUERY_RESULT",
      );

      if (!answerBlock) {
        continue;
      }

      results[queryBlock.Query.Alias] = {
        text: answerBlock.Text?.trim() || "",
        confidence:
          answerBlock.Confidence || 0,
      };
    }
  }

  return results;
}

/*
|--------------------------------------------------------------------------
| Normalize OCR
|--------------------------------------------------------------------------
*/

function normalizeText(
  text: string,
): string {
  return text
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/*
|--------------------------------------------------------------------------
| Check date
|--------------------------------------------------------------------------
*/

function hasDate(
  text: string,
): boolean {
  return (
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/.test(
      text,
    ) ||
    /\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/.test(
      text,
    )
  );
}

/*
|--------------------------------------------------------------------------
| Extract document number from OCR
|--------------------------------------------------------------------------
*/

function extractDocumentNumber(
  documentType: Exclude<
    OwnerDocumentType,
    "unknown"
  >,
  text: string,
): string | null {
  const normalized =
    normalizeText(text);

  switch (documentType) {
    case "pan": {
      const match =
        normalized.match(
          /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,
        );

      return match?.[0] || null;
    }

    case "aadhaar": {
      /*
      * First check formatted Aadhaar:
      * 1234 5678 9012
      */
      const formatted =
        normalized.match(
          /\b[0-9]{4}[\s-][0-9]{4}[\s-][0-9]{4}\b/,
        );

      if (formatted?.[0]) {
        return formatted[0]
          .replace(/[\s-]/g, "");
      }

      /*
      * Then check plain 12 digit Aadhaar.
      */
      const plain =
        normalized.match(
          /\b[0-9]{12}\b/,
        );

      if (plain?.[0]) {
        return plain[0];
      }

      /*
      * Then masked Aadhaar.
      */
      const masked =
        normalized.match(
          /\b[X*]{4,8}[\s-]?[0-9]{4}\b/,
        );

      return masked?.[0]
        ?.replace(/[\s-]/g, "") || null;
    }

    case "voter-id": {
      const match =
        normalized.match(
          /\b[A-Z]{3}[0-9]{7}\b/,
        );

      return match?.[0] || null;
    }

    case "driving-license": {
      const match =
        normalized.match(
          /\b[A-Z]{1,5}[- ]?[0-9]{5,20}\b/,
        );

      return match?.[0] || null;
    }

    case "passport": {
      const match =
        normalized.match(
          /\b[A-Z][0-9]{7}\b/,
        );

      return match?.[0] || null;
    }

    case "gst": {
      const match =
        normalized.match(
          /\b[0-9]{2}[A-Z0-9]{13}\b/,
        );

      return match?.[0] || null;
    }

    case "udyam-msme": {
      const match =
        normalized.match(
          /\bUDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}\b/,
        );

      return match?.[0] || null;
    }

    case "bank-statement-or-cheque": {
      const match =
        normalized.match(
          /\b[0-9]{6,30}\b/,
        );

      return match?.[0] || null;
    }

    default:
      return null;
  }
}

/*
|--------------------------------------------------------------------------
| Validate document number
|--------------------------------------------------------------------------
*/

function validateDocumentNumber(
  documentType: Exclude<
    OwnerDocumentType,
    "unknown"
  >,
  text: string,
  queryResults: Record<
    string,
    QueryResult
  >,
): boolean {
  const getValue = (
    alias: string,
  ): string =>
    queryResults[alias]?.text
      ?.replace(/\s/g, "")
      .toUpperCase() || "";

  switch (documentType) {
    /*
    |--------------------------------------------------------------------------
    | PAN
    |--------------------------------------------------------------------------
    */

    case "pan": {
      const queryPan =
        getValue("PAN_NUMBER");

      const ocrPan =
        extractDocumentNumber(
          documentType,
          text,
        );

      const pan =
        /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
          queryPan,
        )
          ? queryPan
          : ocrPan;

      // console.log(
      //   "OWNER PAN QUERY:",
      //   queryPan,
      // );

      // console.log(
      //   "OWNER PAN OCR:",
      //   ocrPan,
      // );

      // console.log(
      //   "OWNER PAN FINAL:",
      //   pan,
      // );

      return (
        !!pan &&
        /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
          pan,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Aadhaar
    |--------------------------------------------------------------------------
    */

    case "aadhaar": {
      const queryAadhaar =
        getValue("AADHAAR_NUMBER");

      const ocrAadhaar =
        extractDocumentNumber(
          documentType,
          text,
        );

      /*
      * Only use Textract Query result
      * if it is actually a valid Aadhaar format.
      *
      * Otherwise use OCR.
      */
      const queryIsValid =
        /^[0-9]{12}$/.test(
          queryAadhaar,
        ) ||
        /^[X*]{4,8}[0-9]{4}$/.test(
          queryAadhaar,
        );

      const aadhaar =
        queryIsValid
          ? queryAadhaar
          : ocrAadhaar;

      // console.log(
      //   "OWNER AADHAAR QUERY:",
      //   queryAadhaar,
      // );

      // console.log(
      //   "OWNER AADHAAR OCR:",
      //   ocrAadhaar,
      // );

      // console.log(
      //   "OWNER AADHAAR FINAL:",
      //   aadhaar,
      // );

      return (
        !!aadhaar &&
        (
          /^[0-9]{12}$/.test(
            aadhaar,
          ) ||
          /^[X*]{4,8}[0-9]{4}$/.test(
            aadhaar,
          )
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Voter ID
    |--------------------------------------------------------------------------
    */

    case "voter-id": {
      const queryEpic =
        getValue("EPIC_NUMBER");

      const ocrEpic =
        extractDocumentNumber(
          documentType,
          text,
        );

      const epic =
        /^[A-Z]{3}[0-9]{7}$/.test(
          queryEpic,
        )
          ? queryEpic
          : ocrEpic;

      // console.log(
      //   "OWNER EPIC QUERY:",
      //   queryEpic,
      // );

      // console.log(
      //   "OWNER EPIC OCR:",
      //   ocrEpic,
      // );

      // console.log(
      //   "OWNER EPIC FINAL:",
      //   epic,
      // );

      return (
        !!epic &&
        /^[A-Z]{3}[0-9]{7}$/.test(
          epic,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Driving License
    |--------------------------------------------------------------------------
    */

    case "driving-license": {
      const queryDl =
        getValue("DL_NUMBER");

      const ocrDl =
        extractDocumentNumber(
          documentType,
          text,
        );

      const dl =
        /^[A-Z0-9 -]{6,30}$/.test(
          queryDl,
        )
          ? queryDl
          : ocrDl;

      // console.log(
      //   "OWNER DL QUERY:",
      //   queryDl,
      // );

      // console.log(
      //   "OWNER DL OCR:",
      //   ocrDl,
      // );

      // console.log(
      //   "OWNER DL FINAL:",
      //   dl,
      // );

      return (
        !!dl &&
        /^[A-Z0-9 -]{6,30}$/.test(
          dl,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Passport
    |--------------------------------------------------------------------------
    */

    case "passport": {
      const queryPassport =
        getValue("PASSPORT_NUMBER");

      const ocrPassport =
        extractDocumentNumber(
          documentType,
          text,
        );

      const passport =
        /^[A-Z][0-9]{7}$/.test(
          queryPassport,
        )
          ? queryPassport
          : ocrPassport;

      // console.log(
      //   "OWNER PASSPORT QUERY:",
      //   queryPassport,
      // );

      // console.log(
      //   "OWNER PASSPORT OCR:",
      //   ocrPassport,
      // );

      // console.log(
      //   "OWNER PASSPORT FINAL:",
      //   passport,
      // );

      return (
        !!passport &&
        /^[A-Z][0-9]{7}$/.test(
          passport,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | GST
    |--------------------------------------------------------------------------
    */

    case "gst": {
      const queryGstin =
        getValue("GSTIN");

      const ocrGstin =
        extractDocumentNumber(
          documentType,
          text,
        );

      const gstin =
        /^[0-9]{2}[A-Z0-9]{13}$/.test(
          queryGstin,
        )
          ? queryGstin
          : ocrGstin;

      // console.log(
      //   "OWNER GST QUERY:",
      //   queryGstin,
      // );

      // console.log(
      //   "OWNER GST OCR:",
      //   ocrGstin,
      // );

      // console.log(
      //   "OWNER GST FINAL:",
      //   gstin,
      // );

      return (
        !!gstin &&
        /^[0-9]{2}[A-Z0-9]{13}$/.test(
          gstin,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Udyam
    |--------------------------------------------------------------------------
    */

    case "udyam-msme": {
      const queryUdyam =
        getValue("UDYAM_NUMBER");

      const ocrUdyam =
        extractDocumentNumber(
          documentType,
          text,
        );

      const udyam =
        /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(
          queryUdyam,
        )
          ? queryUdyam
          : ocrUdyam;

      // console.log(
      //   "OWNER UDYAM QUERY:",
      //   queryUdyam,
      // );

      // console.log(
      //   "OWNER UDYAM OCR:",
      //   ocrUdyam,
      // );

      // console.log(
      //   "OWNER UDYAM FINAL:",
      //   udyam,
      // );

      return (
        !!udyam &&
        /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(
          udyam,
        )
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Bank
    |--------------------------------------------------------------------------
    */

    case "bank-statement-or-cheque": {
      const queryAccount =
        getValue("ACCOUNT_NUMBER");

      const ocrAccount =
        extractDocumentNumber(
          documentType,
          text,
        );

      const account =
        /^[0-9A-Z-]{6,30}$/.test(
          queryAccount,
        )
          ? queryAccount
          : ocrAccount;

      // console.log(
      //   "OWNER ACCOUNT QUERY:",
      //   queryAccount,
      // );

      // console.log(
      //   "OWNER ACCOUNT OCR:",
      //   ocrAccount,
      // );

      // console.log(
      //   "OWNER ACCOUNT FINAL:",
      //   account,
      // );

      return (
        !!account &&
        /^[0-9A-Z-]{6,30}$/.test(
          account,
        )
      );
    }

    default:
      return false;
  }
}

/*
|--------------------------------------------------------------------------
| Detect human face
|--------------------------------------------------------------------------
*/

async function hasHumanFace(
  buffer: Buffer,
): Promise<boolean> {
  try {
    // console.log(
    //   "OWNER REKOGNITION IMAGE SIZE:",
    //   buffer.length,
    // );

    const response =
      await rekognition
        .detectFaces({
          Image: {
            Bytes: buffer,
          },
          Attributes: ["DEFAULT"],
        })
        .promise();

    const faces =
      response.FaceDetails || [];

    // console.log(
    //   "OWNER REKOGNITION FACE COUNT:",
    //   faces.length,
    // );

    if (faces.length === 0) {
      return false;
    }

    const hasValidFace =
      faces.some(
        (face) =>
          (face.Confidence || 0) >= 80,
      );

    // console.log(
    //   "OWNER REKOGNITION FACE VALID:",
    //   hasValidFace,
    // );

    return hasValidFace;
  } catch (error) {
    console.error(
      "Rekognition face detection failed:",
      error,
    );

    /*
    * Do not reject a document only because
    * Rekognition/AWS failed.
    */
    return true;
  }
}

/*
|--------------------------------------------------------------------------
| Validate content using OCR
|--------------------------------------------------------------------------
*/

function validateOcrContent(
  documentType: Exclude<
    OwnerDocumentType,
    "unknown"
  >,
  text: string,
): boolean {
  const t = normalizeText(text);

  switch (documentType) {
    case "aadhaar":
      return (
        t.includes("AADHAAR") ||
        t.includes("UIDAI") ||
        t.includes("GOVERNMENT OF INDIA")
      );

    case "pan":
      return (
        t.includes("INCOME TAX") ||
        t.includes(
          "PERMANENT ACCOUNT NUMBER",
        )
      );

    case "voter-id":
      return (
        t.includes(
          "ELECTION COMMISSION",
        ) ||
        t.includes(
          "ELECTOR PHOTO IDENTITY CARD",
        ) ||
        t.includes("ELECTOR") ||
        t.includes("EPIC")
      );

    case "driving-license":
      return (
        t.includes("DRIVING LICENCE") ||
        t.includes("DRIVING LICENSE") ||
        t.includes("LICENCE TO DRIVE") ||
        t.includes("TRANSPORT") ||
        t.includes("MOTOR VEHICLES")
      );

    case "passport":
      return (
        t.includes("PASSPORT") ||
        t.includes("REPUBLIC OF INDIA")
      );

    case "gst":
      return (
        t.includes("GSTIN") ||
        t.includes(
          "GOODS AND SERVICES TAX",
        ) ||
        t.includes("GST REG") ||
        t.includes(
          "REGISTRATION CERTIFICATE",
        )
      );

    case "udyam-msme":
      return (
        t.includes("UDYAM") ||
        t.includes("MSME") ||
        t.includes("MINISTRY OF MICRO")
      );

    case "bank-statement-or-cheque":
      return (
        t.includes("BANK") ||
        t.includes("IFSC") ||
        t.includes(
          "ACCOUNT NUMBER",
        ) ||
        t.includes("ACCOUNT NO") ||
        t.includes(
          "BANK STATEMENT",
        ) ||
        t.includes(
          "CANCELLED CHEQUE",
        ) ||
        t.includes(
          "CANCELLED CHECK",
        )
      );

    default:
      return false;
  }
}

/*
|--------------------------------------------------------------------------
| Analyze IMAGE
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| Fast OCR Image Analysis & Validation
|--------------------------------------------------------------------------
*/

async function validateImageDocument(
  buffer: Buffer,
): Promise<OwnerDocumentValidationResult> {
  // 1. Run DetectDocumentText and Face Detection concurrently in parallel
  const [detectResponse, faceExists] = await Promise.all([
    textract
      .detectDocumentText({
        Document: {
          Bytes: buffer,
        },
      })
      .promise(),
    hasHumanFace(buffer).catch((err) => {
      console.error("Owner face detection error:", err);
      return false;
    }),
  ]);

  const text = getTextractText(detectResponse.Blocks);
  const documentType = detectDocumentType(text);

  if (documentType === "unknown") {
    console.log("OWNER VALIDATION FAILED: UNKNOWN DOCUMENT");
    return {
      valid: false,
      documentType: "unknown",
      displayName: "Unknown Document",
    };
  }

  const config = DOCUMENT_CONFIG[documentType];

  // 2. Validate OCR identity content
  const contentValid = validateOcrContent(documentType, text);
  console.log("OWNER STEP 1 - OCR CONTENT:", contentValid);
  if (!contentValid) {
    console.log("OWNER VALIDATION FAILED: OCR CONTENT");
    return {
      valid: false,
      documentType,
      displayName: `${config.displayName} - Document details could not be verified`,
    };
  }

  // 3. Validate document number from direct OCR text
  let queryResults: Record<string, QueryResult> = {};
  let numberValid = validateDocumentNumber(documentType, text, queryResults);

  // 4. Validate date of birth from direct OCR text if required
  const requiresDob =
    documentType === "aadhaar" ||
    documentType === "pan" ||
    documentType === "passport" ||
    documentType === "driving-license";

  let dateExists = requiresDob ? hasDate(text) : true;

  // 5. If direct OCR text couldn't extract number or date, run fallback AnalyzeDocument queries
  if ((!numberValid || (requiresDob && !dateExists)) && config.queries && config.queries.length > 0) {
    try {
      console.log("OWNER FALLBACK: Running Textract AnalyzeDocument queries...");
      const analyzeResponse = await textract
        .analyzeDocument({
          Document: {
            Bytes: buffer,
          },
          FeatureTypes: ["QUERIES"],
          QueriesConfig: {
            Queries: config.queries,
          },
        })
        .promise();

      queryResults = extractQueryResults(analyzeResponse.Blocks);

      if (!numberValid) {
        numberValid = validateDocumentNumber(documentType, text, queryResults);
      }
      if (requiresDob && !dateExists) {
        dateExists = hasDate(text) || !!queryResults.DOB?.text;
      }
    } catch (fallbackError) {
      console.error("Textract fallback queries error:", fallbackError);
    }
  }

  console.log("OWNER STEP 2 - DOCUMENT NUMBER:", numberValid);
  if (!numberValid) {
    console.log("OWNER VALIDATION FAILED: DOCUMENT NUMBER");
    return {
      valid: false,
      documentType,
      displayName: `${config.displayName} - Invalid or missing document number`,
    };
  }

  if (requiresDob) {
    console.log("OWNER STEP 3 - DOB:", dateExists);
    if (!dateExists) {
      console.log("OWNER VALIDATION FAILED: DOB");
      return {
        valid: false,
        documentType,
        displayName: `${config.displayName} - Date of birth is missing`,
      };
    }
  }

  // 6. Photo verification
  if (config.requiresFace) {
    console.log("OWNER STEP 4 - CHECKING FACE RESULT:", faceExists);
    if (!faceExists) {
      console.log("OWNER VALIDATION FAILED: FACE");
      return {
        valid: false,
        documentType,
        displayName: `${config.displayName} - Photo is missing or not visible`,
      };
    }
  }

  console.log("OWNER DOCUMENT VALIDATION: SUCCESS");
  return {
    valid: true,
    documentType,
    displayName: config.displayName,
  };
}

/*
|--------------------------------------------------------------------------
| PDF VALIDATION
|--------------------------------------------------------------------------
*/

async function validatePdfDocument(
  buffer: Buffer,
): Promise<OwnerDocumentValidationResult> {
  const parser =
    new PDFParse({
      data: buffer,
    });

  try {
    /*
    |--------------------------------------------------------------------------
    | Extract PDF text
    |--------------------------------------------------------------------------
    */

    const parsed =
      await parser.getText();

    const text =
      parsed?.text || "";

    console.log(
      "OWNER PDF TEXT:",
      text,
    );

    const documentType =
      detectDocumentType(text);

    console.log(
      "OWNER PDF DOCUMENT TYPE:",
      documentType,
    );

    if (
      documentType === "unknown"
    ) {
      return {
        valid: false,
        documentType: "unknown",
        displayName:
          "Unknown Document",
      };
    }

    const config =
      DOCUMENT_CONFIG[documentType];

    /*
    |--------------------------------------------------------------------------
    | OCR/content validation
    |--------------------------------------------------------------------------
    */

    const contentValid =
      validateOcrContent(
        documentType,
        text,
      );

    console.log(
      "OWNER PDF STEP 1 - OCR CONTENT:",
      contentValid,
    );

    if (!contentValid) {
      return {
        valid: false,
        documentType,
        displayName:
          `${config.displayName} - Document details could not be verified`,
      };
    }

    /*
    |--------------------------------------------------------------------------
    | Document number
    |--------------------------------------------------------------------------
    */

    const numberValid =
      validateDocumentNumber(
        documentType,
        text,
        {},
      );

    console.log(
      "OWNER PDF STEP 2 - DOCUMENT NUMBER:",
      numberValid,
    );

    if (!numberValid) {
      return {
        valid: false,
        documentType,
        displayName:
          `${config.displayName} - Invalid or missing document number`,
      };
    }

    /*
    |--------------------------------------------------------------------------
    | PDF page images
    |--------------------------------------------------------------------------
    */

    let faceFound =
      !config.requiresFace;

    try {
      const imageResult =
        await parser.getImage({
          imageBuffer: true,
        });

      for (
        const page of
          imageResult.pages || []
      ) {
        for (
          const img of
            page.images || []
        ) {
          if (
            !img.data ||
            img.data.length === 0
          ) {
            continue;
          }

          const imgBuffer =
            Buffer.from(img.data);

          if (
            config.requiresFace
          ) {
            const found =
              await hasHumanFace(
                imgBuffer,
              );

            if (found) {
              faceFound = true;
              break;
            }
          }
        }

        if (faceFound) {
          break;
        }
      }
    } catch (imageError) {
      console.error(
        "PDF image extraction failed:",
        imageError,
      );

      /*
      * If Rekognition/image extraction itself
      * fails, don't treat the document as invalid
      * solely because of the service failure.
      */
      if (config.requiresFace) {
        faceFound = true;
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Photo-required document
    |--------------------------------------------------------------------------
    */

    if (
      config.requiresFace &&
      !faceFound
    ) {
      return {
        valid: false,
        documentType,
        displayName:
          `${config.displayName} - Photo could not be verified`,
      };
    }

    /*
    |--------------------------------------------------------------------------
    | QR / MRZ
    |--------------------------------------------------------------------------
    */

    if (config.requiresQr) {
      console.log(
        `${documentType}: QR verification can be added separately.`,
      );
    }

    if (config.requiresMrz) {
      console.log(
        "Passport MRZ verification can be added separately.",
      );
    }

    return {
      valid: true,
      documentType,
      displayName:
        config.displayName,
    };
  } finally {
    try {
      await parser.destroy();
    } catch (_) {}
  }
}

/*
|--------------------------------------------------------------------------
| MAIN EXPORT
|--------------------------------------------------------------------------
*/

export const validateOwnerGovernmentDocument =
  async (
    buffer: Buffer,
  ): Promise<OwnerDocumentValidationResult> => {
    try {
      const isPdf =
        buffer
          .subarray(0, 4)
          .toString() === "%PDF";

      /*
      |--------------------------------------------------------------------------
      | IMAGE
      |--------------------------------------------------------------------------
      */

      if (!isPdf) {
        return validateImageDocument(
          buffer,
        );
      }

      /*
      |--------------------------------------------------------------------------
      | PDF
      |--------------------------------------------------------------------------
      */

      return validatePdfDocument(
        buffer,
      );
    } catch (error) {
      console.error(
        "Owner government document validation error:",
        error,
      );

      return {
        valid: false,
        documentType: "unknown",
        displayName:
          "Unable to validate government document",
      };
    }
  };