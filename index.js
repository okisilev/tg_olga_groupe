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
const SUBSCRIPTION_PRICE = 150; // Цена в рублях
const CHECK_INTERVAL_MS = 10000; // Проверка оплат каждые 10 секунд
const ADMIN_ID = 431292182; // Твой ID для команды /genlink

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
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    )`);

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

// Прямой вызов API Telegram через Axios
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

// Генерация ссылки-приглашения (с принудительным разбаном перед созданием)
const generateInviteLink = async (userId) => {
    try {
        // 1. Сначала ГАРАНТИРОВАННО разбаниваем пользователя
        await unbanUserInGroup(userId);
        
        // Небольшая задержка, чтобы Telegram успел обработать разбан (иногда помогает при рассинхроне)
        await new Promise(resolve => setTimeout(resolve, 500));

        const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // +24 часа

        console.log(`Generating invite link for user ${userId}...`);
        const response = await callTelegramAPI('exportChatInviteLink', {
            chat_id: GROUP_ID,
            expire_date: expireDate,
            member_limit: 1, // Одноразовая
            name: `Invite for ${userId}`
        });

        if (response && response.ok && response.result) {
            const link = response.result;
            console.log(`✅ Invite link generated: ${link}`);
            
            // Сохраняем ссылку в БД
            await new Promise((resolve, reject) => {
                db.run('INSERT INTO invite_links (telegram_id, link) VALUES (?, ?)', 
                    [userId, link], (err) => {
                        if (err) reject(err); else resolve();
                    });
            });
            
            return link;
        }
        console.error(` Failed to generate link. Response:`, JSON.stringify(response));
        return null;
    } catch (e) {
        console.error('❌ GenerateLink Critical Error:', e.message);
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

// Разбан пользователя (ЯВНЫЙ вызов без only_if_banned для надежности)
const unbanUserInGroup = async (userId) => {
    try {
        console.log(`Attempting to unban user ${userId}...`);
        // Убираем only_if_banned, чтобы форсировать разбан, если пользователь в черном списке
        const response = await callTelegramAPI('unbanChatMember', {
            chat_id: GROUP_ID,
            user_id: userId
        });
        console.log(`Unban result for ${userId}:`, JSON.stringify(response));
        return true;
    } catch (e) {
        console.error(`Unban Error for ${userId}:`, e.message);
        // Если ошибка "USER_NOT_PARTICIPANT", значит его и так нет в бане/группе - это ок
        if (e.response?.data?.description?.includes('USER_NOT_PARTICIPANT')) {
            return true;
        }
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

// Команда для админа: создание тестовой ссылки (с принудительным разбаном)
bot.command('genlink', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('❌ Эта команда доступна только администратору.');
    }

    const args = ctx.message.text.split(' ');
    if (!args[1]) {
        return ctx.reply('Использование: /genlink USER_ID\nПример: /genlink 5807635774');
    }

    const userId = parseInt(args[1]);
    
    try {
        ctx.reply(`⏳ Разбаниваю пользователя ${userId} и создаю ссылку...`);
        
        // Явный разбан
        await unbanUserInGroup(userId);
        await new Promise(resolve => setTimeout(resolve, 500)); // Задержка 0.5 сек

        const expireDate = Math.floor(Date.now() / 1000) + (24 * 60 * 60);
        
        const response = await callTelegramAPI('exportChatInviteLink', {
            chat_id: GROUP_ID,
            expire_date: expireDate,
            member_limit: 1,
            name: `Admin Test Link for ${userId}`
        });

        if (response.ok && response.result) {
            const link = response.result;
            
            db.run('INSERT INTO invite_links (telegram_id, link) VALUES (?, ?)', [userId, link]);
            
            ctx.reply(`✅ Ссылка для пользователя ${userId} создана:\n${link}\n\n(Перейдите по ней с аккаунта пользователя)`);
            
            bot.telegram.sendMessage(userId, `🔗 Тестовая ссылка для входа: ${link}`, Markup.inlineKeyboard([Markup.button.url('Войти', link)])).catch(() => {});
        } else {
            ctx.reply('❌ Не удалось создать ссылку. Проверьте логи.');
        }
    } catch (e) {
        console.error(e);
        ctx.reply(`❌ Ошибка: ${e.message}`);
    }
});

// --- ОБРАБОТКА ВХОДА В ГРУППУ ---

bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    
    for (const member of newMembers) {
        if (member.is_bot) continue;

        const userId = member.id;
        console.log(`New member joined: ${userId}`);

        db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
            if (err) return;

            if (!user || user.status !== 'active') {
                // Нет подписки -> Баним
                console.log(`User ${userId} has no active subscription. Kicking...`);
                await banUserInGroup(userId);
                
                bot.telegram.sendMessage(userId, 
                    `️ У вас нет активной подписки или она истекла.\nВы были автоматически удалены из группы.\n\nДля доступа оплатите подписку:`,
                    Markup.inlineKeyboard([
                        Markup.button.url(' Оплатить доступ', `https://t.me/${bot.botInfo.username}?start=pay`)
                    ])
                ).catch(() => {});
            } else {
                // Есть подписка -> Убеждаемся, что он не забанен (на всякий случай)
                console.log(`User ${userId} has active subscription. Ensuring unban...`);
                await unbanUserInGroup(userId);
            }
        });
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
                
                // ВАЖНО: Разбаниваем пользователя перед выдачей ссылки, если он был забанен ранее
                await unbanUserInGroup(payment.telegram_id);

                // Генерируем ссылку-приглашение
                const inviteLink = await generateInviteLink(payment.telegram_id);
                
                if (inviteLink) {
                    bot.telegram.sendMessage(payment.telegram_id, 
                        `✅ Оплата прошла успешно!\n\nВаша персональная ссылка для входа в группу (действует 24 часа):\n${inviteLink}`,
                        Markup.inlineKeyboard([
                            Markup.button.url('🚀 Вступить в группу', inviteLink)
                        ])
                    ).catch(e => console.error('Send Link Error:', e.message));
                } else {
                    bot.telegram.sendMessage(payment.telegram_id, '✅ Оплата прошла, но не удалось создать ссылку. Напишите админу.')
                        .catch(() => {});
                }
            } else if (status === 'canceled' || status === 'expired') {
                await updatePaymentStatus(payment.payment_id, status);
            }
        }
    });
}, CHECK_INTERVAL_MS);

