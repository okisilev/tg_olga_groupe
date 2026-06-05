require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cron = require('node-cron');

// --- КОНФИГУРАЦИЯ ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const GROUP_ID = process.env.GROUP_ID;
const DB_PATH = process.env.DB_PATH || './bot.db';
const SUBSCRIPTION_PRICE = 100; // Цена в рублях
const CHECK_INTERVAL_MS = 10000; // Проверка оплат каждые 10 секунд

// Авторизация для API ЮKassa
const YK_AUTH = Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64');
const YK_HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${YK_AUTH}`,
    'Idempotence-Key': '' 
};

// --- ИНИЦИАЛИЗАЦИЯ БОТА И БД ---
const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB Connection Error:', err.message);
    else console.log('Connected to SQLite database.');
});

// Создание таблиц
db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        status TEXT DEFAULT 'inactive', -- active, inactive
        subscription_end DATETIME
    )`);

    // Таблица платежей
    db.run(`CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        telegram_id INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    )`);

    // Таблица выданных ссылок (для контроля)
    db.run(`CREATE TABLE IF NOT EXISTS invite_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER,
        link TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used BOOLEAN DEFAULT 0,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    )`);
});

// --- ФУНКЦИИ ПОМОЩНИКИ ---

const getOrCreateUser = (ctx) => {
    return new Promise((resolve, reject) => {
        const userId = ctx.from.id;
        const username = ctx.from.username || '';
        
        db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, row) => {
            if (err) return reject(err);
            if (row) return resolve(row);
            
            db.run('INSERT INTO users (telegram_id, username, status) VALUES (?, ?, ?)', 
                [userId, username, 'inactive'], function(err) {
                    if (err) return reject(err);
                    resolve({ telegram_id: userId, username, status: 'inactive' });
                });
        });
    });
};

