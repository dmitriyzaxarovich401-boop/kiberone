const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Загрузка и сохранение базы данных
let DB = JSON.parse(fs.readFileSync('database.json', 'utf8'));

function saveDB() {
    fs.writeFileSync('database.json', JSON.stringify(DB, null, 2));
}

// Сопоставление socket.id с пользователем
const onlineUsers = {};

// Инициализация, если файл пустой
if (!DB.admin) {
    DB.admin = { id: 'admin', name: 'Главный Админ', password: 'admin007' };
    DB.teachers = [];
    DB.students = [];
    DB.groups = [];
    DB.messages = [];
    DB.cyberons = {};
    saveDB();
}

io.on('connection', (socket) => {
    console.log('Новое подключение:', socket.id);

    // === АВТОРИЗАЦИЯ ===
    socket.on('login', (data) => {
        const { role, username, password } = data;
        
        if (role === 'admin') {
            if (username === DB.admin.name && password === DB.admin.password) {
                onlineUsers[socket.id] = { ...DB.admin, role: 'admin' };
                socket.emit('login_success', { user: DB.admin, role: 'admin' });
            } else {
                socket.emit('login_error', 'Неверный логин или пароль администратора');
            }
        }
        else if (role === 'teacher') {
            const teacher = DB.teachers.find(t => t.username === username);
            if (!teacher) {
                socket.emit('login_error', 'Учитель не найден. Обратитесь к администратору.');
                return;
            }
            if (teacher.password !== password) {
                socket.emit('login_error', 'Неверный пароль');
                return;
            }
            onlineUsers[socket.id] = { ...teacher, role: 'teacher' };
            socket.emit('login_success', { user: teacher, role: 'teacher' });
        }
        else if (role === 'student') {
            // Проверка: одно устройство = один аккаунт
            const clientIP = socket.handshake.address;
            const existingStudent = DB.students.find(s => s.ip === clientIP && s.username !== username);
            if (existingStudent) {
                socket.emit('login_error', 'С этого устройства уже зарегистрирован другой ученик.');
                return;
            }

            let student = DB.students.find(s => s.username === username);
            if (!student) {
                // Регистрация нового ученика (бонус 10 киберонов при первом входе)
                student = {
                    id: uuidv4(),
                    username: username,
                    password: password,
                    ip: clientIP,
                    createdAt: new Date().toISOString()
                };
                DB.students.push(student);
                DB.cyberons[student.id] = 10; // бонус
                saveDB();
            } else {
                if (student.password !== password) {
                    socket.emit('login_error', 'Неверный пароль');
                    return;
                }
                // Обновляем IP при входе (если сменил устройство - не даём, если уже привязан к IP)
                if (student.ip !== clientIP) {
                    socket.emit('login_error', 'Этот аккаунт привязан к другому устройству.');
                    return;
                }
            }
            onlineUsers[socket.id] = { ...student, role: 'student' };
            socket.emit('login_success', { user: student, role: 'student' });
        }
    });

    // === ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (для админа) ===
    socket.on('get_users', () => {
        const user = onlineUsers[socket.id];
        if (!user || user.role !== 'admin') return;
        socket.emit('users_list', {
            teachers: DB.teachers,
            students: DB.students
        });
    });

    // === ДОБАВИТЬ УЧИТЕЛЯ (админ) с ограничением 20 ===
    socket.on('add_teacher', (teacherData) => {
        const user = onlineUsers[socket.id];
        if (!user || user.role !== 'admin') return;
        if (DB.teachers.length >= 20) {
            socket.emit('error_msg', 'Достигнут лимит учителей (20)');
            return;
        }
        const newTeacher = {
            id: uuidv4(),
            username: teacherData.username,
            password: 'учитель007', // пароль по умолчанию
            name: teacherData.name,
            subject: teacherData.subject
        };
        DB.teachers.push(newTeacher);
        saveDB();
        io.emit('teacher_added', newTeacher); // всем админам
    });

    // === СМЕНИТЬ ПАРОЛЬ / ИМЯ (для всех) ===
    socket.on('update_profile', (data) => {
        const currentUser = onlineUsers[socket.id];
        if (!currentUser) return;
        if (currentUser.role === 'admin') {
            if (data.name) DB.admin.name = data.name;
            if (data.password) DB.admin.password = data.password;
            saveDB();
            socket.emit('profile_updated', DB.admin);
        } else if (currentUser.role === 'teacher') {
            const teacher = DB.teachers.find(t => t.id === currentUser.id);
            if (data.password) teacher.password = data.password;
            if (data.name) teacher.name = data.name;
            saveDB();
            socket.emit('profile_updated', teacher);
        } // ученики тоже могут менять пароль
    });

    // === ОТПРАВКА СООБЩЕНИЙ (в личку и групповые) ===
    socket.on('send_message', (msg) => {
        const sender = onlineUsers[socket.id];
        if (!sender) return;
        const message = {
            id: uuidv4(),
            from: sender.id,
            fromName: sender.name || sender.username,
            to: msg.to, // userId или groupId
            text: msg.text,
            timestamp: Date.now()
        };
        DB.messages.push(message);
        saveDB();
        // Отправляем получателю, если он онлайн
        for (let [sid, user] of Object.entries(onlineUsers)) {
            if (user.id === msg.to || (msg.groupId && user.groupId === msg.groupId)) {
                io.to(sid).emit('new_message', message);
            }
        }
    });

    socket.on('disconnect', () => {
        delete onlineUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`CyberOne сервер запущен на порту ${PORT}`);
});
