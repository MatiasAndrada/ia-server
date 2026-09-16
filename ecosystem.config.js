module.exports = {
  apps: [
    {
      name: 'ia-server',
      script: 'yarn',
      args: 'start',
      interpreter: '/root/.nvm/versions/node/v22.22.0/bin/node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      // Sin `log_date_format` a propósito: el proceso ya emite JSON con su
      // propio `timestamp`, y el prefijo de PM2 rompía el parseo con jq.
      // Cada línea de pm2-out.log es ahora un JSON válido.
      //
      // La rotación la aporta el módulo pm2-logrotate, que NO se configura
      // desde este archivo (ver README / deploy.sh):
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 20M
      //   pm2 set pm2-logrotate:retain 14
      //   pm2 set pm2-logrotate:compress true
      //   pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
      merge_logs: true,
      autorestart: true,
      // 10 dejó el proceso caído 18hs el 2026-09-15 (agotó los reintentos
      // por un crash-loop y nadie lo notó hasta reiniciarlo a mano). Subido
      // a 30 como red de seguridad además del fix del rmSync sin try/catch
      // que causaba el crash.
      max_restarts: 30,
      min_uptime: '10s',
      restart_delay: 4000,
      kill_timeout: 5000,
    },
  ],
};