const updatePaymentStatus = (paymentId, status) => {
    return new Promise((resolve, reject) => {
        db.run('UPDATE payments SET status = ? WHERE payment_id = ?', [status, paymentId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

const activateSubscription = (userId, months = 1) => {
    return new Promise((resolve, reject) => {
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + months);
        const isoEnd = endDate.toISOString();

        db.run('UPDATE users SET status = ?, subscription_end = ? WHERE telegram_id = ?', 
            ['active', isoEnd, userId], (err) => {
                if (err) reject(err);
                else resolve(isoEnd);
            });
    });
};

const createYooPayment = async (userId, amount) => {
    const idempotenceKey = `${userId}_${Date.now()}`;
    const url = 'https://api.yookassa.ru/v3/payments';
    
    const payload = {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: `https://t.me/${bot.botInfo.username}` },
        capture: true,
        description: `Подписка для user ${userId}`,
        metadata: { user_id: userId }
    };

    try {
        const res = await axios.post(url, payload, { 
            headers: { ...YK_HEADERS, 'Idempotence-Key': idempotenceKey } 
        });
        return res.data;
    } catch (e) {
        console.error('YooCreate Error:', e.response?.data || e.message);
        throw e;
    }
};

const checkYooPayment = async (paymentId) => {
    const url = `https://api.yookassa.ru/v3/payments/${paymentId}`;
    try {
        const res = await axios.get(url, { headers: YK_HEADERS });
        return res.data.status; 
    } catch (e) {
        console.error(`YooCheck Error for ${paymentId}:`, e.message);
        return null;
    }
};

// Прямой вызов API Telegram
const callTelegramAPI = async (method, params) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    try {
        const res = await axios.post(url, params);
        return res.data;
    } catch (e) {
        console.error(`Telegram API Error (${method}):`, e.response?.data || e.message);
        throw e;
    }
};

// Генерация ссылки-приглашения (24 часа, 1 использование)
const generateInviteLink = async (userId) => {
    try {
        // Время истечения: текущее время + 24 часа (в секундах)
        const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);

        console.log(`Generating invite link for user ${userId}...`);

        const response = await callTelegramAPI('exportChatInviteLink', {
            chat_id: GROUP_ID,
            expire_date: expireDate,
            member_limit: 1, // Одноразовая
            name: `Invite for ${userId}`
        });

        // Axios возвращает данные в response.data
        // Telegram API возвращает { ok: true, result: "ссылка" }
        if (response && response.ok && response.result) {
            const link = response.result;
            console.log(`✅ Invite link generated: ${link}`);
            
            // Сохраняем ссылку в БД
            await new Promise((resolve, reject) => {
                db.run('INSERT INTO invite_links (telegram_id, link) VALUES (?, ?)', 
                    [userId, link], (err) => {
                        if (err) {
                            console.error(`DB Error saving link: ${err.message}`);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });
            
            return link;
        } else {
            console.error(` Failed to generate link. Response:`, JSON.stringify(response));
            return null;
        }
    } catch (e) {
        console.error('❌ GenerateLink Critical Error:', e.message);
        if (e.response) {
            console.error('API Error Details:', e.response.data);
        }
        return null;
    }
};

// Бан пользователя в группе
const banUserInGroup = async (userId) => {
    try {
        await callTelegramAPI('banChatMember', {
            chat_id: GROUP_ID,
            user_id: userId
        });
        return true;
    } catch (e) {
        const errorMsg = e.response?.data?.description || e.message;
        if (errorMsg.includes('USER_NOT_PARTICIPANT') || errorMsg.includes('user not found')) {
            return true; 
        }
        console.error(`BanUser Error for ${userId}:`, errorMsg);
        return false;
    }
};

// --- ОБРАБОТЧИКИ КОМАНД ---

bot.start(async (ctx) => {
    await getOrCreateUser(ctx);
    const payload = ctx.startPayload;

    if (payload === 'pay') {
        try {
            const userId = ctx.from.id;
            const payment = await createYooPayment(userId, SUBSCRIPTION_PRICE);
            
            await new Promise((resolve, reject) => {
                db.run('INSERT OR REPLACE INTO payments (payment_id, telegram_id, amount, status) VALUES (?, ?, ?, ?)',
                    [payment.id, userId, SUBSCRIPTION_PRICE, 'pending'], (err) => {
                        if (err) reject(err); else resolve();
                    });
            });

            ctx.reply(
                `✅ Платеж на сумму ${SUBSCRIPTION_PRICE} руб. создан.\nНажмите кнопку ниже для перехода в ЮKassa:`,
                Markup.inlineKeyboard([
                    Markup.button.url('💳 Оплатить в ЮKassa', payment.confirmation.confirmation_url)
                ])
            );
        } catch (e) {
            console.error(e);
            ctx.reply('❌ Не удалось создать платеж. Попробуйте позже.');
        }
    } else {
        ctx.reply(
            `Привет! 👋\nЯ бот для управления доступом в закрытую группу.\n\nЧтобы получить доступ, необходимо оплатить подписку.`,
            Markup.inlineKeyboard([
                Markup.button.url('💳 Получить ссылку на оплату', `https://t.me/${bot.botInfo.username}?start=pay`)
            ])
        );
    }
});

bot.command('pay', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const payment = await createYooPayment(userId, SUBSCRIPTION_PRICE);
        
        await new Promise((resolve, reject) => {
            db.run('INSERT OR REPLACE INTO payments (payment_id, telegram_id, amount, status) VALUES (?, ?, ?, ?)',
                [payment.id, userId, SUBSCRIPTION_PRICE, 'pending'], (err) => {
                    if (err) reject(err); else resolve();
                });
        });

        ctx.reply(
            `✅ Платеж создан. Нажмите для оплаты:`,
            Markup.inlineKeyboard([
                Markup.button.url('💳 Оплатить', payment.confirmation.confirmation_url)
            ])
        );
    } catch (e) {
        ctx.reply('❌ Ошибка создания платежа.');
    }
});

bot.command('status', async (ctx) => {
    const userId = ctx.from.id;
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err || !user) return ctx.reply('Вы еще не зарегистрированы. Нажмите /start');
        
        if (user.status === 'active') {
            ctx.reply(`✅ Ваша подписка активна до: ${new Date(user.subscription_end).toLocaleDateString('ru-RU')}`);
        } else {
            ctx.reply('❌ Подписка неактивна. Используйте /pay для оплаты.');
        }
    });
});

// --- ОБРАБОТКА ВХОДА В ГРУППУ ---

bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    
    for (const member of newMembers) {
        if (member.is_bot) continue; // Игнорируем других ботов

        const userId = member.id;
        console.log(`New member joined: ${userId}`);

        // Проверяем статус пользователя в БД
        db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
            if (err) return;

            // Если пользователя нет в БД или он не активен
            if (!user || user.status !== 'active') {
                console.log(`User ${userId} has no active subscription. Kicking...`);
                
                // Баним пользователя
                await banUserInGroup(userId);
                
                // Отправляем ему в ЛС сообщение (если он писал боту ранее, иначе не дойдет)
                // Чтобы гарантировать доставку, можно попросить его написать /start
                bot.telegram.sendMessage(userId, 
                    `⚠️ У вас нет активной подписки или она истекла.\nВы были автоматически удалены из группы.\n\nДля доступа оплатите подписку:`,
                    Markup.inlineKeyboard([
                        Markup.button.url(' Оплатить доступ', `https://t.me/${bot.botInfo.username}?start=pay`)
                    ])
                ).catch(() => {}); // Игнорируем ошибку, если юзер заблокировал бота
            } else {
                console.log(`User ${userId} has active subscription. Welcome!`);
                // Можно отправить приветственное сообщение, если нужно
            }
        });
    }
});