// 2. Cron: Проверка истечения подписки и напоминания (каждый день в 00:00)
cron.schedule('0 0 * * *', async () => {
    console.log('Running daily subscription check & reminders...');
    
    const now = new Date();
    const nowIso = now.toISOString();
    
    // Дата через 2 дня для проверки напоминаний
    const reminderDate = new Date();
    reminderDate.setDate(reminderDate.getDate() + 2);
    const reminderDateIso = reminderDate.toISOString();

    // --- ЧАСТЬ 1: БАНИМ ТЕХ, У КОГО ПОДПИСКА УЖЕ ИСТЕКЛА ---
    db.all('SELECT telegram_id FROM users WHERE status = ? AND subscription_end < ?', ['active', nowIso], async (err, rowsExpired) => {
        if (!err && rowsExpired) {
            for (const row of rowsExpired) {
                console.log(`Subscription EXPIRED for user ${row.telegram_id}. Banning...`);
                
                db.run('UPDATE users SET status = ? WHERE telegram_id = ?', ['inactive', row.telegram_id]);
                await banUserInGroup(row.telegram_id);
                
                bot.telegram.sendMessage(row.telegram_id, '⚠️ Ваша подписка истекла. Вы были удалены из группы. Для продления используйте /pay.')
                    .catch(() => {}); 
            }
        }
    });

    // --- ЧАСТЬ 2: НАПОМИНАНИЕ ЗА 2 ДНЯ ДО ОКОНЧАНИЯ ---
    // Ищем тех, у кого статус active И дата окончания между "сейчас" и "через 2 дня"
    // Важно: исключаем тех, кому уже отправили напоминание сегодня, чтобы не спамить. 
    // Для простоты будем слать всем, кто попадает в диапазон.
    
    db.all('SELECT telegram_id, username, subscription_end FROM users WHERE status = ? AND subscription_end >= ? AND subscription_end <= ?', 
        ['active', nowIso, reminderDateIso], 
        async (err, rowsReminder) => {
            
            if (!err && rowsReminder) {
                for (const row of rowsReminder) {
                    const endDate = new Date(row.subscription_end);
                    const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
                    
                    console.log(`Sending reminder to user ${row.telegram_id} (${row.username}). Days left: ${daysLeft}`);
                    
                    try {
                        await bot.telegram.sendMessage(row.telegram_id, 
                            `🔔 Напоминание о подписке\n\nУважаемый ${row.username || 'пользователь'}, ваша подписка истекает через ${daysLeft} дн. (${endDate.toLocaleDateString('ru-RU')}).\n\nЧтобы не потерять доступ к группе, пожалуйста, продлите подписку заранее.`,
                            Markup.inlineKeyboard([
                                Markup.button.url('💳 Продлить подписку', `https://t.me/${bot.botInfo.username}?start=pay`)
                            ])
                        );
                    } catch (e) {
                        console.error(`Failed to send reminder to ${row.telegram_id}:`, e.message);
                    }
                }
            }
        }
    );
});

