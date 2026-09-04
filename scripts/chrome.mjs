/**
 * Which Chromium the headless checks run in.
 *
 * Every test and every visual script used to name a path outright — the one
 * that happened to exist in the container this was written in. So `npm test`
 * failed on its first line anywhere else: on the machine of the person this
 * project is for, and in CI, which is why there was no CI.
 *
 * Playwright installs a browser and knows where it put it. Asked for nothing,
 * it uses that. CHROME_BIN still wins, for pointing at a particular build.
 */
export const chromeBin = () => process.env.CHROME_BIN || undefined;