// Временная команда для админа: создать ссылку для конкретного юзера
bot.command('genlink', async (ctx) => {
    // Проверка, что это ты (твой ID 431292182)
    if (ctx.from.id !== 431292182) {
        return ctx.reply('❌ Эта команда доступна только администратору.');
    }

    const args = ctx.message.text.split(' ');
    if (!args[1]) {
        return ctx.reply('Использование: /genlink USER_ID\nПример: /genlink 5807635774');
    }

    const userId = parseInt(args[1]);
    
    try {
        const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
        
        const response = await callTelegramAPI('exportChatInviteLink', {
            chat_id: GROUP_ID,
            expire_date: expireDate,
            member_limit: 1,
            name: `Admin Test Link for ${userId}`
        });

        if (response.ok && response.result) {
            const link = response.result;
            
            // Сохраняем в БД, чтобы отслеживать
            db.run('INSERT INTO invite_links (telegram_id, link) VALUES (?, ?)', [userId, link]);
            
            ctx.reply(`✅ Ссылка для пользователя ${userId} создана:\n${link}\n\n(Отправьте эту ссылку пользователю или перейдите сами с его аккаунта)`);
            
            // Также отправим ссылку самому пользователю, если он писал боту
            bot.telegram.sendMessage(userId, `🔗 Тестовая ссылка для входа: ${link}`, Markup.inlineKeyboard([Markup.button.url('Войти', link)])).catch(() => {});
        } else {
            ctx.reply('❌ Не удалось создать ссылку.');
        }
    } catch (e) {
        console.error(e);
        ctx.reply(`❌ Ошибка: ${e.message}`);
    }
});

// --- ФОНОВЫЕ ПРОЦЕССЫ ---

// 1. Polling платежей
setInterval(async () => {
    db.all('SELECT * FROM payments WHERE status = ?', ['pending'], async (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        for (const payment of rows) {
            const status = await checkYooPayment(payment.payment_id);
            
            if (status === 'succeeded') {
                console.log(`Payment ${payment.payment_id} succeeded for user ${payment.telegram_id}`);
                
                await updatePaymentStatus(payment.payment_id, 'succeeded');
                await activateSubscription(payment.telegram_id);
                
                // Генерируем ссылку-приглашение
                const inviteLink = await generateInviteLink(payment.telegram_id);
                
                if (inviteLink) {
                    console.log(`Sending link to user ${payment.telegram_id}...`);
                    bot.telegram.sendMessage(payment.telegram_id, 
                        `✅ Оплата прошла успешно!\n\nВаша персональная ссылка для входа в группу (действует 24 часа):\n${inviteLink}`,
                        Markup.inlineKeyboard([
                            Markup.button.url('🚀 Вступить в группу', inviteLink)
                        ])
                    ).then(() => {
                        console.log(`Message sent successfully to ${payment.telegram_id}`);
                    }).catch(e => {
                        console.error(`❌ Failed to send message to ${payment.telegram_id}:`, e.message);
                    });
                } else {
                    console.error(`❌ No invite link generated for ${payment.telegram_id}. Sending error message.`);
                    bot.telegram.sendMessage(payment.telegram_id, '✅ Оплата прошла, но не удалось создать ссылку. Напишите админу.')
                        .catch(() => {});
                }
            
            } else if (status === 'canceled' || status === 'expired') {
                await updatePaymentStatus(payment.payment_id, status);
            }
        }
    });
}, CHECK_INTERVAL_MS);

// 2. Cron: Проверка истечения подписки (каждый день в 00:00)
cron.schedule('0 0 * * *', async () => {
    console.log('Running daily subscription check...');
    const now = new Date().toISOString();
    
    db.all('SELECT telegram_id FROM users WHERE status = ? AND subscription_end < ?', ['active', now], async (err, rows) => {
        if (err || !rows) return;
        
        for (const row of rows) {
            console.log(`Subscription expired for user ${row.telegram_id}. Banning...`);
            
            db.run('UPDATE users SET status = ? WHERE telegram_id = ?', ['inactive', row.telegram_id]);
            await banUserInGroup(row.telegram_id);
            
            bot.telegram.sendMessage(row.telegram_id, '⚠️ Ваша подписка истекла. Вы были удалены из группы. Для продления используйте /pay.')
                .catch(() => {}); 
        }
    });
});

// Запуск
bot.launch().then(() => {
    console.log('Bot is running...');
}).catch(err => {
    console.error('Failed to launch bot:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));