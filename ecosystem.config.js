module.exports = {
  apps: [{
    name: 'aria-bot',
    script: 'agent.js',
    cwd: __dirname,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 3000,
    exp_backoff_restart_delay: 5000,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    time: true,
  }]
};
