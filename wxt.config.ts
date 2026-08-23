import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

const homeDirectory = homedir();
const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };
const isReleaseBuild = process.env.BOK_RELEASE_BUILD === '1';
const gitPath = new URL('./.git', import.meta.url);
const isLinkedWorktree = existsSync(gitPath) && lstatSync(gitPath).isFile();

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: isReleaseBuild ? '.output/.release-staging' : '.output',
  outDirTemplate: `bok-${packageVersion}-{{browser}}{{modeSuffix}}`,
  zip: {
    name: 'bok',
    artifactTemplate: '{{name}}-{{browser}}-{{version}}.zip',
  },
  webExt: {
    binaries: {
      chrome: join(
        homeDirectory,
        'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    },
    ...(isLinkedWorktree
      ? {}
      : {
          chromiumProfile: join(
            homeDirectory,
            'Library/Application Support/bok-test-chrome',
          ),
          keepProfileChanges: true,
        }),
  },
  manifest: {
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArPSgZwVRcGdc8nhNKX3KPMm8w56qm5zhkv26q1HodXZ9J+VuE7kyzRYovZTHkHZGUTMfL6P50u9jQThMfkM10Shcnja2IeVVFERRT7y9JC+drJCkKADQ5MTIHr6bgTl78NJTPUeHNC+J7M/mpIjf50mG4hsKkisKiLBXEcvwI10Zm9V0R4gGSrMzkaIjoeYYUGCcS9tWV0Iix6z1Y0Y+xyamLQLP8v311y6YMDw2KIxSPgMiywnZt2+aSlzoy9fMgiRxX39m+h3tA/ZdAvjHM9RvmQT3SuskuQwQ3YLGSAH9lsvLk01y3xe22Wn5xoZ4qEZDh+V3XINy8h2VGalsNQIDAQAB',
    name: 'Bok',
    description: 'Save and close the current window tabs in one click.',
    permissions: [
      'tabs',
      'tabGroups',
      'storage',
      'unlimitedStorage',
      'favicon',
      'alarms',
      'contextMenus',
    ],
    optional_permissions: ['bookmarks', 'nativeMessaging'],
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
      default_title: '保存并关闭全部标签',
    },
  },
});
