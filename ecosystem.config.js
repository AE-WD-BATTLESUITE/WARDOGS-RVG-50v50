/*
 * pm2 config.  pm2 start ecosystem.config.js
 *
 * keep this next to index.js. cwd is set on purpose so ./state lands in the app
 * folder and not wherever you happened to be standing when you typed the command.
 *
 * instances stays at 1 forever. two of these running at once will fight over the
 * same players and pinball them between sides all night. if you want to balance
 * more servers, add them to the servers array, dont start a second copy.
 *
 * SIXFIVE
 */
module.exports = {
  apps: [
    {
      name: 'wd-balancer',
      script: './index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '200M',
      time: true,
    },
  ],
};
