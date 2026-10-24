export const PRODUCT_HUNT_URL = 'https://www.producthunt.com/products/scoop-md';
export const GITHUB_URL = 'https://github.com/sccop-md/scoop.md';

// The live listing. PUBLIC_CHROME_STORE_URL (build time) overrides it.
export const CHROME_STORE_URL: string | undefined =
  import.meta.env.PUBLIC_CHROME_STORE_URL || 'https://chromewebstore.google.com/detail/ccfbndgiomnmpanklpmadpapkocihfpd';

// Placeholders the owner still has to fill in (see README.md).
export const CONTACT_EMAIL = 'privacy@scoop.md';
export const LEGAL_ENTITY = '[LEGAL ENTITY]';

// Where deletion requests for usage statistics go (by install ID).
export const DELETION_EMAIL = 'team@ddamoah.com';
