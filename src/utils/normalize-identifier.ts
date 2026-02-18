export const normalizeIdentifier = (identifier: string) => {
  if (!identifier) return identifier;

  identifier = identifier.trim();

  // email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return identifier.toLowerCase();
  }

  // phone
  const digits = identifier.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91"))
    return `+${digits}`;

  return identifier;
};
