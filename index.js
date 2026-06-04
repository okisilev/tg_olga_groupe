require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cron = require('node-cron');

// --- КОНФИГУРАЦИЯ ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;
const GROUP_ID = process.env.GROUP_ID; // -1004202098685
const DB_PATH = process.env.DB_PATH || './bot.db';
const SUBSCRIPTION_PRICE = 100; // Цена в рублях
const CHECK_INTERVAL_MS = 10000; // Проверка оплат каждые 10 секунд

// Авторизация для API ЮKassa (Base64)
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
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        status TEXT DEFAULT 'inactive', -- active, inactive
        subscription_end DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        telegram_id INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending', -- pending, succeeded, canceled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    )`);
});

// --- ФУНКЦИИ ПОМОЩНИКИ ---

// 1. Работа с БД: Получить или создать пользователя
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

// 2. Работа с БД: Обновить статус платежа
const updatePaymentStatus = (paymentId, status) => {
    return new Promise((resolve, reject) => {
        db.run('UPDATE payments SET status = ? WHERE payment_id = ?', [status, paymentId], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

// 3. Работа с БД: Активировать подписку пользователя
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

// 4. ЮKassa: Создать платеж
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

// 5. ЮKassa: Проверить статус платежа
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

// 6. Telegram: Добавить пользователя в группу (ИСПРАВЛЕНО для Telegraf 4.16)
const addUserToGroup = async (userId) => {
    try {
        // Сначала разбаниваем, если был забанен ранее
        await bot.telegram.callApi('unbanChatMember', {
            chat_id: GROUP_ID,
            user_id: userId,
            only_if_banned: true // Разбанить, только если был забанен
        }).catch(() => {}); 
        
        // Добавляем пользователя через прямой вызов API
        await bot.telegram.callApi('addChatMember', {
            chat_id: GROUP_ID,
            user_id: userId
        });
        
        return true;
    } catch (e) {
        console.error(`AddToGroup Error for ${userId}:`, e.message);
        // Если ошибка "USER_ALREADY_PARTICIPANT", считаем это успехом
        if (e.message.includes('USER_ALREADY_PARTICIPANT') || e.message.includes('user is already a member')) {
            return true;
        }
        return false;
    }
};

// 7. Telegram: Забанить пользователя в группе (ИСПРАВЛЕНО для Telegraf 4.16)
const banUserInGroup = async (userId) => {
    try {
        // Баним через прямой вызов API
        await bot.telegram.callApi('banChatMember', {
            chat_id: GROUP_ID,
            user_id: userId
        });
        return true;
    } catch (e) {
        // Игнорируем ошибку, если пользователя уже нет в группе
        if (e.message.includes('USER_NOT_PARTICIPANT') || e.message.includes('user not found') || e.message.includes('PARTICIPANT_ID_INVALID')) {
            return true; 
        }
        console.error(`BanUser Error for ${userId}:`, e.message);
        return false;
    }
};

// --- ОБРАБОТЧИКИ КОМАНД ---

bot.start(async (ctx) => {
    await getOrCreateUser(ctx);
    const payload = ctx.startPayload;

    // Если пользователь перешел по ссылке "Оплатить"
    if (payload === 'pay') {
        try {
            const userId = ctx.from.id;
            // Создаем платеж
            const payment = await createYooPayment(userId, SUBSCRIPTION_PRICE);
            
            // Сохраняем в БД
            await new Promise((resolve, reject) => {
                db.run('INSERT OR REPLACE INTO payments (payment_id, telegram_id, amount, status) VALUES (?, ?, ?, ?)',
                    [payment.id, userId, SUBSCRIPTION_PRICE, 'pending'], (err) => {
                        if (err) reject(err); else resolve();
                    });
            });

            // Отправляем ссылку на оплату
            ctx.reply(
                `✅ Платеж на сумму ${SUBSCRIPTION_PRICE} руб. создан.\nНажмите кнопку ниже для перехода в ЮKassa:`,
                Markup.inlineKeyboard([
                    Markup.button.url('💳 Оплатить в ЮKassa', payment.confirmation.confirmation_url)
                ])
            );
        } catch (e) {
            console.error(e);
            ctx.reply('❌ Не удалось создать платеж. Попробуйте позже или напишите админу.');
        }
    } else {
        // Обычное приветствие
        ctx.reply(
            `Привет! 👋\nЯ бот для управления доступом в закрытую группу.\n\nЧтобы получить доступ, необходимо оплатить подписку.`,
            Markup.inlineKeyboard([
                Markup.button.url('💳 Получить ссылку на оплату', `https://t.me/${bot.botInfo.username}?start=pay`)
            ])
        );
    }
});

// Команда /pay
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

// --- ФОНОВЫЕ ПРОЦЕССЫ ---

// 1. Polling платежей (проверка оплат каждые 10 сек)
setInterval(async () => {
    // Ищем все платежи со статусом pending
    db.all('SELECT * FROM payments WHERE status = ?', ['pending'], async (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        for (const payment of rows) {
            const status = await checkYooPayment(payment.payment_id);
            
            if (status === 'succeeded') {
                console.log(`Payment ${payment.payment_id} succeeded for user ${payment.telegram_id}`);
                
                // Обновляем платеж
                await updatePaymentStatus(payment.payment_id, 'succeeded');
                
                // Активируем пользователя
                await activateSubscription(payment.telegram_id);
                
                // Добавляем в группу
                const added = await addUserToGroup(payment.telegram_id);
                
                // Уведомляем пользователя
                if (added) {
                    bot.telegram.sendMessage(payment.telegram_id, '✅ Оплата прошла успешно! Вы добавлены в группу.')
                        .catch(e => console.error('Failed to send success message:', e.message));
                } else {
                    bot.telegram.sendMessage(payment.telegram_id, '✅ Оплата прошла, но возникла проблема с добавлением в группу. Напишите админу.')
                        .catch(e => console.error('Failed to send error message:', e.message));
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
    
    // Находим активных пользователей, у кого срок истек
    db.all('SELECT telegram_id FROM users WHERE status = ? AND subscription_end < ?', ['active', now], async (err, rows) => {
        if (err || !rows) return;
        
        for (const row of rows) {
            console.log(`Subscription expired for user ${row.telegram_id}. Banning...`);
            
            // Деактивируем в БД
            db.run('UPDATE users SET status = ? WHERE telegram_id = ?', ['inactive', row.telegram_id]);
            
            // Баним в группе
            await banUserInGroup(row.telegram_id);
            
            // Уведомляем (если возможно)
            bot.telegram.sendMessage(row.telegram_id, '⚠️ Ваша подписка истекла. Вы были удалены из группы. Для продления используйте /pay.')
                .catch(() => {}); 
        }
    });
});

bot.command('checkgroup', async (ctx) => {
    try {
        // Пытаемся получить информацию о группе
        const chat = await bot.telegram.getChat(GROUP_ID);
        ctx.reply(`✅ Бот видит группу: ${chat.title}\nID: ${chat.id}\nТип: ${chat.type}`);
    } catch (e) {
        ctx.reply(`❌ Ошибка доступа к группе: ${e.message}`);
        console.error('Group Check Error:', e);
    }
});

// Запуск бота
// Важно: bot.launch() должен быть после всех определений
bot.launch().then(() => {
    console.log('Bot is running...');
}).catch(err => {
    console.error('Failed to launch bot:', err);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));