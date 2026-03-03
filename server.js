const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'cyber-ranking-secret-key-2024';

// Настройка multer для загрузки аватарок
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

// Настройка почтового транспорта
console.log('📧 Настройка почтового транспорта...');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'cyber.rank.esports@gmail.com',
        pass: 'hnjwymqyqbsefjrq' // ЗАМЕНИТЕ НА СВОЙ ПАРОЛЬ ПРИЛОЖЕНИЯ
    },
    debug: true,
    logger: true
});

// Проверка подключения к почтовому серверу
transporter.verify(function(error, success) {
    if (error) {
        console.error('❌ Ошибка подключения к почтовому серверу:', error);
    } else {
        console.log('✅ Почтовый сервер готов к отправке писем');
    }
});

// Хранилище кодов восстановления
const resetCodes = new Map();

// Подключение к базе данных
const db = new sqlite3.Database('./cyber_ranking.db', (err) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err);
    } else {
        console.log('✅ Подключено к SQLite базе данных');
        initDatabase();
    }
});

// Инициализация таблиц
function initDatabase() {
    db.serialize(() => {
        // Таблица пользователей
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            avatar TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица команд
        db.run(`CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            avatar TEXT DEFAULT '',
            leader_id INTEGER,
            rating INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (leader_id) REFERENCES users(id)
        )`);

        // Таблица участников команды
        db.run(`CREATE TABLE IF NOT EXISTS team_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER,
            member_name TEXT NOT NULL,
            role TEXT DEFAULT 'Игрок',
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (team_id) REFERENCES teams(id),
            UNIQUE(team_id, member_name)
        )`);

        // Таблица матчей
        db.run(`CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team1_id INTEGER,
            team2_id INTEGER,
            team1_score INTEGER DEFAULT 0,
            team2_score INTEGER DEFAULT 0,
            winner_id INTEGER,
            status TEXT DEFAULT 'completed',
            match_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            FOREIGN KEY (team1_id) REFERENCES teams(id),
            FOREIGN KEY (team2_id) REFERENCES teams(id),
            FOREIGN KEY (winner_id) REFERENCES teams(id),
            FOREIGN KEY (created_by) REFERENCES users(id)
        )`);

        console.log('✅ База данных инициализирована');
    });
}

// Мидлвар для проверки авторизации
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Не авторизован' });

    try {
        const user = jwt.verify(token, SECRET_KEY);
        req.user = user;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Недействительный токен' });
    }
};

// Мидлвар для проверки роли лидера
const isLeader = (req, res, next) => {
    if (req.user.role !== 'leader') {
        return res.status(403).json({ error: 'Требуются права лидера' });
    }
    next();
};

// ============== API РОУТЫ ==============

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, email, password, code } = req.body;
    
    if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Неверный код подтверждения' });
    }

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    db.get("SELECT * FROM users WHERE username = ? OR email = ?", [username, email], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка базы данных' });

        if (user) {
            if (user.username === username) return res.status(400).json({ error: 'Имя уже используется' });
            if (user.email === email) return res.status(400).json({ error: 'Email уже используется' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const role = (username === 'Quantum') ? 'leader' : 'user';
        
        db.run("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)",
            [username, email, hashedPassword, role],
            function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка регистрации' });
                
                const token = jwt.sign(
                    { id: this.lastID, username, email, role }, 
                    SECRET_KEY,
                    { expiresIn: '7d' }
                );
                
                res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
                res.json({ success: true, user: { id: this.lastID, username, email, role } });
            });
    });
});

// Вход
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
        if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Неверный пароль' });

        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email, role: user.role }, 
            SECRET_KEY,
            { expiresIn: '7d' }
        );
        
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    });
});

// Выход
app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

// Получение текущего пользователя
app.get('/api/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.json(null);

    try {
        const user = jwt.verify(token, SECRET_KEY);
        res.json(user);
    } catch (err) {
        res.clearCookie('token');
        res.json(null);
    }
});

// ========== ВОССТАНОВЛЕНИЕ ПАРОЛЯ ==========

