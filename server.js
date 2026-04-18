const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

// ─── Configuração do Banco de Dados (SQLite) ──────────────────────────────────
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('[DB] Erro ao abrir o banco:', err.message);
  else console.log('[DB] Conectado ao banco de dados SQLite.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY,
    name TEXT UNIQUE COLLATE NOCASE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT,
    date TEXT,
    game_mode TEXT,
    score INTEGER,
    duration INTEGER,
    timestamp INTEGER
  )`);
});

// ─── Configuração do Servidor ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Banco de Perguntas ───────────────────────────────────────────────────────
function loadQuestions() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'questions.txt'), 'utf-8');
    const blocks = raw.split('---').map(b => b.trim()).filter(b => b.length > 0);
    return blocks.map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const theme = lines[0].replace(/^#\s*/, '').trim();
      const question = lines[1];
      const options = [lines[2], lines[3], lines[4], lines[5]];
      const correct = lines[6].toUpperCase(); // A, B, C ou D
      return { theme, question, options, correct };
    });
  } catch (err) {
    console.error('[ERRO] Arquivo questions.txt não encontrado ou inválido.');
    return [];
  }
}

let ALL_QUESTIONS = loadQuestions();

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Estado Global do Modo PvP ────────────────────────────────────────────────
let pvpState = {
  phase: 'lobby',      // lobby | countdown | game | gameover
  players: {},         // { token: { name, ws, score, qIndex, currentQ, connected } }
  roundTime: 60,
  shuffledQuestions: [],
  timer: null,
  timeLeft: 0,
  countdownTimer: null,
};

let hostClient = null;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const HOST_IP = getLocalIP();
const PLAYER_URL = `http://${HOST_IP}:${PORT}/player.html`;

// ─── Utilitários PvP ──────────────────────────────────────────────────────────
function broadcastPvPHostOnly() {
  if (hostClient && hostClient.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'pvp_state',
      phase: pvpState.phase,
      players: Object.entries(pvpState.players).map(([token, p]) => ({
        token, name: p.name, score: p.score, connected: p.connected
      })),
      roundTime: pvpState.roundTime,
      timeLeft: pvpState.timeLeft
    };
    hostClient.send(JSON.stringify(payload));
  }
}

function sendToHost(data) {
  if (hostClient && hostClient.readyState === WebSocket.OPEN) {
    hostClient.send(JSON.stringify(data));
  }
}

// ─── Lógica PvP ───────────────────────────────────────────────────────────────
function resetPvPGame() {
  if (pvpState.timer) clearInterval(pvpState.timer);
  if (pvpState.countdownTimer) clearInterval(pvpState.countdownTimer);
  pvpState = {
    phase: 'lobby',
    players: {},
    roundTime: pvpState.roundTime || 60,
    shuffledQuestions: [],
    timer: null,
    timeLeft: 0,
    countdownTimer: null,
  };
  broadcastPvPHostOnly();
}

function startPvPCountdown() {
  pvpState.phase = 'countdown';
  let count = 10;
  broadcastPvPHostOnly();

  // Inform players that countdown started
  const countMsg = JSON.stringify({ type: 'pvp_countdown', value: count });
  Object.values(pvpState.players).forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(countMsg);
  });

  pvpState.countdownTimer = setInterval(() => {
    count--;
    const tickMsg = JSON.stringify({ type: 'pvp_countdown', value: count });
    if (hostClient && hostClient.readyState === WebSocket.OPEN) hostClient.send(tickMsg);
    Object.values(pvpState.players).forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(tickMsg);
    });

    if (count <= 0) {
      clearInterval(pvpState.countdownTimer);
      startPvPGame();
    }
  }, 1000);
}

