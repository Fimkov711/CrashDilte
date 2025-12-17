const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Хранилище данных (в реальном приложении используйте базу данных)
let users = {};
let activeGames = {};
let gameHistory = [];
let onlineUsers = new Map(); // socketId -> user data
let gameState = {
  isRunning: false,
  multiplier: 1.0,
  crashPoint: null,
  startTime: null,
  players: [],
  history: []
};

// Генерация ID игры
function generateGameId() {
  return crypto.randomBytes(8).toString('hex');
}

// Генерация точки краша (алгоритм игры Crash)
function generateCrashPoint() {
  // Стандартный алгоритм игры Crash
  const e = 2**32;
  const h = crypto.randomBytes(4).readUInt32LE(0);
  const crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.01, Math.min(crashPoint, 100)); // Ограничение от 1.01x до 100x
}

// Запуск новой игры
function startNewGame() {
  if (gameState.isRunning) return;
  
  const gameId = generateGameId();
  const crashPoint = generateCrashPoint();
  
  gameState = {
    id: gameId,
    isRunning: true,
    multiplier: 1.0,
    crashPoint: crashPoint,
    startTime: Date.now(),
    players: [],
    history: [],
    winner: null
  };
  
  activeGames[gameId] = gameState;
  
  console.log(`Новая игра ${gameId} запущена. Точка краша: ${crashPoint}x`);
  
  // Оповещаем всех о начале игры
  io.emit('game_start', {
    gameId,
    crashPoint,
    startTime: gameState.startTime
  });
  
  // Запускаем таймер игры
  const gameInterval = setInterval(() => {
    if (!gameState.isRunning) {
      clearInterval(gameInterval);
      return;
    }
    
    // Увеличиваем множитель
    const timeElapsed = (Date.now() - gameState.startTime) / 1000;
    gameState.multiplier = 1.0 + (timeElapsed * 0.05);
    
    // Проверяем, не достигли ли точки краша
    if (gameState.multiplier >= gameState.crashPoint) {
      endGame(gameId);
      clearInterval(gameInterval);
    } else {
      // Отправляем обновление множителя
      io.emit('game_update', {
        gameId,
        multiplier: gameState.multiplier.toFixed(2),
        timeElapsed: timeElapsed.toFixed(1)
      });
    }
  }, 100);
  
  // Автоматическое завершение через 30 секунд (максимум)
  setTimeout(() => {
    if (gameState.isRunning) {
      endGame(gameId);
    }
  }, 30000);
}

// Завершение игры
function endGame(gameId) {
  const game = activeGames[gameId];
  if (!game || !game.isRunning) return;
  
  game.isRunning = false;
  game.endTime = Date.now();
  
  // Определяем победителей
  game.players.forEach(player => {
    if (player.cashedOut && player.cashOutMultiplier < game.multiplier) {
      player.won = true;
      player.profit = player.bet * player.cashOutMultiplier;
    } else if (!player.cashedOut) {
      player.won = false;
      player.profit = -player.bet;
    }
  });
  
  // Сохраняем в историю
  gameHistory.push({
    ...game,
    players: game.players.length
  });
  
  // Ограничиваем историю 100 играми
  if (gameHistory.length > 100) {
    gameHistory = gameHistory.slice(-100);
  }
  
  console.log(`Игра ${gameId} завершена. Множитель: ${game.multiplier.toFixed(2)}x`);
  
  // Оповещаем всех о завершении
  io.emit('game_end', {
    gameId,
    finalMultiplier: game.multiplier.toFixed(2),
    crashPoint: game.crashPoint,
    players: game.players,
    winners: game.players.filter(p => p.won).length
  });
  
  // Запускаем новую игру через 5 секунд
  setTimeout(() => {
    startNewGame();
  }, 5000);
}

// API endpoints
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
  }
  
  if (users[username]) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }
  
  // В реальном приложении хешируйте пароль!
  users[username] = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    password, // В реальном приложении: bcrypt.hashSync(password, 10)
    balance: 1000, // Начальный баланс
    gamesPlayed: 0,
    gamesWon: 0,
    totalProfit: 0,
    createdAt: Date.now()
  };
  
  res.json({
    success: true,
    user: {
      id: users[username].id,
      username,
      balance: users[username].balance
    }
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = users[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Неверные данные для входа' });
  }
  
  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      balance: user.balance,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      totalProfit: user.totalProfit
    }
  });
});

