module.exports = {
  apps: [
    {
      name: 'ia-server-dev',
      script: 'yarn',
      args: 'dev',
      interpreter: '/root/.nvm/versions/node/v22.22.0/bin/node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/pm2-dev-error.log',
      out_file: './logs/pm2-dev-out.log',
      // watch: false porque ts-node-dev ya hace su propio --respawn sobre
      // cambios en src/. Dejarlo en true duplicaría los reinicios.
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      kill_timeout: 5000,
    },
  ],
};
