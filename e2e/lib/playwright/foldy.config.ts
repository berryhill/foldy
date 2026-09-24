import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.js';
// Standalone runtime has no OpenDesign daemon/web dependency.
export default defineConfig({ ...base, testDir: '../../ui', testMatch: ['foldy-owner.test.ts', 'foldy-oauth.test.ts', 'foldy-golden-path.test.ts'], webServer: [], retries: 0,
 outputDir: '../../ui/reports/foldy-owner', reporter: [['list']],
 use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' } });
