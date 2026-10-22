// Popup timing: the loader shows for at least loaderMs so it never flickers,
// then the "copied" moment plays for celebrateMs (reducedMs with
// prefers-reduced-motion) before the content is revealed. The copy itself
// never waits for any of it. Tests shorten these.
export const timing = {
  loaderMs: 600,
  celebrateMs: 900,
  reducedMs: 450,
  // Retries of the page's package right after a crawl completes.
  packageRetryMs: [1_500, 3_000, 6_000],
  packageRetryTimeoutMs: 4_000,
  // While the popup is open, how often the background crawl is checked.
  followMs: 5_000,
  searchDebounceMs: 300,
  // How long the Copy button says "Copied".
  copiedLabelMs: 2_000,
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

// The popup's stages in order, with times: what tests check the sequence against.
export const stageLog = [];
export function logStage(name, at = Date.now()) {
  stageLog.push({ name, at });
  if (stageLog.length > 200) stageLog.shift();
}
