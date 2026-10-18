import { defineConfig } from '@playwright/test';
// Foldy fixtures own isolated HTTPS runtimes; no factory daemon/web server.
export default defineConfig({
 testDir:'../../ui', testMatch:'foldy-*.test.ts', workers:1, timeout:60000, retries:0,
 outputDir:'../../../.tmp/foldy-browser', reporter:[['list'],['json',{outputFile:'../../../.tmp/foldy-browser-results.json'}]],
 use:{ignoreHTTPSErrors:true, screenshot:'off', video:'off', trace:'off', launchOptions:process.env.FOLDY_CHROMIUM_EXECUTABLE?{executablePath:process.env.FOLDY_CHROMIUM_EXECUTABLE}:{}},
});