// --- КОМАНДА ДЛЯ ТЕСТИРОВАНИЯ CRON (ТОЛЬКО ДЛЯ АДМИНА) ---
bot.command('testcron', async (ctx) => {
    // Проверка, что это ты (твой ID)
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply('❌ Эта команда доступна только администратору.');
    }

    ctx.reply('⏳ Запуск ручной проверки подписок...');

    const now = new Date();
    const nowIso = now.toISOString();
    
    // Дата через 2 дня для проверки напоминаний
    const reminderDate = new Date();
    reminderDate.setDate(reminderDate.getDate() + 2);
    const reminderDateIso = reminderDate.toISOString();

    // 1. Проверяем истекшие (для бана)
    db.all('SELECT telegram_id FROM users WHERE status = ? AND subscription_end < ?', ['active', nowIso], async (err, rowsExpired) => {
        if (!err && rowsExpired && rowsExpired.length > 0) {
            ctx.reply(`Найдено ${rowsExpired.length} пользователей с истекшей подпиской.`);
            for (const row of rowsExpired) {
                console.log(`[TEST] Banning user ${row.telegram_id}`);
                db.run('UPDATE users SET status = ? WHERE telegram_id = ?', ['inactive', row.telegram_id]);
                await banUserInGroup(row.telegram_id);
                try {
                    await bot.telegram.sendMessage(row.telegram_id, '🧪 [ТЕСТ] Ваша подписка истекла. Вы были удалены из группы.');
                } catch(e) {}
            }
        } else {
            console.log('[TEST] No expired subscriptions found.');
        }
    });

    // 2. Проверяем напоминания (за 2 дня)
    db.all('SELECT telegram_id, username, subscription_end FROM users WHERE status = ? AND subscription_end >= ? AND subscription_end <= ?', 
        ['active', nowIso, reminderDateIso], 
        async (err, rowsReminder) => {
            
            if (!err && rowsReminder && rowsReminder.length > 0) {
                ctx.reply(`Найдено ${rowsReminder.length} пользователей для напоминания.`);
                
                for (const row of rowsReminder) {
                    const endDate = new Date(row.subscription_end);
                    const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
                    
                    console.log(`[TEST] Sending reminder to ${row.telegram_id}. Days left: ${daysLeft}`);
                    
                    try {
                        await bot.telegram.sendMessage(row.telegram_id, 
                            ` [ТЕСТ] Напоминание о подписке\n\nУважаемый ${row.username || 'пользователь'}, ваша подписка истекает через ${daysLeft} дн.\n\nЧтобы не потерять доступ, продлите подписку:`,
                            Markup.inlineKeyboard([
                                Markup.button.url('💳 Продлить подписку', `https://t.me/${bot.botInfo.username}?start=pay`)
                            ])
                        );
                    } catch (e) {
                        console.error(`Failed to send test reminder to ${row.telegram_id}:`, e.message);
                    }
                }
                ctx.reply('✅ Тестовые напоминания отправлены.');
            } else {
                ctx.reply('ℹ️ Нет пользователей, которым нужно отправить напоминание (срок окончания от сегодня до +2 дней).');
                ctx.reply('💡 Подсказка: Чтобы протестировать, измените дату подписки у пользователя в БД на завтра:\n`UPDATE users SET subscription_end = datetime(\'now\', \'+1 day\') WHERE telegram_id = ВАШ_ID;`');
            }
        }
    );
});

// Запуск
bot.launch().then(() => {
    console.log('Bot is running...');
}).catch(err => {
    console.error('Failed to launch bot:', err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));