// Запрос на восстановление пароля
app.post('/api/forgot-password', async (req, res) => {
    console.log('📩 Запрос на восстановление пароля:', req.body);
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Введите email' });
    }

    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) {
            console.error('❌ Ошибка базы данных:', err);
            return res.status(500).json({ error: 'Ошибка базы данных' });
        }
        
        if (!user) {
            console.log('❌ Email не найден:', email);
            return res.status(404).json({ error: 'Email не найден' });
        }

        console.log('✅ Пользователь найден:', user.username);

        // Генерируем 6-значный код
        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        console.log('🔐 Сгенерирован код:', resetCode);
        
        // Сохраняем код с временем жизни 15 минут
        resetCodes.set(email, {
            code: resetCode,
            expires: Date.now() + 15 * 60 * 1000
        });

        // Настройки письма
        const mailOptions = {
            from: '"Cyber Rank" <cyber.rank.esports@gmail.com>',
            to: email,
            subject: 'Восстановление пароля - Cyber Rank',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0c0f; color: #fff; border-radius: 10px; border: 2px solid #ff4655;">
                    <h1 style="color: #ff4655; text-align: center; margin-bottom: 20px;">Cyber Rank</h1>
                    <h2 style="color: #fff; text-align: center;">Восстановление пароля</h2>
                    <p style="color: #8b8f9c; text-align: center;">Здравствуйте, ${user.username}!</p>
                    <div style="background: rgba(255, 70, 85, 0.1); padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; border: 1px solid #ff4655;">
                        <p style="color: #8b8f9c; margin-bottom: 10px;">Ваш код для восстановления пароля:</p>
                        <div style="font-size: 32px; font-weight: bold; color: #ff4655; letter-spacing: 5px; padding: 10px; background: #000; border-radius: 5px;">${resetCode}</div>
                        <p style="color: #8b8f9c; margin-top: 10px;">Код действителен 15 минут</p>
                    </div>
                    <p style="color: #8b8f9c; text-align: center; font-size: 12px;">Если вы не запрашивали восстановление пароля, проигнорируйте это письмо.</p>
                </div>
            `
        };

        try {
            console.log('📧 Отправка письма на:', email);
            const info = await transporter.sendMail(mailOptions);
            console.log('✅ Письмо отправлено успешно! ID:', info.messageId);
            
            res.json({ success: true, message: 'Код восстановления отправлен на email' });
        } catch (error) {
            console.error('❌ Ошибка отправки email:', error);
            
            // ВРЕМЕННО: отправляем код в ответе для тестирования
            res.json({ 
                success: true, 
                message: 'Код отправлен (режим отладки)',
                debugCode: resetCode
            });
        }
    });
});

// Проверка кода восстановления
app.post('/api/verify-reset-code', (req, res) => {
    const { email, code } = req.body;
    console.log('🔍 Проверка кода:', { email, code });
    
    const resetData = resetCodes.get(email);
    
    if (!resetData) {
        console.log('❌ Код не найден для email:', email);
        return res.status(400).json({ error: 'Код не найден или истек' });
    }

    if (Date.now() > resetData.expires) {
        console.log('❌ Код истек для:', email);
        resetCodes.delete(email);
        return res.status(400).json({ error: 'Код истек' });
    }

    if (resetData.code !== code) {
        console.log('❌ Неверный код. Ожидался:', resetData.code, 'Получен:', code);
        return res.status(400).json({ error: 'Неверный код' });
    }

    console.log('✅ Код подтвержден для:', email);
    res.json({ success: true, message: 'Код подтвержден' });
});

// Сброс пароля
app.post('/api/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    console.log('🔑 Сброс пароля для:', email);

    const resetData = resetCodes.get(email);

    if (!resetData || resetData.code !== code || Date.now() > resetData.expires) {
        console.log('❌ Недействительный код для сброса');
        return res.status(400).json({ error: 'Недействительный код' });
    }

    if (newPassword.length < 4) {
        return res.status(400).json({ error: 'Пароль должен быть не менее 4 символов' });
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        db.run("UPDATE users SET password = ? WHERE email = ?", [hashedPassword, email], function(err) {
            if (err) {
                console.error('❌ Ошибка обновления пароля:', err);
                return res.status(500).json({ error: 'Ошибка обновления пароля' });
            }

            resetCodes.delete(email);
            console.log('✅ Пароль успешно изменен для:', email);
            
            res.json({ success: true, message: 'Пароль успешно изменен' });
        });
    } catch (error) {
        console.error('❌ Ошибка при хешировании пароля:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ========== КОМАНДЫ ==========

// Получение рейтинга команд
app.get('/api/teams/ranking', (req, res) => {
    db.all(`
        SELECT t.*, 
               COUNT(DISTINCT tm.id) as members_count,
               COUNT(DISTINCT m.id) as matches_count,
               u.username as leader_name
        FROM teams t
        LEFT JOIN team_members tm ON t.id = tm.team_id
        LEFT JOIN matches m ON t.id = m.team1_id OR t.id = m.team2_id
        LEFT JOIN users u ON t.leader_id = u.id
        GROUP BY t.id
        ORDER BY t.rating DESC
    `, [], (err, teams) => {
        if (err) {
            console.error(err);
            return res.json([]);
        }
        res.json(teams || []);
    });
});

// Получение всех команд
app.get('/api/teams', (req, res) => {
    db.all("SELECT * FROM teams ORDER BY name", [], (err, teams) => {
        res.json(teams || []);
    });
});

// Получение команды по ID
app.get('/api/teams/:id', (req, res) => {
    const teamId = req.params.id;
    
    db.get(`
        SELECT t.*, u.username as leader_name 
        FROM teams t
        LEFT JOIN users u ON t.leader_id = u.id
        WHERE t.id = ?
    `, [teamId], (err, team) => {
        if (!team) return res.status(404).json({ error: 'Команда не найдена' });
        
        db.all(`
            SELECT id, member_name, role
            FROM team_members
            WHERE team_id = ?
        `, [teamId], (err, members) => {
            team.members = members || [];
            
            db.all(`
                SELECT m.*, t1.name as team1_name, t2.name as team2_name,
                       t1.avatar as team1_avatar, t2.avatar as team2_avatar
                FROM matches m
                JOIN teams t1 ON m.team1_id = t1.id
                JOIN teams t2 ON m.team2_id = t2.id
                WHERE m.team1_id = ? OR m.team2_id = ?
                ORDER BY m.match_date DESC LIMIT 20
            `, [teamId, teamId], (err, matches) => {
                team.matches = matches || [];
                res.json(team);
            });
        });
    });
});

// Создание команды
app.post('/api/teams', authenticateToken, isLeader, (req, res) => {
    const { name } = req.body;
    
    if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Название должно быть не менее 2 символов' });
    }
    
    db.get("SELECT * FROM teams WHERE name = ?", [name], (err, team) => {
        if (team) return res.status(400).json({ error: 'Команда уже существует' });
        
        db.run("INSERT INTO teams (name, leader_id, rating) VALUES (?, ?, 0)",
            [name, req.user.id],
            function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка создания команды' });
                
                console.log(`✅ Команда "${name}" создана лидером ${req.user.username}`);
                res.json({ success: true, id: this.lastID, name });
            });
    });
});

// Загрузка аватара команды
app.post('/api/teams/:teamId/avatar', authenticateToken, isLeader, upload.single('avatar'), (req, res) => {
    const teamId = req.params.teamId;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    db.get("SELECT * FROM teams WHERE id = ? AND leader_id = ?", [teamId, req.user.id], (err, team) => {
        if (!team) return res.status(403).json({ error: 'Вы не лидер этой команды' });

        const avatarUrl = `/uploads/${req.file.filename}`;
        db.run("UPDATE teams SET avatar = ? WHERE id = ?", [avatarUrl, teamId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка обновления аватара' });
            res.json({ success: true, avatar: avatarUrl });
        });
    });
});

// Удаление команды
app.delete('/api/teams/:teamId', authenticateToken, isLeader, (req, res) => {
    const teamId = req.params.teamId;

    db.get("SELECT * FROM teams WHERE id = ? AND leader_id = ?", [teamId, req.user.id], (err, team) => {
        if (!team) return res.status(403).json({ error: 'Вы не лидер этой команды' });

        db.run("DELETE FROM matches WHERE team1_id = ? OR team2_id = ?", [teamId, teamId]);
        db.run("DELETE FROM team_members WHERE team_id = ?", [teamId]);
        db.run("DELETE FROM teams WHERE id = ?", [teamId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка удаления команды' });
            res.json({ success: true });
        });
    });
});

// ========== УЧАСТНИКИ ==========

// Добавление игрока
app.post('/api/teams/:teamId/members', authenticateToken, isLeader, (req, res) => {
    const teamId = req.params.teamId;
    const { member_name, role } = req.body;
    
    if (!member_name) return res.status(400).json({ error: 'Укажите имя игрока' });
    
    db.get("SELECT * FROM teams WHERE id = ? AND leader_id = ?", [teamId, req.user.id], (err, team) => {
        if (!team) return res.status(403).json({ error: 'Вы не лидер этой команды' });
        
        db.run("INSERT OR IGNORE INTO team_members (team_id, member_name, role) VALUES (?, ?, ?)",
            [teamId, member_name, role || 'Игрок'], function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка добавления' });
                res.json({ success: true });
            });
    });
});

// Обновление роли
app.put('/api/teams/:teamId/members/:memberId', authenticateToken, isLeader, (req, res) => {
    const teamId = req.params.teamId;
    const memberId = req.params.memberId;
    const { role } = req.body;

    db.get("SELECT * FROM teams WHERE id = ? AND leader_id = ?", [teamId, req.user.id], (err, team) => {
        if (!team) return res.status(403).json({ error: 'Вы не лидер этой команды' });

        db.run("UPDATE team_members SET role = ? WHERE id = ? AND team_id = ?",
            [role, memberId, teamId], function(err) {
                if (err) return res.status(500).json({ error: 'Ошибка обновления роли' });
                res.json({ success: true });
            });
    });
});

// Удаление игрока
app.delete('/api/teams/:teamId/members/:memberId', authenticateToken, isLeader, (req, res) => {
    const teamId = req.params.teamId;
    const memberId = req.params.memberId;

    db.get("SELECT * FROM teams WHERE id = ? AND leader_id = ?", [teamId, req.user.id], (err, team) => {
        if (!team) return res.status(403).json({ error: 'Вы не лидер этой команды' });

        db.run("DELETE FROM team_members WHERE id = ? AND team_id = ?", [memberId, teamId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка удаления игрока' });
            res.json({ success: true });
        });
    });
});

// ========== МАТЧИ ==========

// Создание матча
app.post('/api/matches', authenticateToken, isLeader, (req, res) => {
    const { team1_id, team2_id, team1_score, team2_score } = req.body;
    
    if (!team1_id || !team2_id) return res.status(400).json({ error: 'Выберите обе команды' });
    if (team1_id === team2_id) return res.status(400).json({ error: 'Команды должны быть разными' });
    
    let winner_id = null;
    if (team1_score > team2_score) winner_id = team1_id;
    else if (team2_score > team1_score) winner_id = team2_id;
    
    db.run(`
        INSERT INTO matches (team1_id, team2_id, team1_score, team2_score, winner_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [team1_id, team2_id, team1_score, team2_score, winner_id, req.user.id],
    function(err) {
        if (err) return res.status(500).json({ error: 'Ошибка создания матча' });
        
        if (winner_id) {
            const loser_id = winner_id == team1_id ? team2_id : team1_id;
            db.run("UPDATE teams SET rating = rating + 25 WHERE id = ?", [winner_id]);
            db.run("UPDATE teams SET rating = rating - 25 WHERE id = ?", [loser_id]);
        }
        
        res.json({ success: true, match_id: this.lastID });
    });
});