function startPvPGame() {
  pvpState.phase = 'game';
  pvpState.shuffledQuestions = shuffle(ALL_QUESTIONS);
  pvpState.timeLeft = pvpState.roundTime;

  Object.values(pvpState.players).forEach(p => {
    p.qIndex = 0;
    p.score = 0;
  });

  broadcastPvPHostOnly();

  Object.keys(pvpState.players).forEach(token => {
    sendNextPvPQuestion(token);
  });
  
  if (pvpState.timer) clearInterval(pvpState.timer);
  pvpState.timer = setInterval(() => {
    pvpState.timeLeft--;
    
    // Broadcast tick
    if (hostClient && hostClient.readyState === WebSocket.OPEN) {
      hostClient.send(JSON.stringify({ type: 'pvp_tick', timeLeft: pvpState.timeLeft }));
    }
    Object.values(pvpState.players).forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({ type: 'pvp_tick', timeLeft: pvpState.timeLeft }));
      }
    });

    if (pvpState.timeLeft <= 0) {
      clearInterval(pvpState.timer);
      endPvPGame();
    }
  }, 1000);
}

function prepareQuestion(q) {
  const originalIndex = ['A','B','C','D'].indexOf(q.correct);
  const correctText = q.options[originalIndex];
  
  const options = [...q.options];
  const shuffledOptions = shuffle(options);
  const correctLetter = ['A','B','C','D'][shuffledOptions.indexOf(correctText)];
  
  return {
    theme: q.theme,
    text: q.question,
    options: shuffledOptions,
    correct: correctLetter
  };
}

function sendNextPvPQuestion(token) {
  const p = pvpState.players[token];
  if (!p) return;

  if (p.qIndex >= pvpState.shuffledQuestions.length) {
    // Ficaram sem perguntas antes do tempo acabar
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ type: 'pvp_waiting', message: 'Aguarde o fim do tempo...' }));
    }
    return;
  }

  p.currentQ = prepareQuestion(pvpState.shuffledQuestions[p.qIndex]);
  
  if (p.ws && p.ws.readyState === WebSocket.OPEN) {
    p.ws.send(JSON.stringify({
      type: 'pvp_question',
      question: {
        theme: p.currentQ.theme,
        text: p.currentQ.text,
        options: p.currentQ.options
      },
      score: p.score,
      qIndex: p.qIndex + 1,
      totalQuestions: pvpState.shuffledQuestions.length
    }));
  }
}

function endPvPGame() {
  pvpState.phase = 'gameover';
  broadcastPvPHostOnly();
  
  // Inform players game over and send final players list so they can calculate win/lose
  const playersData = Object.entries(pvpState.players).map(([t, p]) => ({
    token: t, name: p.name, score: p.score
  }));
  const goMsg = JSON.stringify({ type: 'pvp_gameover', players: playersData });

  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();

  Object.entries(pvpState.players).forEach(([token, p]) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(goMsg);
    }
    // Registrar pontuação no BD para cada jogador (Ranking global atualiza via PvP também)
    db.run(
      `INSERT INTO matches (token, date, game_mode, score, duration, timestamp) VALUES (?, ?, 'pvp', ?, ?, ?)`,
      [token, today, p.score, pvpState.roundTime, timestamp]
    );
  });
}

// ─── Estado do Modo Geral (Ranking) ───────────────────────────────────────────
let rankingSessions = {}; 

function startRankingSession(ws, token) {
  const totalTime = 60; // 60s fixo
  const questions = shuffle(ALL_QUESTIONS);
  
  const session = {
    token, ws, score: 0, startTime: Date.now(), 
    questions, qIndex: 0, currentQ: questions[0], 
    timeLeft: totalTime, timer: null
  };
  
  rankingSessions[token] = session;
  
  session.timer = setInterval(() => {
    session.timeLeft--;
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'ranking_tick', timeLeft: session.timeLeft }));
    }
    
    if (session.timeLeft <= 0) {
      clearInterval(session.timer);
      endRankingSession(token);
    }
  }, 1000);

  sendNextRankingQuestion(token);
}

function sendNextRankingQuestion(token) {
  const session = rankingSessions[token];
  if (!session) return;

  if (session.qIndex >= session.questions.length) {
    clearInterval(session.timer);
    endRankingSession(token);
    return;
  }

  session.currentQ = prepareQuestion(session.questions[session.qIndex]);
  
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'ranking_question',
      question: {
        theme: session.currentQ.theme,
        text: session.currentQ.text,
        options: session.currentQ.options
      },
      score: session.score,
      qIndex: session.qIndex + 1
    }));
  }
}

