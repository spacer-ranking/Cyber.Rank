const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
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

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/cyber_ranking',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Инициализация таблиц
async function initDatabase() {
    try {
        // Таблица пользователей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                avatar TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Таблица команд
        await pool.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) UNIQUE NOT NULL,
                avatar TEXT DEFAULT '',
                leader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                rating INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Таблица участников команды
        await pool.query(`
            CREATE TABLE IF NOT EXISTS team_members (
                id SERIAL PRIMARY KEY,
                team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
                member_name VARCHAR(255) NOT NULL,
                role VARCHAR(100) DEFAULT 'Игрок',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(team_id, member_name)
            )
        `);

        // Таблица матчей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS matches (
                id SERIAL PRIMARY KEY,
                team1_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
                team2_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
                team1_score INTEGER DEFAULT 0,
                team2_score INTEGER DEFAULT 0,
                winner_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
                status VARCHAR(50) DEFAULT 'completed',
                match_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
            )
        `);

        console.log('✅ База данных PostgreSQL инициализирована');
    } catch (error) {
        console.error('❌ Ошибка инициализации базы данных:', error);
    }
}

// Вызов инициализации
initDatabase();

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
    const { username, password, code } = req.body;
    
    if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Неверный код подтверждения' });
    }

    if (!username || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    try {
        // Проверяем существование пользователя
        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Имя уже используется' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const role = (username === 'Quantum') ? 'leader' : 'user';
        
        const result = await pool.query(
            'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role',
            [username, hashedPassword, role]
        );
        
        const user = result.rows[0];
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role }, 
            SECRET_KEY,
            { expiresIn: '7d' }
        );
        
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, user });
        
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        
        if (!user) return res.status(400).json({ error: 'Пользователь не найден' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Неверный пароль' });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role }, 
            SECRET_KEY,
            { expiresIn: '7d' }
        );
        
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
        
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
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

// ========== КОМАНДЫ ==========

// Получение рейтинга команд
app.get('/api/teams/ranking', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, 
                   COUNT(DISTINCT tm.id) as members_count,
                   COUNT(DISTINCT m.id) as matches_count,
                   u.username as leader_name
            FROM teams t
            LEFT JOIN team_members tm ON t.id = tm.team_id
            LEFT JOIN matches m ON t.id = m.team1_id OR t.id = m.team2_id
            LEFT JOIN users u ON t.leader_id = u.id
            GROUP BY t.id, u.username
            ORDER BY t.rating DESC
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка получения рейтинга:', error);
        res.json([]);
    }
});

// Получение всех команд
app.get('/api/teams', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM teams ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка получения команд:', error);
        res.json([]);
    }
});

// Получение команды по ID
app.get('/api/teams/:id', async (req, res) => {
    const teamId = req.params.id;
    
    try {
        const teamResult = await pool.query(`
            SELECT t.*, u.username as leader_name 
            FROM teams t
            LEFT JOIN users u ON t.leader_id = u.id
            WHERE t.id = $1
        `, [teamId]);
        
        if (teamResult.rows.length === 0) {
            return res.status(404).json({ error: 'Команда не найдена' });
        }
        
        const team = teamResult.rows[0];
        
        const membersResult = await pool.query(`
            SELECT id, member_name, role
            FROM team_members
            WHERE team_id = $1
        `, [teamId]);
        
        team.members = membersResult.rows;
        
        const matchesResult = await pool.query(`
            SELECT m.*, t1.name as team1_name, t2.name as team2_name,
                   t1.avatar as team1_avatar, t2.avatar as team2_avatar
            FROM matches m
            JOIN teams t1 ON m.team1_id = t1.id
            JOIN teams t2 ON m.team2_id = t2.id
            WHERE m.team1_id = $1 OR m.team2_id = $1
            ORDER BY m.match_date DESC LIMIT 20
        `, [teamId]);
        
        team.matches = matchesResult.rows;
        res.json(team);
        
    } catch (error) {
        console.error('Ошибка получения команды:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Создание команды
app.post('/api/teams', authenticateToken, isLeader, async (req, res) => {
    const { name } = req.body;
    
    if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Название должно быть не менее 2 символов' });
    }
    
    try {
        const checkResult = await pool.query('SELECT * FROM teams WHERE name = $1', [name]);
        
        if (checkResult.rows.length > 0) {
            return res.status(400).json({ error: 'Команда уже существует' });
        }
        
        const result = await pool.query(
            'INSERT INTO teams (name, leader_id, rating) VALUES ($1, $2, 0) RETURNING id, name',
            [name, req.user.id]
        );
        
        console.log(`✅ Команда "${name}" создана лидером ${req.user.username}`);
        res.json({ success: true, ...result.rows[0] });
        
    } catch (error) {
        console.error('Ошибка создания команды:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Загрузка аватара команды
app.post('/api/teams/:teamId/avatar', authenticateToken, isLeader, upload.single('avatar'), async (req, res) => {
    const teamId = req.params.teamId;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    try {
        const teamCheck = await pool.query(
            'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
            [teamId, req.user.id]
        );
        
        if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не лидер этой команды' });
        }

        const avatarUrl = `/uploads/${req.file.filename}`;
        await pool.query('UPDATE teams SET avatar = $1 WHERE id = $2', [avatarUrl, teamId]);
        
        res.json({ success: true, avatar: avatarUrl });
        
    } catch (error) {
        console.error('Ошибка обновления аватара:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Удаление команды
app.delete('/api/teams/:teamId', authenticateToken, isLeader, async (req, res) => {
    const teamId = req.params.teamId;

    try {
        const teamCheck = await pool.query(
            'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
            [teamId, req.user.id]
        );
        
        if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не лидер этой команды' });
        }

        // Удаление каскадное благодаря ON DELETE CASCADE
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка удаления команды:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ========== УЧАСТНИКИ ==========

// Добавление игрока
app.post('/api/teams/:teamId/members', authenticateToken, isLeader, async (req, res) => {
    const teamId = req.params.teamId;
    const { member_name, role } = req.body;
    
    if (!member_name) return res.status(400).json({ error: 'Укажите имя игрока' });
    
    try {
        const teamCheck = await pool.query(
            'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
            [teamId, req.user.id]
        );
        
        if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не лидер этой команды' });
        }
        
        await pool.query(
            'INSERT INTO team_members (team_id, member_name, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, member_name) DO NOTHING',
            [teamId, member_name, role || 'Игрок']
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка добавления игрока:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновление роли
app.put('/api/teams/:teamId/members/:memberId', authenticateToken, isLeader, async (req, res) => {
    const teamId = req.params.teamId;
    const memberId = req.params.memberId;
    const { role } = req.body;

    try {
        const teamCheck = await pool.query(
            'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
            [teamId, req.user.id]
        );
        
        if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не лидер этой команды' });
        }

        await pool.query(
            'UPDATE team_members SET role = $1 WHERE id = $2 AND team_id = $3',
            [role, memberId, teamId]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка обновления роли:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Удаление игрока
app.delete('/api/teams/:teamId/members/:memberId', authenticateToken, isLeader, async (req, res) => {
    const teamId = req.params.teamId;
    const memberId = req.params.memberId;

    try {
        const teamCheck = await pool.query(
            'SELECT * FROM teams WHERE id = $1 AND leader_id = $2',
            [teamId, req.user.id]
        );
        
        if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не лидер этой команды' });
        }

        await pool.query(
            'DELETE FROM team_members WHERE id = $1 AND team_id = $2',
            [memberId, teamId]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка удаления игрока:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ========== МАТЧИ ==========

// Создание матча
app.post('/api/matches', authenticateToken, isLeader, async (req, res) => {
    const { team1_id, team2_id, team1_score, team2_score } = req.body;
    
    if (!team1_id || !team2_id) return res.status(400).json({ error: 'Выберите обе команды' });
    if (team1_id === team2_id) return res.status(400).json({ error: 'Команды должны быть разными' });
    
    let winner_id = null;
    if (team1_score > team2_score) winner_id = team1_id;
    else if (team2_score > team1_score) winner_id = team2_id;
    
    try {
        const result = await pool.query(
            `INSERT INTO matches (team1_id, team2_id, team1_score, team2_score, winner_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [team1_id, team2_id, team1_score, team2_score, winner_id, req.user.id]
        );
        
        if (winner_id) {
            const loser_id = winner_id == team1_id ? team2_id : team1_id;
            await pool.query('UPDATE teams SET rating = rating + 25 WHERE id = $1', [winner_id]);
            await pool.query('UPDATE teams SET rating = rating - 25 WHERE id = $1', [loser_id]);
        }
        
        res.json({ success: true, match_id: result.rows[0].id });
        
    } catch (error) {
        console.error('Ошибка создания матча:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получение матчей
app.get('/api/matches', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT m.*, t1.name as team1_name, t2.name as team2_name,
                   t1.avatar as team1_avatar, t2.avatar as team2_avatar
            FROM matches m
            JOIN teams t1 ON m.team1_id = t1.id
            JOIN teams t2 ON m.team2_id = t2.id
            ORDER BY m.match_date DESC LIMIT 50
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Ошибка получения матчей:', error);
        res.json([]);
    }
});

// Удаление матча
app.delete('/api/matches/:matchId', authenticateToken, isLeader, async (req, res) => {
    const matchId = req.params.matchId;

    try {
        const matchCheck = await pool.query(
            'SELECT * FROM matches WHERE id = $1 AND created_by = $2',
            [matchId, req.user.id]
        );
        
        if (matchCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Вы не создатель этого матча' });
        }

        await pool.query('DELETE FROM matches WHERE id = $1', [matchId]);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ошибка удаления матча:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
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