/* global module, __dirname, process */

module.exports = {
  apps: [
    {
      name: 'clash-sentinel',
      cwd: __dirname,
      script: 'apps/server/dist/index.js',
      interpreter: process.execPath,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_restarts: 5,
      kill_timeout: 360_000,
      env: {
        NODE_ENV: 'production',
        CLASH_SENTINEL_PORT: '4020',
      },
    },
  ],
};
