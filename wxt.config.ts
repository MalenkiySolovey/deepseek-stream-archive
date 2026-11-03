import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: {
    name: 'DeepSeek StreamArchive',
    description: 'Local-first response archiver, revision recorder, and recovery layer for DeepSeek.',
    version: '0.1.0',
    permissions: ['storage', 'sidePanel'],
    host_permissions: ['https://chat.deepseek.com/*'],
    action: {
      default_title: 'DeepSeek StreamArchive',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
});