app.post('/api/place-bet', (req, res) => {
  const { username, gameId, amount, autoCashout } = req.body;
  
  const user = users[username];
  const game = activeGames[gameId];
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  if (!game || !game.isRunning) {
    return res.status(400).json({ error: 'Игра не активна' });
  }
  
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }
  
  if (amount < 10) {
    return res.status(400).json({ error: 'Минимальная ставка 10' });
  }
  
  // Списываем средства
  user.balance -= amount;
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  
  // Добавляем игрока в игру
  const player = {
    id: user.id,
    username: user.username,
    bet: amount,
    cashOutMultiplier: autoCashout || null,
    cashedOut: false,
    won: false,
    profit: 0,
    joinedAt: Date.now()
  };
  
  game.players.push(player);
  
  // Оповещаем всех о новой ставке
  io.emit('new_bet', {
    gameId,
    player: {
      username: user.username,
      amount,
      autoCashout
    }
  });
  
  res.json({
    success: true,
    balance: user.balance,
    betId: crypto.randomBytes(4).toString('hex')
  });
});

app.post('/api/cash-out', (req, res) => {
  const { username, gameId } = req.body;
  
  const user = users[username];
  const game = activeGames[gameId];
  
  if (!user || !game || !game.isRunning) {
    return res.status(400).json({ error: 'Невозможно выполнить операцию' });
  }
  
  // Находим игрока в игре
  const player = game.players.find(p => p.username === username && !p.cashedOut);
  
  if (!player) {
    return res.status(400).json({ error: 'Ставка не найдена' });
  }
  
  // Выплачиваем выигрыш
  const winAmount = player.bet * game.multiplier;
  user.balance += winAmount;
  user.totalProfit = (user.totalProfit || 0) + (winAmount - player.bet);
  
  if (winAmount > player.bet) {
    user.gamesWon = (user.gamesWon || 0) + 1;
  }
  
  // Обновляем статус игрока
  player.cashedOut = true;
  player.cashOutMultiplier = game.multiplier;
  player.won = true;
  player.profit = winAmount - player.bet;
  
  // Оповещаем всех о выводе
  io.emit('cash_out', {
    gameId,
    player: {
      username,
      multiplier: game.multiplier.toFixed(2),
      amount: winAmount
    }
  });
  
  res.json({
    success: true,
    multiplier: game.multiplier.toFixed(2),
    amount: winAmount,
    balance: user.balance
  });
});

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  const user = users[username];
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  // Не возвращаем пароль
  const { password, ...userData } = user;
  res.json(userData);
});

app.get('/api/game-history', (req, res) => {
  res.json(gameHistory.slice(-20).reverse());
});

app.get('/api/online-users', (req, res) => {
  const online = Array.from(onlineUsers.values()).map(user => ({
    username: user.username,
    balance: user.balance,
    joinedAt: user.joinedAt
  }));
  
  res.json(online);
});

// Socket.io соединения
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  
  // Присоединение пользователя
  socket.on('user_join', (userData) => {
    onlineUsers.set(socket.id, {
      ...userData,
      socketId: socket.id,
      joinedAt: Date.now()
    });
    
    // Отправляем текущее состояние игры
    const currentGame = Object.values(activeGames).find(game => game.isRunning);
    if (currentGame) {
      socket.emit('game_state', currentGame);
    }
    
    // Оповещаем всех о новом онлайн пользователе
    io.emit('online_update', {
      count: onlineUsers.size,
      users: Array.from(onlineUsers.values()).map(u => u.username)
    });
  });
  
  // Отсоединение пользователя
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online_update', {
      count: onlineUsers.size,
      users: Array.from(onlineUsers.values()).map(u => u.username)
    });
    console.log('Пользователь отключился:', socket.id);
  });
});

// Запускаем первую игру
setTimeout(() => {
  startNewGame();
}, 1000);

// Старт сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Откройте http://localhost:${PORT} в браузере`);
});