import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  qxUrl: process.env.QX_URL || 'https://quotex.com/en/trade',
  userDataDir: path.resolve(process.cwd(), process.env.USER_DATA_DIR || './qx_user_profile'),
  chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: process.env.HEADLESS === 'true',
  minPayoutPercent: process.env.MIN_PAYOUT_PERCENT ? Number(process.env.MIN_PAYOUT_PERCENT) : 80,
  remoteDebugPort: process.env.CHROME_REMOTE_DEBUG ? Number(process.env.CHROME_REMOTE_DEBUG) : null,
};
