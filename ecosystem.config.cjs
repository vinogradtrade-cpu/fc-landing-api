module.exports = {
  apps: [
    {
      name: 'fc-landing-api',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        PORT: '3022',
      },
    },
  ],
};
