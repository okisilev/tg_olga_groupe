npm install telegraf sqlite3 axios dotenv node-cron

npm install -g pm2
pm2 start index.js --name "tg-bot-olga"
pm2 save
pm2 startup systemd
!