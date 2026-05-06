import path from 'path';
import { getRepoRoot } from './persistence.mjs';

/** Path relative to repo root for the twilight-bot git submodule. */
export const TWILIGHT_BOT_SUBMODULE_REL = 'external/twilight-bot';

export function getDefaultTwilightBotRepoDir() {
  return path.join(getRepoRoot(), TWILIGHT_BOT_SUBMODULE_REL);
}
