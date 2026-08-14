import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

const homeDirectory = homedir();

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    binaries: {
      chrome: join(
        homeDirectory,
        'Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    },
    chromiumProfile: join(
      homeDirectory,
      'Library/Application Support/bok-test-chrome',
    ),
    keepProfileChanges: true,
  },
  manifest: {
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
    optional_permissions: ['bookmarks'],
    action: {
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
      default_title: '保存并关闭全部标签',
    },
  },
});
