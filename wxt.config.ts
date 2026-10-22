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
    },
  },
});