// Получение матчей
app.get('/api/matches', (req, res) => {
    db.all(`
        SELECT m.*, t1.name as team1_name, t2.name as team2_name,
               t1.avatar as team1_avatar, t2.avatar as team2_avatar
        FROM matches m
        JOIN teams t1 ON m.team1_id = t1.id
        JOIN teams t2 ON m.team2_id = t2.id
        ORDER BY m.match_date DESC LIMIT 50
    `, [], (err, matches) => {
        if (err) {
            console.error(err);
            return res.json([]);
        }
        res.json(matches || []);
    });
});

// Удаление матча
app.delete('/api/matches/:matchId', authenticateToken, isLeader, (req, res) => {
    const matchId = req.params.matchId;

    db.get("SELECT * FROM matches WHERE id = ? AND created_by = ?", [matchId, req.user.id], (err, match) => {
        if (!match) return res.status(403).json({ error: 'Вы не создатель этого матча' });

        db.run("DELETE FROM matches WHERE id = ?", [matchId], function(err) {
            if (err) return res.status(500).json({ error: 'Ошибка удаления матча' });
            res.json({ success: true });
        });
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 СЕРВЕР ЗАПУЩЕН');
    console.log('='.repeat(50));
    console.log(`📱 Порт: ${PORT}`);
    console.log(`🌐 Локальный доступ: http://localhost:${PORT}`);
    console.log('='.repeat(50) + '\n');
});