function endRankingSession(token) {
  const session = rankingSessions[token];
  if (!session) return;

  const duration = Math.floor((Date.now() - session.startTime) / 1000);
  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();

  db.run(
    `INSERT INTO matches (token, date, game_mode, score, duration, timestamp) VALUES (?, ?, 'ranking', ?, ?, ?)`,
    [token, today, session.score, duration, timestamp],
    (err) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'ranking_gameover', score: session.score }));
        sendTopRanking(session.ws);
      }
      delete rankingSessions[token];
    }
  );
}

function sendTopRanking(ws) {
  const query = `
    SELECT users.name, MAX(matches.score) as max_score, MIN(matches.duration) as min_duration 
    FROM matches 
    JOIN users ON matches.token = users.token 
    GROUP BY matches.token 
    ORDER BY max_score DESC, min_duration ASC 
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ranking_top10', ranking: rows }));
    }
  });
}

// ─── WebSocket Router ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log(`[WS] Novo cliente conectado`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // HOST ACTIONS
    if (msg.type === 'host_register') {
      hostClient = ws;
      ws._role = 'host';
      resetPvPGame(); // Limpa a sala completamente (Regras 3 e 4)
      const targetUrl = msg.url || PLAYER_URL;
      QRCode.toDataURL(targetUrl, { width: 256, margin: 1 }, (err, url) => {
        sendToHost({ type: 'host_init', qrcode: err ? null : url, playerUrl: targetUrl });
      });
      return;
    }

    if (msg.type === 'set_time' && ws._role === 'host') {
      pvpState.roundTime = msg.time;
      broadcastPvPHostOnly();
      return;
    }

    if (msg.type === 'host_start' && ws._role === 'host') {
      if (Object.keys(pvpState.players).length === 2 && pvpState.phase === 'lobby') {
        startPvPCountdown();
      }
      return;
    }

    if (msg.type === 'host_reset' && ws._role === 'host') {
      resetPvPGame();
      return;
    }

    // REGISTRO DE USUÁRIO COMUM (Token, Names)
    if (msg.type === 'auth') {
      const name = (msg.name || '').trim().substring(0, 12);
      let token = msg.token;
      
      if (!name || name.length < 3) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Nome deve ter entre 3 e 12 caracteres.' }));
        return;
      }

      if (!token) token = uuidv4();

      db.get(`SELECT token, name FROM users WHERE token = ?`, [token], (err, row) => {
        if (row) {
          db.run(`UPDATE users SET name = ? WHERE token = ?`, [name, token]);
          ws.send(JSON.stringify({ type: 'auth_success', token, name }));
        } else {
          db.get(`SELECT token FROM users WHERE name = ? COLLATE NOCASE`, [name], (err, row2) => {
            if (row2) {
              ws.send(JSON.stringify({ type: 'auth_error', message: 'Este nome já está em uso.' }));
            } else {
              db.run(`INSERT INTO users (token, name) VALUES (?, ?)`, [token, name], (err) => {
                ws.send(JSON.stringify({ type: 'auth_success', token, name }));
              });
            }
          });
        }
      });
      return;
    }

    // PVP PLAYER ACTIONS
    if (msg.type === 'pvp_join') {
      const { token, name } = msg;
      ws._role = 'pvp_player';
      ws._token = token;

      // Se a fase for gameover, rejeita a reconexão para forçar a irem pro lobby ou voltarem à página inicial.
      if (pvpState.phase === 'gameover') {
        ws.send(JSON.stringify({ type: 'error', message: 'A partida acabou. Aguarde o Host criar uma nova.' }));
        return;
      }

      // Logica de Reconexão (Regra 5)
      if (pvpState.players[token]) {
        pvpState.players[token].ws = ws;
        pvpState.players[token].connected = true;
        ws.send(JSON.stringify({ type: 'pvp_accepted', name, reconnected: true, phase: pvpState.phase }));
        broadcastPvPHostOnly();
        
        // Se conectou no meio do jogo, manda a pergunta atual de novo
        if (pvpState.phase === 'game') {
          const p = pvpState.players[token];
          if (p.currentQ) {
            ws.send(JSON.stringify({
              type: 'pvp_question',
              question: { theme: p.currentQ.theme, text: p.currentQ.question, options: p.currentQ.options },
              score: p.score, qIndex: p.qIndex + 1, totalQuestions: pvpState.shuffledQuestions.length
            }));
          }
        }
        return;
      }

      if (Object.keys(pvpState.players).length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala cheia! Máximo de 2 jogadores.' }));
        return;
      }
      if (pvpState.phase !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: 'Partida já iniciada!' }));
        return;
      }

      pvpState.players[token] = {
        name,
        ws,
        score: 0,
        qIndex: 0,
        currentQ: null,
        connected: true
      };
      
      ws.send(JSON.stringify({ type: 'pvp_accepted', name, reconnected: false, phase: 'lobby' }));
      broadcastPvPHostOnly();

      if (Object.keys(pvpState.players).length === 2) {
        sendToHost({ type: 'players_ready' });
      }
      return;
    }

    if (msg.type === 'pvp_answer' && ws._role === 'pvp_player') {
      const token = ws._token;
      const player = pvpState.players[token];
      if (!player || pvpState.phase !== 'game' || !player.currentQ) return;

      const answer = msg.answer;
      const correct = player.currentQ.correct;
      const isCorrect = answer === correct;

      if (isCorrect) player.score += 1; // 1 ponto por acerto

      ws.send(JSON.stringify({ type: 'pvp_answer_result', correct: isCorrect, score: player.score }));
      broadcastPvPHostOnly(); // Atualiza o placar do Host
      
      if (hostClient && hostClient.readyState === WebSocket.OPEN) {
        hostClient.send(JSON.stringify({ type: 'pvp_action', name: player.name, correct: isCorrect }));
      }

      // Próxima pergunta após 1.5s
      setTimeout(() => {
        if (pvpState.phase === 'game') {
          player.qIndex++;
          sendNextPvPQuestion(token);
        }
      }, 1500);

      return;
    }

    // RANKING PLAYER ACTIONS
    if (msg.type === 'ranking_start') {
      const token = msg.token;
      ws._role = 'ranking_player';
      ws._token = token;
      
      const today = new Date().toISOString().split('T')[0];
      
      db.get(`SELECT COUNT(*) as count FROM matches WHERE token = ? AND date = ? AND game_mode = 'ranking'`, [token, today], (err, row) => {
        if (row && row.count >= 3) {
          ws.send(JSON.stringify({ type: 'error', message: 'Você atingiu o limite de 3 partidas de Ranking por dia.' }));
        } else {
          startRankingSession(ws, token);
        }
      });
      return;
    }

    if (msg.type === 'ranking_answer' && ws._role === 'ranking_player') {
      const token = ws._token;
      const session = rankingSessions[token];
      if (!session) return;

      const isCorrect = msg.answer === session.currentQ.correct;
      if (isCorrect) session.score += 1;

      ws.send(JSON.stringify({ type: 'ranking_answer_result', correct: isCorrect }));
      
      setTimeout(() => {
        session.qIndex++;
        sendNextRankingQuestion(token);
      }, 1500);
      return;
    }

    if (msg.type === 'ranking_get_top') {
      sendTopRanking(ws);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._role === 'host') {
      hostClient = null;
    } else if (ws._role === 'pvp_player') {
      const token = ws._token;
      if (pvpState.players[token]) {
        pvpState.players[token].connected = false;
        broadcastPvPHostOnly();
      }
    } else if (ws._role === 'ranking_player') {
      const token = ws._token;
      if (rankingSessions[token]) {
        clearInterval(rankingSessions[token].timer);
        endRankingSession(token);
      }
    }
  });
});

app.get('/api/ranking', (req, res) => {
  const query = `
    SELECT users.name, MAX(matches.score) as max_score, MIN(matches.duration) as min_duration 
    FROM matches 
    JOIN users ON matches.token = users.token 
    WHERE matches.game_mode = 'ranking' OR matches.game_mode = 'pvp'
    GROUP BY matches.token 
    ORDER BY max_score DESC, min_duration ASC 
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 Adivinha rodando em:`);
  console.log(`   Host/PC:  http://localhost:${PORT}`);
  console.log(`   Mobile:   http://${HOST_IP}:${PORT}/player.html`);
});
